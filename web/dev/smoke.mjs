/**
 * 浏览器冒烟验证（web-ui 自测；完整双后端 e2e 由 browser-e2e 负责）。
 *
 * 本机沙箱事实（DEV-ENV + e2e 实测）：
 *  - agent 沙箱内 spawn 带 pipe 的进程会 EPERM；Chromium 的 Mojo IPC 需要命名管道，
 *    所以 agent 内无法直接启动 Chrome（会立即自杀）。
 *  - e2e 的做法：由人类终端/沙箱外进程用 e2e/launch-chrome.ps1 启动带 --remote-debugging-port 的 Chrome，
 *    agent 侧 attach。本脚本同样支持 attach：--cdp-url http://127.0.0.1:19223
 *  - 也支持 --spawn（仅当环境允许时）；失败会给出明确原因。
 *
 * 用法：
 *   node web/dev/smoke.mjs --url http://127.0.0.1:18271/ --cdp-url http://127.0.0.1:19223
 *   node web/dev/smoke.mjs --url http://127.0.0.1:18271/ [--bench int8-wasm]
 * 产物：outputs/logs/2026-10-31_web-smoke.{log,json} 与截图。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..', '..');
const taskRoot = path.resolve(srcRoot, '..');
const logsDir = path.join(taskRoot, 'outputs', 'logs');
const scratchDir = path.resolve(srcRoot, '..', '..', '_scratch', 't27');

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const PAGE_URL = argValue('url', 'http://127.0.0.1:18271/');
const CDP_URL = argValue('cdp-url', '');
const BENCH_CONFIG = argValue('bench', '');
const SPAWN_PORT = Number(argValue('spawn-port', '19262'));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOT_PREFIX = '2026-10-31_web-smoke';

fs.mkdirSync(logsDir, { recursive: true });

const startedAt = Date.now();
const lines = [];
const pageLogs = [];
function log(msg, data) {
  const line = '[' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's] ' + msg + (data === undefined ? '' : ' ' + JSON.stringify(data));
  lines.push(line);
  console.log(line);
}
function writeEvidence() {
  const file = path.join(logsDir, SHOT_PREFIX + '.log');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForJson(url, timeoutMs = 40000) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeoutMs) {
    try {
      return await fetchJson(url, 3000);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error('等待 ' + url + ' 超时：' + (lastErr?.message ?? ''));
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message + ' (' + msg.error.code + ')'));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 15000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket 连接失败'));
      });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, timeoutMs = 60000, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 超时：' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  onEvent(fn) {
    this.listeners.add(fn);
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function remoteToString(remote) {
  if (!remote) return '';
  if (remote.value !== undefined) return typeof remote.value === 'string' ? remote.value : JSON.stringify(remote.value);
  return remote.description ?? remote.unserializableValue ?? '';
}

async function screenshot(cdp, sessionId, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000, sessionId);
  const file = path.join(logsDir, SHOT_PREFIX + '-' + name + '.png');
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  log('截图已保存 ' + file);
  return file;
}

let chromeProc = null;
let cdp = null;
let sessionId = undefined;
let closeTargetId = null;

async function openTarget() {
  if (CDP_URL) {
    log('attach 模式：连接已存在的 Chrome ' + CDP_URL);
    const version = await waitForJson(CDP_URL + '/json/version', 20000);
    log('浏览器：' + version.Browser);
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' }, 20000);
    closeTargetId = created.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true }, 20000);
    sessionId = attached.sessionId;
    log('已创建独立 page target：' + created.targetId);
    return;
  }
  log('spawn 模式：尝试启动 headless Chrome（沙箱内通常失败）');
  const profileDir = path.join(scratchDir, 'chrome-webui-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  chromeProc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + SPAWN_PORT,
      '--user-data-dir=' + profileDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-crash-reporter',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1600,1200',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  chromeProc.on('exit', (code) => log('Chrome 退出 code=' + code));
  const version = await waitForJson('http://127.0.0.1:' + SPAWN_PORT + '/json/version', 30000);
  log('CDP 就绪：' + version.Browser);
  const list = await waitForJson('http://127.0.0.1:' + SPAWN_PORT + '/json/list', 15000);
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到 page target');
  cdp = await Cdp.connect(page.webSocketDebuggerUrl);
}

async function closeBrowser() {
  if (cdp) {
    if (CDP_URL && closeTargetId) {
      try {
        await cdp.send('Target.closeTarget', { targetId: closeTargetId }, 5000);
      } catch {
        /* ignore */
      }
    }
    cdp.close();
    cdp = null;
  }
  if (chromeProc && !chromeProc.killed) {
    try {
      chromeProc.kill();
    } catch {
      /* ignore */
    }
    chromeProc = null;
  }
}

