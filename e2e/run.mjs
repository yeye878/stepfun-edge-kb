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
  const flags = new Set(['no-backend', 'headed', 'keep-open', 'skip-import', 'skip-search', 'attach-only', 'no-simulate', 'allow-mock', 'keep-db', 'benchmark']);
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
    // 每次跑独立 DB 目录：seekdb embedded 有单实例锁，复用旧目录容易被上一轮残留进程锁住
    backendEnv.SEEKDB_PATH = args.dbPath
      ? path.resolve(String(args.dbPath))
      : path.join(outRoot, '_runtime', 'seekdb-' + stamp + '-' + envName);
    if (args.dbPath && !args.keepDb) {
      try { fs.rmSync(backendEnv.SEEKDB_PATH, { recursive: true, force: true }); }
      catch (e) { log('⚠ 清空指定 e2e DB 失败（可能有进程占用）: ' + e.message); }
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
    const domImportScript = [
      '(async () => {',
      '  const ta = document.querySelector("[data-testid=import-textarea], textarea");',
      '  if (!ta) return { ok: false, reason: "页面无 textarea" };',
      '  const text = ' + JSON.stringify(docs.map((d) => d.text).join(String.fromCharCode(10, 10))) + ';',
      '  ta.value = text; ta.dispatchEvent(new Event("input", { bubbles: true }));',
      '  const btn = document.querySelector("[data-testid=import-button]") || Array.from(document.querySelectorAll("button")).find((b) => /导入|向量化|写入/.test(b.innerText || ""));',
      '  if (!btn) return { ok: false, reason: "页面无导入按钮" };',
      '  btn.click();',
      '  return { ok: true, clicked: (btn.innerText || "").trim().slice(0, 50) };',
      '})()',
    ].join(String.fromCharCode(10));
    const domResult = await page.evaluate(domImportScript, { timeoutMs: 30000 });
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
    const domSearchScript = [
      '(async () => {',
      '  const input = document.querySelector("[data-testid=search-input], input[type=search], input[type=text]");',
      '  if (!input) return { ok: false, reason: "页面无搜索输入框" };',
      '  input.value = ' + JSON.stringify(query) + '; input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  const btn = document.querySelector("[data-testid=search-button]") || Array.from(document.querySelectorAll("button")).find((b) => /检索|搜索|查询/.test(b.innerText || ""));',
      '  if (!btn) return { ok: false, reason: "页面无检索按钮" };',
      '  btn.click();',
      '  return { ok: true };',
      '})()',
    ].join(String.fromCharCode(10));
    const domResult = await page.evaluate(domSearchScript, { timeoutMs: 30000 });
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
    const hsModel = summary.hookState && summary.hookState.model ? summary.hookState.model : null;
    const hsInfo = hsModel && hsModel.info ? hsModel.info : null;
    check('WASM INT8/q8 模型加载成功（应为 model_quantized.onnx）', !!(badge && /int8/i.test(badge.text || '') && hsModel), { badgeText: badge && badge.text, badgeDtype: badge && badge.dtype, dtype: hsModel && hsModel.dtype, onnxFile: hsInfo && hsInfo.onnxFile, onnxBytes: hsInfo && hsInfo.onnxBytes, compressionRatio: hsInfo && hsInfo.compressionRatio, wasmThreads: hsInfo && hsInfo.wasmThreads });
  }
  check('数据库状态栏显示 seekdb 已连接', !!(ui && /seekdb/i.test(ui.dbStatus || '')), (ui && ui.dbStatus) || null);
}

/* ------------------------------ 证据与场景辅助 ------------------------------ */

/** 证据文件名：webgpu 环境保持原名；wasm 环境的 01-e2e-* 加 -wasm 后缀避免互相覆盖。 */
function evidenceFile(baseName) {
  if (envName === 'wasm' && baseName.startsWith('01-e2e-')) return path.join(EVIDENCE_DIR, baseName.replace(/\.png$/, '-wasm.png'));
  return path.join(EVIDENCE_DIR, baseName);
}

