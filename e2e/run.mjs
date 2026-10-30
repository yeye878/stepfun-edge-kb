// e2e/run.mjs — 单进程 e2e：起后端 → 起/attach Chrome → 打开应用 → 等初始化 → 导入语料 → 混合检索 → 截图 → 清理
//
// 用法（在 tasks/t27_stepfun_edge/src 下）：
//   node e2e/run.mjs --env webgpu                       # 尝试自启 Chrome（沙箱内会失败，见 README）
//   node e2e/run.mjs --env webgpu --cdp-url http://127.0.0.1:19222   # attach 沙箱外起的 Chrome（推荐）
//   node e2e/run.mjs --env wasm  --cdp-url http://127.0.0.1:19223
//   node e2e/run.mjs --env webgpu --cdp-url http://127.0.0.1:19222 --no-backend --backend-url http://127.0.0.1:18270
//
// 退出码：0=全部核心断言通过；1=用例失败（页面/接口/断言）；3=浏览器不可用（环境限制，不是功能失败）；21=后端不可用
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, waitForHealth, stopBackend } from './lib/backend.mjs';
import { launchChrome, attachChrome, killChrome } from './lib/chrome.mjs';
import { openPage } from './lib/page.mjs';
import { ENV_PROBE_EXPR, HOOK_PROBE_EXPR, BADGE_PROBE_EXPR, HIDE_WEBGPU_PRELOAD } from './lib/inpage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '..');
const TASK_ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE_DIR = path.join(TASK_ROOT, 'submission', 'evidence');

// WebGPU 不可用环境的构造说明（HIDE_WEBGPU_PRELOAD）见 lib/inpage.mjs：
// Chrome 156 的 --disable-features=WebGPU 已被忽略，故用 CDP 注入隐藏 navigator.gpu；
// summary.webgpuSimulated=true 会在 summary/日志里如实标记（不伪造“真实不支持”）。
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);