async function main() {
  const summary = { ok: false, page: PAGE_URL, mode: CDP_URL ? 'attach' : 'spawn', startedAt: new Date().toISOString() };
  await openTarget();

  cdp.onEvent((msg) => {
    if (sessionId && msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map(remoteToString).join(' ');
      pageLogs.push('[' + msg.params.type + '] ' + text);
      log('页面 console: ' + text.slice(0, 400));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const text = msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '';
      pageLogs.push('[exception] ' + text);
      log('页面异常：' + text.slice(0, 800));
    } else if (msg.method === 'Log.entryAdded') {
      const entry = msg.params.entry;
      pageLogs.push('[' + entry.level + '] ' + entry.text);
      if (entry.level === 'error' || entry.level === 'warning') log('页面 log[' + entry.level + ']：' + entry.text.slice(0, 400));
    }
  });

  const S = (method, params = {}, timeoutMs = 60000) => cdp.send(method, params, timeoutMs, sessionId);
  await S('Page.enable');
  await S('Runtime.enable');
  await S('Log.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });

  async function evaluate(expression, awaitPromise = false, timeoutMs = 60000) {
    const result = await S('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, timeoutMs);
    if (result.exceptionDetails) {
      throw new Error('页面执行异常：' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    }
    return result.result?.value;
  }

  if (args.includes('--no-webgpu')) {
    // 模拟 WebGPU 不可用：在页面脚本前隐藏 navigator.gpu（与 e2e/run.mjs --env wasm 同一方法）
    await S('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true }); window.__stepkbWebgpuHidden = true;",
    });
    log('已注入脚本：隐藏 navigator.gpu（模拟 WebGPU 不可用，验证 WASM 降级）');
  }
  log('打开页面 ' + PAGE_URL);
  await cdp.send('Page.navigate', { url: PAGE_URL }, 30000, sessionId);
  await new Promise((r) => setTimeout(r, 1500));

  summary.pageTitle = await evaluate('document.title');
  log('标题：' + summary.pageTitle);
  summary.hooks = await evaluate('typeof window.__stepkb === "object" && window.__stepkb !== null');
  log('__stepkb 存在：' + summary.hooks);
  if (!summary.hooks) throw new Error('window.__stepkb 未注入');

  const readyT0 = Date.now();
  const readyResult = await evaluate('window.__stepkb.ready().then(() => "READY").catch((e) => "ERR:" + e.message)', true, 300000);
  summary.readyMs = Date.now() - readyT0;
  log('ready(): ' + readyResult + '（' + summary.readyMs + 'ms）');
  if (readyResult !== 'READY') throw new Error('ready() 失败：' + readyResult);

  summary.state = JSON.parse(await evaluate('JSON.stringify(window.__stepkb.state())'));
  log('state()：', summary.state);
  const fullState = JSON.parse(await evaluate('JSON.stringify(window.__stepkb.getState())'));
  summary.webgpu = fullState.webgpu;
  summary.modelInfo = fullState.model?.info ?? null;
  summary.fallbackReason = fullState.model?.fallbackReason ?? null;
  summary.modelStatus = fullState.model?.status;
  summary.db = { status: fullState.db?.status, health: fullState.db?.health, error: fullState.db?.error };
  log('模型信息：' + JSON.stringify(summary.modelInfo));
  log('DB：' + JSON.stringify(summary.db));
  summary.screenshotHome = await screenshot(cdp, sessionId, '01-home');

  let kbId = summary.state.currentKb ?? null;
  if (!kbId) {
    kbId = await evaluate('window.__stepkb.createKb("冒烟验证-" + Date.now()).then((kb) => kb.id)', true, 60000);
    log('创建知识库：' + kbId);
  }
  summary.kbId = kbId;

  const corpus = await fetchJson('http://127.0.0.1:18271/data/corpus.json', 15000);
  const corpusArr = Array.isArray(corpus) ? corpus : corpus.docs;
  const docs = corpusArr.slice(0, 10).map((d) => ({ id: d.id, text: d.text }));
  const importT0 = Date.now();
  const importRes = await evaluate(
    'window.__stepkb.importTexts(' + JSON.stringify(docs) + ', {kb:' + JSON.stringify(kbId) + '})',
    true,
    240000,
  );
  summary.import = { ...importRes, wallMs: Date.now() - importT0 };
  log('导入结果：' + JSON.stringify(summary.import));

  const query = '向量数据库如何提升相似度检索性能';
  const searchT0 = Date.now();
  const searchRes = await evaluate('window.__stepkb.search(' + JSON.stringify(query) + ', "hybrid", 5)', true, 120000);
  summary.search = {
    query,
    rows: Array.isArray(searchRes.rows) ? searchRes.rows.length : -1,
    topIds: (searchRes.rows ?? []).map((r) => r.id),
    topText: (searchRes.rows ?? [])[0]?.text?.slice(0, 60) ?? '',
    dbMs: searchRes.dbMs,
    queryEmbedMs: searchRes.queryEmbedMs,
    sqlHasMatch: typeof searchRes.sql === 'string' && searchRes.sql.includes('MATCH('),
    sqlHasL2: typeof searchRes.sql === 'string' && searchRes.sql.includes('l2_distance('),
    wallMs: Date.now() - searchT0,
  };
  log('检索结果：' + JSON.stringify(summary.search));
  summary.screenshotSearch = await screenshot(cdp, sessionId, '02-search-hybrid');

  const ftRes = await evaluate('window.__stepkb.search("向量数据库", "fulltext", 3)', true, 60000);
  summary.fulltext = { rows: Array.isArray(ftRes.rows) ? ftRes.rows.length : -1, dbMs: ftRes.dbMs, queryEmbedMs: ftRes.queryEmbedMs };
  log('全文检索：' + JSON.stringify(summary.fulltext));

  summary.refresh = await evaluate('window.__stepkb.refresh()', true, 60000);
  log('刷新索引：' + JSON.stringify(summary.refresh));

  summary.dom = JSON.parse(
    await evaluate(
      'JSON.stringify({' +
        '"backendBadge": document.querySelector("[data-testid=backend-badge]")?.textContent,' +
        '"statusBar": !!document.querySelector("[data-testid=status-bar]"),' +
        '"modelInfo": document.querySelector("[data-testid=model-info]")?.textContent,' +
        '"resultList": !!document.querySelector("[data-testid=result-list]"),' +
        '"resultItems": document.querySelectorAll("[data-testid=result-list] .result-item").length,' +
        '"sqlDetails": !!document.querySelector("[data-testid=sql-details]"),' +
        '"searchTimings": !!document.querySelector("[data-testid=search-timings]"),' +
        '"docCount": document.querySelector("[data-testid=doc-count] .num")?.textContent,' +
        '"importProgress": !!document.querySelector("[data-testid=import-progress]")' +
        '})',
    ),
  );
  log('DOM 检查：' + JSON.stringify(summary.dom));
  summary.screenshotFulltext = await screenshot(cdp, sessionId, '02b-search-fulltext');

  if (BENCH_CONFIG) {
    const benchLabel = BENCH_CONFIG === 'all' ? '全部 3 个配置' : BENCH_CONFIG;
    log('开始评测：' + benchLabel + '（每个配置 5 次检索，可能耗时 2-5 分钟）');
    const benchT0 = Date.now();
    const benchExpr =
      BENCH_CONFIG === 'all'
        ? 'window.__stepkb.runBenchmark()'
        : 'window.__stepkb.runBenchmark(' + JSON.stringify(BENCH_CONFIG) + ')';
    const bench = await evaluate(benchExpr, true, 900000);
    summary.bench = {
      wallMs: Date.now() - benchT0,
      configs: (bench.configs ?? []).map((c) => ({
        id: c.id,
        status: c.status,
        onnxBytes: c.model?.onnxBytes,
        compressionRatio: c.model?.compressionRatio,
        docsPerSec: c.vectorize?.docsPerSec,
        summary: c.summary,
      })),
    };
    log('评测结果：' + JSON.stringify(summary.bench));
    summary.screenshotBench = await screenshot(cdp, sessionId, '03-bench');
    try {
      const raw = await evaluate('JSON.stringify(window.__stepkb.getBenchmarkResult())', false, 60000);
      const benchFile = path.join(logsDir, SHOT_PREFIX + '-benchmark.json');
      fs.writeFileSync(benchFile, raw, 'utf8');
      summary.benchmarkJson = benchFile;
      log('评测完整 JSON 已保存：' + benchFile + '（' + raw.length + ' 字符）');
    } catch (err) {
      log('保存完整评测 JSON 失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }

  summary.pageErrors = pageLogs.filter((l) => l.startsWith('[exception]') || l.startsWith('[error]'));
  summary.ok =
    summary.search.rows > 0 && summary.search.sqlHasMatch && summary.search.sqlHasL2 && summary.search.topText.length > 0;
  return summary;
}

try {
  const summary = await main();
  const logFile = writeEvidence();
  fs.writeFileSync(path.join(logsDir, SHOT_PREFIX + '.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('\n=== SMOKE SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log('log: ' + logFile);
  await closeBrowser();
  process.exit(summary.ok ? 0 : 2);
} catch (err) {
  log('失败：' + (err instanceof Error ? err.stack ?? err.message : String(err)));
  const logFile = writeEvidence();
  console.log('FAIL: ' + (err instanceof Error ? err.message : String(err)));
  console.log('log: ' + logFile);
  await closeBrowser();
  process.exit(1);
}