async function shoot(baseName, scrollSelector) {
  const file = evidenceFile(baseName);
  try {
    if (scrollSelector && CLEANUP.page) {
      const ok = await CLEANUP.page.scrollTo(scrollSelector);
      log('截图前滚动到 ' + scrollSelector + ': ' + ok);
      await new Promise((res) => setTimeout(res, 500));
    }
    if (CLEANUP.page) await CLEANUP.page.screenshot(file);
    summary.evidence[path.basename(file)] = 'submission/evidence/' + path.basename(file);
    log('截图: submission/evidence/' + path.basename(file));
  } catch (e) {
    log('⚠ 截图失败 ' + file + ': ' + (e && e.message));
  }
  return file;
}

/** 显式刷新索引（seekdb HNSW delta 异步构建；应用侧 refresh 会做 FTS/向量可见性探针）。 */
async function refreshPhase(page, hook, label) {
  if (!hook || !hook.hasHook || !hook.hasRefresh) { log('（无 refresh 钩子，跳过显式刷新: ' + label + '）'); return null; }
  try {
    const t0 = Date.now();
    const res = await page.evaluate('window.__stepkb.refresh()', { timeoutMs: 120000 });
    const out = { label, ms: Date.now() - t0, result: res };
    summary.refreshes = summary.refreshes || [];
    summary.refreshes.push(out);
    log('refresh[' + label + ']: ' + JSON.stringify(res).slice(0, 400));
    return out;
  } catch (e) {
    log('⚠ refresh 失败(' + label + '): ' + (e && e.message));
    return { label, error: String(e && e.message || e).slice(0, 500) };
  }
}

/** 确保有激活知识库（页面 boot 只加载列表，不自动建库；e2e 显式建一个）。 */
async function ensureKb(page, hook) {
  if (!hook || !hook.hasHook) return null;
  let state = hook.hasState ? await page.evaluate('window.__stepkb.state()', { awaitPromise: false }) : null;
  if (state && state.currentKb) {
    summary.kb = { id: state.currentKb, name: null, created: false, docCount: state.docCount };
    log('复用已有知识库: ' + state.currentKb);
    return state;
  }
  if (!hook.hasCreateKb) { log('⚠ 无 createKb 钩子且无激活知识库，导入可能失败'); return state; }
  const name = 'e2e-' + envName + '-' + Date.now().toString(36);
  const kb = await page.evaluate('window.__stepkb.createKb(' + JSON.stringify(name) + ')', { timeoutMs: 60000 });
  await new Promise((res) => setTimeout(res, 300));
  state = hook.hasState ? await page.evaluate('window.__stepkb.state()', { awaitPromise: false }) : null;
  summary.kb = { id: (kb && kb.id) || (state && state.currentKb) || null, name, created: true };
  log('新建知识库: ' + JSON.stringify(kb));
  check('知识库就绪（新建或复用）', !!(kb && kb.id), kb);
  return state;
}
/** 05 数据层证据：SHOW CREATE TABLE / SHOW INDEX / 单条混合检索 SQL 原文。 */
function writeDbEvidence() {
  const st = summary.backendStats || {};
  const kbList = st.kbs && Array.isArray(st.kbs.kbs) ? st.kbs.kbs : [];
  const kb = kbList.length ? kbList[0] : null;
  const stats = st.stats || {};
  const sep = String.fromCharCode(10);
  const lines = [];
  lines.push('StepKB seekdb 数据层证据（' + envName + ' 环境，' + new Date().toISOString() + '）');
  lines.push('页面: ' + (summary.appUrl || ''));
  lines.push('');
  lines.push('[1] GET /api/db/info');
  lines.push(JSON.stringify(st.dbInfo, null, 2));
  lines.push('');
  lines.push('[2] 知识库：' + (kb ? (kb.name + ' / ' + kb.id + ' / dim=' + kb.dim + ' / model=' + kb.model + ' / docCount=' + kb.docCount) : '(n/a)'));
  lines.push('');
  lines.push('[3] SHOW CREATE TABLE（后端 /api/kbs/:id/stats.createTableSql）');
  lines.push(String(stats.createTableSql || '(无)'));
  lines.push('');
  lines.push('[4] SHOW INDEX');
  const idxList = Array.isArray(stats.indexes) ? stats.indexes : [];
  if (!idxList.length) lines.push('(无)');
  for (const i of idxList) lines.push('- ' + JSON.stringify(i));
  lines.push('');
  lines.push('[5] 单条混合检索 SQL 模板（/stats.sampleHybridSql）');
  lines.push(String(stats.sampleHybridSql || '(无)'));
  lines.push('');
  lines.push('[6] 实际执行的单条混合检索 SQL（window.__stepkb.search 返回）');
  lines.push(String((summary.search && summary.search.result && summary.search.result.sql) || '(无)'));
  lines.push('');
  lines.push('[7] 阶段耗时：queryEmbedMs=' + ((summary.search && summary.search.result && summary.search.result.queryEmbedMs) || '?') + ' ms，dbMs=' + ((summary.search && summary.search.result && summary.search.result.dbMs) || '?') + ' ms');
  const name = envName === 'webgpu' ? '05-db-evidence.txt' : '05-db-evidence-wasm.txt';
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), lines.join(sep) + sep, 'utf8');
  summary.evidence[name] = 'submission/evidence/' + name;
}