function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function parseArgs(argv) {
  const out = { _: [] };
  const flags = new Set(['no-backend', 'headed', 'keep-open', 'skip-import', 'skip-search', 'attach-only', 'no-simulate', 'allow-mock', 'keep-db']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (flags.has(key)) { out[camel(key)] = true; continue; }
    const v = argv[++i];
    if (v === undefined) { out[camel(key)] = true; continue; }
    out[camel(key)] = v;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const envName = String(args.env || 'webgpu').toLowerCase();
if (!['webgpu', 'wasm'].includes(envName)) { console.error('--env 只能是 webgpu 或 wasm'); process.exit(2); }
// 默认 18278：避开 dev 用的 18270/18271（web-ui 可能起 MOCK/Vite），任务端口段 18270-18279
const backendPort = Number(args.port || 18278);
const debugPort = Number(args.debugPort || 19222);
const outRoot = args.out ? path.resolve(args.out) : path.join(__dirname, 'out');
const runDir = path.join(outRoot, 'run-' + stamp + '-' + envName);
const logFile = path.join(runDir, 'e2e.log');
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const summary = {
  tool: 'e2e/run.mjs',
  env: envName,
  startedAt: startedAt.toISOString(),
  node: process.version,
  platform: process.platform + ' ' + process.arch,
  args,
  checks: [],
  evidence: {},
  error: null,
};

function log(...parts) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n', 'utf8'); } catch { /* ignore */ }
}
function check(name, ok, detail) {
  summary.checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
  return !!ok;
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function readJsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

const CLEANUP = { page: null, browser: null, backend: null };

function printBrowserGuidance(err) {
  const lines = [
    '',
    '============================================================',
    '⚠ 浏览器无法在 agent 沙箱内启动（环境限制，不是用例失败）',
    '============================================================',
    '原因：本机 agent 沙箱禁止创建命名管道，Chromium 的 Mojo IPC 无法初始化；',
    '      Chrome/Edge 会在 40~130ms 内自杀（crashpad OpenProcess 拒绝访问 + mojo platform_channel FATAL）。',
    '      Playwright(channel:chrome) 与 --remote-debugging-pipe 同样不可用。',
    '具体错误：' + (err && err.message ? err.message.slice(0, 400) : err),
    '',
    '解决方式（二选一，之后用 --cdp-url attach）：',
    '  1) 在「非沙箱」的普通 PowerShell/终端里运行：',
    '     pwsh -File e2e/launch-chrome.ps1 -Env ' + envName,
    '     （脚本会打印 READY 与 CDP 地址）',
    '  2) 或者手动起（WebGPU 环境）：',
    '     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=19222 --user-data-dir="' + path.join(runDir, 'chrome-profile-cdp') + '" --no-first-run --no-default-browser-check --window-size=1440,900',
    '     然后：node e2e/run.mjs --env ' + envName + ' --cdp-url http://127.0.0.1:19222',
    '============================================================',
  ];
  log(lines.join('\n'));
}

async function startBackendPhase() {
  if (args.noBackend) {
    const baseUrl = args.backendUrl || ('http://127.0.0.1:' + backendPort);
    summary.backend = { mode: 'external', baseUrl };
    try {
      const r = await fetch(baseUrl + '/api/health');
      const body = await r.json().catch(() => null);
      summary.backend.health = body;
      summary.backend.ok = r.ok;
      const isMock = !!body && /mock/i.test(String(body.dbMode || '') + ' ' + String(body.dbVersion || ''));
      summary.backend.isMock = isMock;
      check('后端可用（外部 ' + baseUrl + '）', r.ok, { status: r.status, health: body });
      check('外部后端不是 MOCK（除非 --allow-mock）', !isMock || !!args.allowMock, { isMock, dbMode: body && body.dbMode });
      if (isMock && !args.allowMock) {
        log('⚠ 外部后端是 MOCK 联调后端；仅当 --allow-mock 时允许（结果不能作为 seekdb 证据）。');
        process.exitCode = 21;
      }
      return baseUrl;
    } catch (e) {
      summary.backend.ok = false;
      summary.backend.error = String(e && e.message || e);
      check('后端可用（外部 ' + baseUrl + '）', false, summary.backend.error);
      process.exitCode = 21;
      throw e;
    }
  }
  try {
    // e2e 用独立 seekdb 目录，避免与 Lead/dev 实例抢同一目录的单实例锁；原生插件缓存复用已下载的 bindings
    const backendEnv = {
      SEEKDB_BINDINGS_CACHE_DIR: process.env.SEEKDB_BINDINGS_CACHE_DIR || 'D:\\oceanbase\\_scratch\\t27\\bindings',
      SEEKDB_PATH: process.env.SEEKDB_PATH || path.join(outRoot, '_runtime', 'seekdb'),
    };
    if (args.dbPath) backendEnv.SEEKDB_PATH = path.resolve(String(args.dbPath));
    // 默认每次跑干净的 DB（保证导入结果可复现）；--keep-db 可复用
    if (!args.keepDb) {
      try { fs.rmSync(backendEnv.SEEKDB_PATH, { recursive: true, force: true }); }
      catch (e) { log('⚠ 清空 e2e DB 失败（可能有进程占用）: ' + e.message); }
    }
    const handle = startBackend({ cwd: SRC_ROOT, port: backendPort, logDir: runDir, env: backendEnv });
    CLEANUP.backend = handle;
    summary.backend = { mode: 'spawned', baseUrl: handle.baseUrl, pid: handle.child.pid, logDir: runDir, env: { SEEKDB_PATH: backendEnv.SEEKDB_PATH, SEEKDB_BINDINGS_CACHE_DIR: backendEnv.SEEKDB_BINDINGS_CACHE_DIR } };
    const health = await waitForHealth(handle, { timeoutMs: Number(args.backendTimeoutMs || 180000) });
    summary.backend.health = health;
    summary.backend.ok = true;
    check('后端启动 + /api/health', true, health);
    const isMock = /mock/i.test(String(health.dbMode || '') + ' ' + String(health.dbVersion || ''));
    check('后端是真实 seekdb（非 MOCK 联调后端）', !isMock, { dbMode: health.dbMode, dbVersion: health.dbVersion });
    if (isMock) { log('⚠ 端口 ' + backendPort + ' 上跑的是 MOCK 后端（web/dev/mock-server.mjs），e2e 需要真实 seekdb。请换 --port。'); }
    return handle.baseUrl;
  } catch (e) {
    summary.backend = { mode: 'spawned', ok: false, error: String(e && e.message || e) };
    check('后端启动 + /api/health', false, String(e && e.message || e).slice(0, 800));
    process.exitCode = 21;
    throw e;
  }
}

async function acquireBrowserPhase() {
  if (args.cdpUrl) {
    const attached = await attachChrome(String(args.cdpUrl));
    summary.browser = { mode: 'attach', endpoint: attached.endpoint, version: attached.version, port: attached.port };
    check('attach 已运行的 Chrome（' + attached.endpoint + '）', true, attached.version);
    return { port: attached.port, handle: null, mode: 'attach' };
  }
  const extraArgs = envName === 'wasm' ? ['--disable-features=WebGPU'] : [];
  try {
    const handle = await launchChrome({
      port: debugPort,
      headless: !args.headed,
      userDataDir: path.join(runDir, 'chrome-profile'),
      extraArgs,
      logDir: runDir,
    });
    summary.browser = { mode: 'spawn', port: debugPort, version: handle.version, args: handle.args };
    check('自启 Chrome（port ' + debugPort + '）', true, handle.version);
    return { port: debugPort, handle, mode: 'spawn' };
  } catch (e) {
    summary.browser = {
      mode: 'spawn',
      ok: false,
      code: e.code || null,
      error: String(e && e.message || e).slice(0, 2000),
      hint: e.hint || null,
      chromeStderr: String(e.chromeStderr || '').slice(0, 2000),
    };
    check('自启 Chrome（port ' + debugPort + '）', false, (e.code || '') + ' ' + String(e.message).slice(0, 500));
    process.exitCode = 3;
    printBrowserGuidance(e);
    throw e;
  }
}

async function waitForAppReady(page, hook) {
  const hookReady = hook && hook.hasHook && hook.hasReady;
  if (hookReady) {
    log('等待 window.__stepkb.ready() ...');
    const t0 = Date.now();
    await page.evaluate('(async () => { await window.__stepkb.ready(); return true; })()', { timeoutMs: Number(args.readyTimeoutMs || 600000) });
    summary.ready = { via: 'window.__stepkb.ready()', ms: Date.now() - t0 };
    check('window.__stepkb.ready() 完成', true, summary.ready.ms + 'ms');
    return true;
  }
  log('未发现 window.__stepkb.ready()（钩子缺失），降级等待界面状态栏…');
  summary.ready = { via: 'dom-fallback' };
  try {
    await page.waitFor("document.querySelector('[data-testid=backend-badge], .backend-badge, [data-testid=status-bar], header') !== null", { timeoutMs: 60000, label: '界面状态栏出现' });
    summary.ready.domBadgeFound = true;
    check('界面状态栏出现（钩子缺失，DOM 降级）', true);
    return true;
  } catch (e) {
    check('界面状态栏出现（钩子缺失，DOM 降级）', false, String(e && e.message || e).slice(0, 500));
    return false;
  }
}

async function importCorpus(page, hook) {
  if (args.skipImport) { log('跳过导入（--skip-import）'); summary.import = { skipped: true }; return null; }
  const corpusPath = path.join(SRC_ROOT, 'web', 'public', 'data', 'corpus.json');
  const corpus = readJsonSafe(corpusPath);
  if (!Array.isArray(corpus) || corpus.length === 0) {
    summary.import = { skipped: true, reason: 'web/public/data/corpus.json 不存在或为空（eval-data 尚未就绪），路径: ' + corpusPath };
    check('导入语料', false, summary.import.reason);
    return null;
  }
  const limit = Number(args.importLimit || corpus.length);
  const docs = corpus.slice(0, limit).map((d) => ({
    id: String(d.id),
    text: [d.title, d.text || d.content || ''].filter(Boolean).join('\n'),
    category: d.category || null,
  }));
  let result = null;
  if (hook && hook.hasHook && hook.hasImportTexts) {
    log('通过 window.__stepkb.importTexts 导入 ' + docs.length + ' 篇…');
    result = await page.evaluate('window.__stepkb.importTexts(' + JSON.stringify(docs) + ', {})', { timeoutMs: Number(args.importTimeoutMs || 600000) });
    summary.import = { via: 'window.__stepkb.importTexts', docs: docs.length, result };
    check('导入语料（__stepkb.importTexts）', true, result);
  } else {
    log('钩子缺失，尝试 DOM 导入（textarea + 按钮）…');
    const domResult = await page.evaluate('(async () => {
' +
      '  const ta = document.querySelector("[data-testid=import-textarea], textarea");
' +
      '  if (!ta) return { ok: false, reason: "页面无 textarea" };
' +
      '  const text = ' + JSON.stringify(docs.map((d) => d.text).join('\n\n')) + ';
' +
      '  ta.value = text; ta.dispatchEvent(new Event("input", { bubbles: true }));
' +
      '  const btn = document.querySelector("[data-testid=import-button]") || Array.from(document.querySelectorAll("button")).find((b) => /导入|向量化|写入/.test(b.innerText || ""));
' +
      '  if (!btn) return { ok: false, reason: "页面无导入按钮" };
' +
      '  btn.click();
' +
      '  return { ok: true, clicked: (btn.innerText || "").trim().slice(0, 50) };
' +
      '})()', { timeoutMs: 30000 });
    summary.import = { via: 'dom-click', docs: docs.length, result: domResult };
    check('导入语料（DOM 降级）', !!(domResult && domResult.ok), domResult);
    if (!(domResult && domResult.ok)) return null;
    await new Promise((r) => setTimeout(r, 1500));
    result = domResult;
  }
  return result;
}

/** 从后端 HTTP API 取库信息/DDL/索引/db 信息，作为 summary 证据（不依赖页面渲染）。 */
async function fetchBackendStats(baseUrl) {
  try {
    const dbInfo = await (await fetch(baseUrl + '/api/db/info')).json().catch(() => null);
    const kbs = await (await fetch(baseUrl + '/api/kbs')).json().catch(() => null);
    const first = kbs && Array.isArray(kbs.kbs) && kbs.kbs.length ? kbs.kbs[0] : null;
    let stats = null;
    if (first) stats = await (await fetch(baseUrl + '/api/kbs/' + first.id + '/stats')).json().catch(() => null);
    summary.backendStats = { dbInfo, kbs, kbId: first && first.id, stats };
    if (first) {
      check('KB 维度 = 512（bge-small-zh-v1.5）', Number(first.dim) === 512, { dim: first.dim, model: first.model, docCount: first.docCount });
      summary.dbMode = dbInfo && dbInfo.mode;
      check('后端 dbMode = embedded（真实 seekdb）', !!(dbInfo && dbInfo.mode === 'embedded'), dbInfo && { mode: dbInfo.mode, version: dbInfo.version });
      const st = stats || {};
      const idx = Array.isArray(st.indexes) ? st.indexes.map((i) => i.name || i.Key_name) : [];
      check('FULLTEXT + VECTOR 索引存在', idx.some((n) => /ft_/.test(n)) && idx.some((n) => /vec_/.test(n)), idx);
    }
  } catch (e) {
    summary.backendStats = { error: String(e && e.message || e) };
    check('取后端 DB 证据（/api/db/info + /stats）', false, summary.backendStats.error);
  }
}

async function searchPhase(page, hook) {
  if (args.skipSearch) { log('跳过检索（--skip-search）'); summary.search = { skipped: true }; return null; }
  let query = args.query || null;
  if (!query) {
    const queries = readJsonSafe(path.join(SRC_ROOT, 'web', 'public', 'data', 'queries.json'));
    if (Array.isArray(queries) && queries.length > 0) query = queries[0].query || queries[0].q || null;
  }
  if (!query) query = '数据库';
  const k = Number(args.k || 5);
  let result = null;
  if (hook && hook.hasHook && hook.hasSearch) {
    const retries = Number(args.searchRetries || 6);
    const attempts = [];
    let rows = null;
    for (let i = 1; i <= retries; i++) {
      log('通过 window.__stepkb.search 混合检索（第 ' + i + '/' + retries + ' 次）: ' + query + ' k=' + k);
      result = await page.evaluate('window.__stepkb.search(' + JSON.stringify(query) + ', "hybrid", ' + k + ')', { timeoutMs: Number(args.searchTimeoutMs || 180000) });
      rows = result && Array.isArray(result.rows) ? result.rows : null;
      attempts.push({ attempt: i, rows: rows ? rows.length : null, dbMs: result && result.dbMs });
      if (rows && rows.length > 0) break;
      // seekdb HNSW delta 索引异步构建：首次查询可能为空，稍等重试（评测/界面刷新同理）
      if (i < retries) await new Promise((r) => setTimeout(r, 500));
    }
    summary.search = { via: 'window.__stepkb.search', query, mode: 'hybrid', k, attempts, result };
    check('混合检索返回结果（__stepkb.search）', !!(rows && rows.length > 0), { rows: rows ? rows.length : null, attempts, sql: result && result.sql ? String(result.sql).slice(0, 400) : null, dbMs: result && result.dbMs });
    check('混合检索 SQL 为单条 SQL（MATCH + l2_distance APPROXIMATE）', !!(result && /MATCH\s*\(/i.test(String(result.sql || '')) && /l2_distance/i.test(String(result.sql || '')) && /APPROXIMATE/i.test(String(result.sql || ''))), result && String(result.sql || '').slice(0, 500));
  } else {
    log('钩子缺失，尝试 DOM 检索…');
    const domResult = await page.evaluate('(async () => {
' +
      '  const input = document.querySelector("[data-testid=search-input], input[type=search], input[type=text]");
' +
      '  if (!input) return { ok: false, reason: "页面无搜索输入框" };
' +
      '  input.value = ' + JSON.stringify(query) + '; input.dispatchEvent(new Event("input", { bubbles: true }));
' +
      '  const btn = document.querySelector("[data-testid=search-button]") || Array.from(document.querySelectorAll("button")).find((b) => /检索|搜索|查询/.test(b.innerText || ""));
' +
      '  if (!btn) return { ok: false, reason: "页面无检索按钮" };
' +
      '  btn.click();
' +
      '  return { ok: true };
' +
      '})()', { timeoutMs: 30000 });
    summary.search = { via: 'dom-click', query, result: domResult };
    check('混合检索（DOM 降级）', !!(domResult && domResult.ok), domResult);
    // DOM 降级时再给结果列表一点渲染时间
    await new Promise((r) => setTimeout(r, 2000));
    result = domResult;
  }
  return result;
}

function assertBackendBadge(envProbe, ui) {
  const badge = (ui && ui.badge) || null;
  const bodyText = (ui && ui.bodyText) || '';
  const fallbackBanner = (ui && ui.fallbackBanner) || '';
  const badgeBackend = badge && badge.backend ? String(badge.backend) : null;
  summary.ui = {
    badge,
    statusBar: (ui && ui.statusBar) || null,
    fallbackBanner: fallbackBanner || null,
    dbStatus: (ui && ui.dbStatus) || null,
    kbStatus: (ui && ui.kbStatus) || null,
    importSummary: (ui && ui.importSummary) || null,
    docCount: (ui && ui.docCount) || null,
    searchTimings: (ui && ui.searchTimings) || null,
    resultCount: ui && ui.resultCount,
    gpuUsable: !!(envProbe && envProbe.gpu && envProbe.gpu.usable),
    webgpuSimulated: !!summary.webgpuSimulated,
  };
  if (envName === 'webgpu') {
    check('状态栏徽标后端 = webgpu', badgeBackend === 'webgpu', badge ? { text: badge.text, backend: badge.backend, dtype: badge.dtype } : '未找到 [data-testid=backend-badge]');
    check('徽标文本包含 WebGPU · FP16', !!(badge && /webgpu/i.test(badge.text) && /fp16/i.test(badge.text)), badge && badge.text);
    check('WebGPU 环境探测：adapter+device 可用', !!(envProbe && envProbe.gpu && envProbe.gpu.usable), envProbe && envProbe.gpu ? { info: envProbe.gpu.info || null, fallback: envProbe.gpu.isFallbackAdapter } : null);
    check('未出现降级横幅（WebGPU 环境不应降级）', !fallbackBanner, fallbackBanner ? fallbackBanner.slice(0, 300) : null);
  } else {
    check('状态栏徽标后端 = wasm（降级环境）', badgeBackend === 'wasm', badge ? { text: badge.text, backend: badge.backend, dtype: badge.dtype } : '未找到 [data-testid=backend-badge]');
    check('徽标文本包含 WASM', !!(badge && /wasm/i.test(badge.text)), badge && badge.text);
    check('降级横幅可见（data-testid=fallback-banner）', !!fallbackBanner, fallbackBanner ? fallbackBanner.slice(0, 400) : null);
    check('降级原因含 WebGPU 不可用/降级字样', /webgpu|降级|回退|fallback|不支持/i.test(bodyText), { fallbackBanner: fallbackBanner.slice(0, 400) });
    check('WASM 环境探测：WebGPU 不可用（与预期一致）', !(envProbe && envProbe.gpu && envProbe.gpu.usable), envProbe && envProbe.gpu ? { present: envProbe.gpu.present, adapter: envProbe.gpu.adapter, simulated: !!summary.webgpuSimulated } : null);
  }
  check('数据库状态栏显示 seekdb 已连接', !!(ui && /seekdb/i.test(ui.dbStatus || '')), (ui && ui.dbStatus) || null);
}

async function main() {
  log('===== StepKB e2e run =====');
  log(JSON.stringify({ env: envName, runDir, args }));

  const baseUrl = await startBackendPhase();
  const browser = await acquireBrowserPhase();
  CLEANUP.browser = browser;

  const appUrl = args.appUrl || baseUrl;
  summary.appUrl = appUrl;

  // 1) 先在 about:blank 探测「浏览器真实能力」（不含任何注入）
  const probePage = await openPage({ port: browser.port, url: 'about:blank', loadTimeoutMs: Number(args.loadTimeoutMs || 45000), logDir: runDir });
  let actualEnvProbe = null;
  try { actualEnvProbe = await probePage.evaluate(ENV_PROBE_EXPR); } finally { await probePage.close(); }
  summary.actualEnvProbe = actualEnvProbe;
  log('浏览器真实能力: ' + JSON.stringify({ chrome: actualEnvProbe && actualEnvProbe.chromeVersion, gpuUsable: !!(actualEnvProbe && actualEnvProbe.gpu && actualEnvProbe.gpu.usable), gpuInfo: (actualEnvProbe && actualEnvProbe.gpu && actualEnvProbe.gpu.info) || null }));

  // 2) WASM 降级环境：若浏览器真实支持 WebGPU，则用 CDP 注入隐藏 navigator.gpu（Chrome 156 无有效关闭开关）
  let webgpuSimulated = false;
  if (envName === 'wasm' && actualEnvProbe && actualEnvProbe.gpu && actualEnvProbe.gpu.usable && !args.noSimulate) webgpuSimulated = true;
  if (envName === 'wasm') check('WASM 降级环境构造方式', true, webgpuSimulated ? '模拟：CDP 注入隐藏 navigator.gpu（Chrome 156 的 --disable-features=WebGPU 已失效，如实记录）' : '真实：当前浏览器 WebGPU 不可用');
  if (envName === 'webgpu') check('WebGPU 环境构造方式', !!(actualEnvProbe && actualEnvProbe.gpu && actualEnvProbe.gpu.usable), actualEnvProbe && actualEnvProbe.gpu ? { info: actualEnvProbe.gpu.info || null } : null);

  const page = await openPage({
    port: browser.port,
    url: appUrl,
    loadTimeoutMs: Number(args.loadTimeoutMs || 45000),
    logDir: runDir,
    preloadScripts: webgpuSimulated ? [HIDE_WEBGPU_PRELOAD] : [],
  });
  CLEANUP.page = page;
  summary.page = { url: page.url, webgpuSimulated };
  summary.webgpuSimulated = webgpuSimulated;
  check('打开应用页面 ' + appUrl, true);

  const envProbe = await page.evaluate(ENV_PROBE_EXPR);
  summary.envProbe = envProbe;
  log('应用页面环境: ' + JSON.stringify({ chrome: envProbe.chromeVersion, secure: envProbe.isSecureContext, gpuUsable: envProbe.gpu && envProbe.gpu.usable, gpu: envProbe.gpu, webgpuSimulated }));

  // COOP/COEP：后端必须设置，否则 WASM 多线程 / SharedArrayBuffer 不可用
  check('页面 secure context', !!(envProbe && envProbe.isSecureContext), envProbe && envProbe.isSecureContext);
  check('COOP/COEP 生效（crossOriginIsolated=true，WASM 线程前提）', !!(envProbe && envProbe.crossOriginIsolated), { crossOriginIsolated: envProbe && envProbe.crossOriginIsolated, hasSharedArrayBuffer: envProbe && envProbe.hasSharedArrayBuffer });

  const hook = await page.evaluate(HOOK_PROBE_EXPR, { timeoutMs: 60000 });
  summary.hook = hook;
  log('window.__stepkb 钩子: ' + JSON.stringify(hook));
  check('window.__stepkb 钩子存在（e2e 契约）', !!(hook && hook.hasHook), hook);

  await waitForAppReady(page, hook);
  const uiBefore = await page.evaluate(BADGE_PROBE_EXPR);
  summary.uiBefore = uiBefore;

  await importCorpus(page, hook);
  // 显式刷新索引（seekdb HNSW delta 异步构建；应用侧 refresh 会做 FTS/向量可见性探针）
  if (hook && hook.hasHook && hook.hasRefresh) {
    try {
      const t0 = Date.now();
      const refreshed = await page.evaluate('window.__stepkb.refresh()', { timeoutMs: 120000 });
      summary.refresh = { ms: Date.now() - t0, result: refreshed };
      log('显式 refresh: ' + JSON.stringify(refreshed).slice(0, 500));
    } catch (e) {
      summary.refresh = { error: String(e && e.message || e).slice(0, 500) };
      log('⚠ refresh 失败: ' + (e && e.message));
    }
  }
  await searchPhase(page, hook);
  await fetchBackendStats(baseUrl);

  const ui = await page.evaluate(BADGE_PROBE_EXPR);
  assertBackendBadge(envProbe, ui);

  // ---- 截图证据（提交用命名）----
  const mainShot = path.join(EVIDENCE_DIR, '01-e2e-' + envName + '.png');
  await page.screenshot(mainShot);
  summary.evidence.main = 'submission/evidence/01-e2e-' + envName + '.png';
  const badgeShot = path.join(EVIDENCE_DIR, envName === 'webgpu' ? '04-webgpu.png' : '04-wasm-fallback.png');
  await page.screenshot(badgeShot);
  summary.evidence.badge = 'submission/evidence/' + path.basename(badgeShot);
  // 运行目录留一份
  await page.screenshot(path.join(runDir, '01-e2e-' + envName + '.png'));
  log('截图已保存: ' + mainShot + ' / ' + badgeShot);

  // ---- 控制台错误（非致命，记录）----
  summary.consoleErrors = page.consoleErrors.slice(0, 30);
  summary.exceptions = page.exceptions.slice(0, 30);
  check('页面无未捕获异常', page.exceptions.length === 0, page.exceptions.slice(0, 3));
}

(async () => {
  try {
    await main();
    if (!process.exitCode) process.exitCode = summary.checks.every((c) => c.ok) ? 0 : 1;
  } catch (e) {
    summary.error = { message: String(e && e.message || e), code: e && e.code || null, hint: e && e.hint || null };
    log('[ERROR] ' + (summary.error.message));
    if (!process.exitCode) process.exitCode = 1;
  } finally {
    try { if (CLEANUP.page) await CLEANUP.page.close(); } catch { /* ignore */ }
    try { if (CLEANUP.browser && CLEANUP.browser.handle) await killChrome(CLEANUP.browser.handle); } catch { /* ignore */ }
    try { if (CLEANUP.backend) await stopBackend(CLEANUP.backend); } catch { /* ignore */ }
    summary.finishedAt = new Date().toISOString();
    summary.exitCode = process.exitCode || 0;
    summary.passed = summary.checks.filter((c) => c.ok).length;
    summary.failed = summary.checks.filter((c) => !c.ok).length;
    try {
      writeJson(path.join(runDir, 'summary.json'), summary);
      writeJson(path.join(outRoot, 'last-run-' + envName + '.json'), summary);
      if (process.exitCode === 3) writeJson(path.join(EVIDENCE_DIR, '00-browser-unavailable-' + envName + '.json'), summary);
    } catch (e) { console.error('写 summary 失败: ' + e.message); }
    log('===== 结果: exit=' + (process.exitCode || 0) + ' passed=' + summary.passed + ' failed=' + summary.failed + ' =====');
    log('summary: ' + path.join(runDir, 'summary.json'));
  }
})();