/** 02 网络证据：请求清单 + 外网/跨域检查（证明没有云端推理 API 调用）。 */
function writeNetworkEvidence(net) {
  const reqs = net.requests || [];
  const httpReqs = reqs.filter((x) => /^https?:/i.test(x.url));
  const external = httpReqs.filter((x) => {
    try {
      const u = new URL(x.url);
      return !(u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1');
    } catch (e) { return false; }
  });
  const payload = {
    env: envName,
    generatedAt: new Date().toISOString(),
    pageUrl: summary.appUrl,
    totalRequests: net.total,
    byHost: net.byHost,
    bySource: net.bySource,
    httpRequestCount: httpReqs.length,
    externalRequestCount: external.length,
    externalRequests: external,
    requests: reqs.map((x) => ({ source: x.source, method: x.method, url: x.url, status: x.status == null ? null : x.status, type: x.type })),
  };
  const suffix = envName === 'webgpu' ? '' : '-wasm';
  const name = '02-network-no-inference' + suffix + '.json';
  writeJson(path.join(EVIDENCE_DIR, name), payload);
  summary.evidence[name] = 'submission/evidence/' + name;
  const sep = String.fromCharCode(10);
  const md = [];
  md.push('# 网络请求清单（' + envName + ' 环境，' + new Date().toISOString() + '）');
  md.push('');
  md.push('- 页面：' + (summary.appUrl || ''));
  md.push('- 总请求数：' + net.total + '（HTTP(S)：' + httpReqs.length + '）');
  md.push('- 按 host 统计：' + JSON.stringify(net.byHost));
  md.push('- 按来源统计：' + JSON.stringify(net.bySource));
  md.push('- 外网/跨域请求：**' + external.length + ' 条**' + (external.length ? '（见下）' : '（无，未调用云端推理 API）'));
  md.push('');
  md.push('## 请求清单（截取前 200 条）');
  md.push('');
  md.push('| # | 来源 | 方法 | URL | 状态 | 类型 |');
  md.push('| --- | --- | --- | --- | --- | --- |');
  reqs.slice(0, 200).forEach((x, i) => {
    md.push('| ' + (i + 1) + ' | ' + x.source + ' | ' + x.method + ' | ' + x.url + ' | ' + (x.status == null ? '' : x.status) + ' | ' + (x.type || '') + ' |');
  });
  const mdName = '02-network-no-inference' + suffix + '.md';
  fs.writeFileSync(path.join(EVIDENCE_DIR, mdName), md.join(sep) + sep, 'utf8');
  summary.evidence[mdName] = 'submission/evidence/' + mdName;
  summary.network = { total: net.total, byHost: net.byHost, bySource: net.bySource, httpRequestCount: httpReqs.length, externalRequestCount: external.length, externalRequests: external.slice(0, 20) };
  check('无云端推理 API 调用（网络请求仅本机/同源）', external.length === 0, { externalRequestCount: external.length, hosts: net.byHost });
}

/** 06 增量刷新场景：第二批写入 → refresh → 第二批内容可检索。 */
async function refreshScenario(page, hook) {
  if (!hook || !hook.hasHook || !hook.hasImportTexts) { summary.refreshScenario = { skipped: true, reason: '无 importTexts 钩子' }; return; }
  const docs2 = [
    { id: 'e2e-incr-1', text: '增量刷新验证文档一：INCREMENTALREFRESHXYZZY，用于验证第二批写入后 refresh 即可被全文检索命中。' },
    { id: 'e2e-incr-2', text: '增量刷新验证文档二：INCREMENTALREFRESHXYZZY，同样属于第二批写入的增量文档。' },
  ];
  const t0 = Date.now();
  try {
    const before = hook.hasState ? await page.evaluate('window.__stepkb.state()', { awaitPromise: false }) : null;
    const imp2 = await page.evaluate('window.__stepkb.importTexts(' + JSON.stringify(docs2) + ', {})', { timeoutMs: Number(args.importTimeoutMs || 600000) });
    const refresh2 = await refreshPhase(page, hook, '增量第二批导入后');
    let rows = null;
    const attempts = [];
    for (let i = 1; i <= 6; i++) {
      const res = await page.evaluate('window.__stepkb.search("INCREMENTALREFRESHXYZZY", "fulltext", 5)', { timeoutMs: 60000 });
      rows = res && Array.isArray(res.rows) ? res.rows : null;
      attempts.push({ attempt: i, rows: rows ? rows.length : 0 });
      if (rows && rows.length > 0) break;
      await new Promise((res2) => setTimeout(res2, 500));
    }
    const after = hook.hasState ? await page.evaluate('window.__stepkb.state()', { awaitPromise: false }) : null;
    const hitIds = (rows || []).map((x) => x.id);
    const payload = {
      env: envName,
      generatedAt: new Date().toISOString(),
      batch2Docs: docs2.map((d) => d.id),
      import2: imp2,
      refreshAfterImport2: refresh2,
      searchQuery: 'INCREMENTALREFRESHXYZZY',
      searchMode: 'fulltext',
      attempts,
      hitIds,
      found: hitIds.includes('e2e-incr-1') || hitIds.includes('e2e-incr-2'),
      stateBefore: before,
      stateAfter: after,
      elapsedMs: Date.now() - t0,
    };
    const name = envName === 'webgpu' ? '06-refresh.json' : '06-refresh-wasm.json';
    writeJson(path.join(EVIDENCE_DIR, name), payload);
    summary.evidence[name] = 'submission/evidence/' + name;
    summary.refreshScenario = payload;
    check('增量导入第二批 + refresh 后可检索（06-refresh）', payload.found, { hitIds, attempts, docCountBefore: before && before.docCount, docCountAfter: after && after.docCount });
  } catch (e) {
    summary.refreshScenario = { error: String(e && e.message || e).slice(0, 800) };
    check('增量导入第二批 + refresh 后可检索（06-refresh）', false, summary.refreshScenario.error);
  }
}

/** 03 评测面板（可选，--benchmark）。 */
async function benchmarkPhase(page, hook) {
  if (!hook || !hook.hasHook || !hook.hasRunBenchmark) { summary.benchmark = { skipped: true, reason: '无 runBenchmark 钩子' }; return; }
  try {
    const runs = Number(args.benchRuns || 1);
    log('运行页面评测面板（benchmark，runs=' + runs + '）…');
    const result = await page.evaluate('window.__stepkb.runBenchmark({ runs: ' + runs + ' })', { timeoutMs: Number(args.benchTimeoutMs || 900000) });
    const name = envName === 'webgpu' ? '03-benchmark.json' : '03-benchmark-wasm.json';
    writeJson(path.join(EVIDENCE_DIR, name), { env: envName, generatedAt: new Date().toISOString(), runs, result });
    summary.evidence[name] = 'submission/evidence/' + name;
    summary.benchmark = { runs, result };
    check('页面评测面板（benchmark）产出结果', !!result, result ? Object.keys(result).slice(0, 8) : null);
  } catch (e) {
    summary.benchmark = { error: String(e && e.message || e).slice(0, 800) };
    check('页面评测面板（benchmark）', false, summary.benchmark.error);
  }
}
async function main() {
  log('===== StepKB e2e run =====');
  log(JSON.stringify({ env: envName, runDir, args }));

  const baseUrl = await startBackendPhase();
  const browser = await acquireBrowserPhase();
  CLEANUP.browser = browser;

  const appUrl = args.appUrl || baseUrl;
  summary.appUrl = appUrl;

  // 1) 打开应用页面（先不注入），在应用同源页面里探测浏览器真实能力
  //    （about:blank 不是 secure context，WebGPU 探测会误判不可用）
  let page = await openPage({
    port: browser.port,
    url: appUrl,
    loadTimeoutMs: Number(args.loadTimeoutMs || 45000),
    logDir: runDir,
  });
  CLEANUP.page = page;
  let envProbe = await page.evaluate(ENV_PROBE_EXPR);
  summary.actualEnvProbe = envProbe;
  log('浏览器真实能力（应用页面）: ' + JSON.stringify({ chrome: envProbe && envProbe.chromeVersion, gpuUsable: !!(envProbe && envProbe.gpu && envProbe.gpu.usable), gpuInfo: (envProbe && envProbe.gpu && envProbe.gpu.info) || null }));

  // 2) WASM 降级环境：若浏览器真实支持 WebGPU，则用 CDP 注入隐藏 navigator.gpu 后重新打开页面
  let webgpuSimulated = false;
  if (envName === 'wasm' && envProbe && envProbe.gpu && envProbe.gpu.usable && !args.noSimulate) {
    webgpuSimulated = true;
    try { await page.close(); } catch (e) { /* ignore */ }
    CLEANUP.page = null;
    page = await openPage({
      port: browser.port,
      url: appUrl,
      loadTimeoutMs: Number(args.loadTimeoutMs || 45000),
      logDir: runDir,
      preloadScripts: [HIDE_WEBGPU_PRELOAD],
    });
    CLEANUP.page = page;
    envProbe = await page.evaluate(ENV_PROBE_EXPR);
    summary.envProbeAfterInjection = envProbe;
  }
  summary.page = { url: page.url, webgpuSimulated };
  summary.webgpuSimulated = webgpuSimulated;
  check('打开应用页面 ' + appUrl, true);

  summary.envProbe = envProbe;
  log('应用页面环境（最终）: ' + JSON.stringify({ chrome: envProbe.chromeVersion, secure: envProbe.isSecureContext, gpuUsable: envProbe.gpu && envProbe.gpu.usable, gpu: envProbe.gpu, webgpuSimulated }));
  if (envName === 'wasm') check('WASM 降级环境构造方式', true, webgpuSimulated ? '模拟：CDP 注入隐藏 navigator.gpu（Chrome 156 的 --disable-features=WebGPU 已失效，如实记录）' : '真实：当前浏览器 WebGPU 不可用');
  if (envName === 'webgpu') check('WebGPU 环境构造方式', !!(envProbe && envProbe.gpu && envProbe.gpu.usable), envProbe && envProbe.gpu ? { info: envProbe.gpu.info || null } : null);
  // COOP/COEP：后端必须设置，否则 WASM 多线程 / SharedArrayBuffer 不可用
  check('页面 secure context', !!(envProbe && envProbe.isSecureContext), envProbe && envProbe.isSecureContext);
  check('COOP/COEP 生效（crossOriginIsolated=true，WASM 线程前提）', !!(envProbe && envProbe.crossOriginIsolated), { crossOriginIsolated: envProbe && envProbe.crossOriginIsolated, hasSharedArrayBuffer: envProbe && envProbe.hasSharedArrayBuffer });

  const hook = await page.evaluate(HOOK_PROBE_EXPR, { timeoutMs: 60000 });
  summary.hook = hook;
  log('window.__stepkb 钩子: ' + JSON.stringify(hook));
  check('window.__stepkb 钩子存在（e2e 契约）', !!(hook && hook.hasHook), hook);

  await waitForAppReady(page, hook);
  // 记录应用内部状态（模型 onnxFile/size、dtype、文档数等），作为模型量化档位的证据
  try {
    summary.hookState = hook && hook.hasGetState ? await page.evaluate('window.__stepkb.getState()', { awaitPromise: false }) : null;
  } catch (e) { summary.hookState = { error: String(e && e.message || e).slice(0, 300) }; }
  log('应用状态: ' + JSON.stringify({ model: summary.hookState && summary.hookState.model ? { status: summary.hookState.model.status, backend: summary.hookState.model.backend, dtype: summary.hookState.model.dtype, info: summary.hookState.model.info ? { onnxFile: summary.hookState.model.info.onnxFile, onnxBytes: summary.hookState.model.info.onnxBytes, compressionRatio: summary.hookState.model.info.compressionRatio, wasmThreads: summary.hookState.model.info.wasmThreads } : null } : null }));
  summary.uiBefore = await page.evaluate(BADGE_PROBE_EXPR);

  // ---- 主流程：确保知识库 → 导入语料 → 刷新 → 截图（导入）→ 混合检索 → 截图（检索）----
  await ensureKb(page, hook);
  const importResult = await importCorpus(page, hook);
  await refreshPhase(page, hook, '主流程导入后');
  summary.uiAfterImport = await page.evaluate(BADGE_PROBE_EXPR);
  await shoot('01-e2e-import.png', '[data-testid=import-summary]');

  await searchPhase(page, hook);
  summary.uiAfterSearch = await page.evaluate(BADGE_PROBE_EXPR);
  await shoot('01-e2e-search.png', '[data-testid=result-list]');
  // 状态栏/降级横幅特写（在增量场景之前拍，保证展示的是主流程混合检索状态）
  await shoot(envName === 'webgpu' ? '04-webgpu.png' : '04-wasm-fallback.png', '[data-testid=status-bar]');

  // ---- 断言：徽标 / 后端 / 数据层 ----
  const ui = await page.evaluate(BADGE_PROBE_EXPR);
  assertBackendBadge(envProbe, ui);
  await fetchBackendStats(baseUrl);
  writeDbEvidence();

  // ---- 增量刷新场景（第二批写入 → refresh → 可检索）----
  await refreshScenario(page, hook);

  // ---- 可选：页面评测面板（--benchmark）----
  if (args.benchmark) await benchmarkPhase(page, hook);

  // ---- 网络证据（放最后以覆盖全流程；含 Worker 请求）----
  writeNetworkEvidence(page.networkSummary());

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
    // 证据副本：outputs/logs/2026-10-31_e2e-<env>.{log,json}
    try {
      const outLogDir = path.join(TASK_ROOT, 'outputs', 'logs');
      fs.mkdirSync(outLogDir, { recursive: true });
      const day = '2026-10-31';
      fs.copyFileSync(logFile, path.join(outLogDir, day + '_e2e-' + envName + '.log'));
      writeJson(path.join(outLogDir, day + '_e2e-' + envName + '.json'), summary);
      log('证据副本: ' + path.join(outLogDir, day + '_e2e-' + envName + '.{log,json}'));
    } catch (e) { /* ignore */ }
  }
})();