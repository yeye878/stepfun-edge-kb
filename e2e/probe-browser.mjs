// e2e/probe-browser.mjs — 浏览器能力探测（验收第一步）
//
// 背景结论（2026-10-31）：agent 沙箱禁止命名管道 → Chromium Mojo IPC 无法初始化 →
// **在沙箱内 Chrome/Edge 完全无法启动**（Playwright 与 --remote-debugging-port 两条路都堵死）。
// 因此本脚本支持两种模式：
//   A) attach 模式（推荐）：探测一个已在沙箱外启动、带 --remote-debugging-port 的 Chrome
//      node e2e/probe-browser.mjs --cdp-url http://127.0.0.1:19222 [--cdp-url-wasm http://127.0.0.1:19223]
//   B) spawn 模式（非沙箱环境，如评审机）：脚本自行拉起多组启动参数的 Chrome 并对比
//      node e2e/probe-browser.mjs
// 输出：e2e/out/browser-probe-*.json + submission/evidence/00-*.png / 00-browser-capability.json
// 退出码：0=至少一条路径探测成功；3=浏览器不可用（环境限制）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, attachChrome, killChrome, CHROME_PATH } from './lib/chrome.mjs';
import { openPage } from './lib/page.mjs';
import { HIDE_WEBGPU_PRELOAD } from './lib/inpage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASK_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'out');
const EVIDENCE_DIR = path.join(TASK_ROOT, 'submission', 'evidence');
const PROBE_PORT = 18279;
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
const PROBE_HTML = fs.readFileSync(path.join(__dirname, 'probe-page.html'), 'utf8');

function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = camel(a.slice(2));
    const v = argv[++i];
    out[k] = v === undefined ? true : v;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const log = (...p) => console.log(p.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const report = {
  tool: 'e2e/probe-browser.mjs',
  startedAt: startedAt.toISOString(),
  node: process.version,
  platform: process.platform + ' ' + process.arch,
  chromePath: CHROME_PATH,
  chromeExists: fs.existsSync(CHROME_PATH),
  mode: (args.cdpUrl || args.cdpUrlWasm) ? 'attach' : 'spawn',
  attaches: [],
  spawns: [],
  summary: null,
};

function startProbeServer() {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/probe.html' || url === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // 与后端 server/index.mjs 一致，保证探测到的 crossOriginIsolated / SharedArrayBuffer 与应用页面同口径
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.end(PROBE_HTML);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PROBE_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** 探测一个已就绪的调试端口（attach 或 spawn 后都走这里）。 */
async function probeEndpoint({ label, port, evidenceName, browserMeta, simulate = false }) {
  const url = 'http://127.0.0.1:' + PROBE_PORT + '/probe.html?label=' + encodeURIComponent(label);
  const page = await openPage({ port, url, loadTimeoutMs: 30000, preloadScripts: simulate ? [HIDE_WEBGPU_PRELOAD] : [] });
  try {
    await page.waitFor('window.__probe', { timeoutMs: 40000, label: '页面内探测完成（window.__probe）' });
    const probe = await page.evaluate('window.__probe', { awaitPromise: false, timeoutMs: 30000 });
    const shot = path.join(EVIDENCE_DIR, evidenceName);
    await page.screenshot(shot);
    return {
      label,
      ok: true,
      simulated: !!simulate,
      browserMeta,
      probe,
      screenshot: 'submission/evidence/' + evidenceName,
      screenshotAbs: shot,
      consoleErrors: page.consoleErrors.slice(0, 10),
      exceptions: page.exceptions.slice(0, 10),
    };
  } finally {
    await page.close();
  }
}

async function runAttach(label, cdpUrl, evidenceName, { simulate = false } = {}) {
  const item = { label, mode: 'attach', cdpUrl, simulated: !!simulate, ok: false };
  try {
    const attached = await attachChrome(cdpUrl);
    item.browserMeta = { browser: attached.info.Browser, protocolVersion: attached.info['Protocol-Version'], userAgent: attached.info['User-Agent'] };
    const probed = await probeEndpoint({ label, port: attached.port, evidenceName, browserMeta: item.browserMeta, simulate });
    Object.assign(item, probed);
  } catch (e) {
    item.error = { name: e.name, message: String(e && e.message || e).slice(0, 1200), code: e.code || null, hint: e.hint || null };
  }
  log('--- attach', label, JSON.stringify({ ok: item.ok, error: item.error || null, screenshot: item.screenshot || null }));
  return item;
}

const SPAWN_CONFIGS = [
  { name: 'headless-default', headless: true, extraArgs: [], evidence: '00-probe-spawn-headless-default.png' },
  { name: 'headless-disable-webgpu', headless: true, extraArgs: ['--disable-features=WebGPU'], evidence: '00-probe-spawn-headless-disable-webgpu.png' },
  { name: 'headless-disable-gpu', headless: true, extraArgs: ['--disable-gpu'], evidence: '00-probe-spawn-headless-disable-gpu.png' },
  { name: 'headed-default', headless: false, extraArgs: [], evidence: '00-probe-spawn-headed-default.png' },
  { name: 'headed-disable-webgpu', headless: false, extraArgs: ['--disable-features=WebGPU'], evidence: '00-probe-spawn-headed-disable-webgpu.png' },
];

async function runSpawn(cfg, index) {
  const item = { label: cfg.name, mode: 'spawn', headless: cfg.headless, extraArgs: cfg.extraArgs, ok: false };
  const profile = path.join(OUT_DIR, 'chrome-profile', cfg.name);
  let handle = null;
  try {
    fs.rmSync(profile, { recursive: true, force: true });
    // 注意：19222/19223 是 Lead 在沙箱外起的 Chrome 端口，spawn 模式必须避开，否则会误 attach 到别人的浏览器
    handle = await launchChrome({ port: 19310 + index, headless: cfg.headless, userDataDir: profile, extraArgs: cfg.extraArgs, logDir: path.join(OUT_DIR, 'chrome-logs', cfg.name), timeoutMs: 30000 });
    item.browserMeta = { browser: handle.info.Browser, protocolVersion: handle.info['Protocol-Version'], args: handle.args };
    const probed = await probeEndpoint({ label: cfg.name, port: handle.port, evidenceName: cfg.evidence, browserMeta: item.browserMeta });
    Object.assign(item, probed);
  } catch (e) {
    item.error = { name: e.name, message: String(e && e.message || e).slice(0, 2000), code: e.code || null, hint: e.hint || null, chromeStderr: String(e.chromeStderr || '').slice(0, 2000) };
  } finally {
    if (handle) { try { await killChrome(handle); } catch { /* ignore */ } }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  log('--- spawn', cfg.name, JSON.stringify({ ok: item.ok, error: item.error ? item.error.code || item.error.message.slice(0, 120) : null, screenshot: item.screenshot || null }));
  return item;
}

function summarize() {
  const every = [...report.attaches, ...report.spawns].filter((x) => x.ok && x.probe);
  const all = every.filter((x) => !x.simulated);            // 真实环境
  const simulated = every.filter((x) => x.simulated);       // CDP 注入的等价环境
  const usable = all.filter((x) => x.probe.gpu && x.probe.gpu.present && x.probe.gpu.adapter && x.probe.gpu.device);
  const unusable = all.filter((x) => !(x.probe.gpu && x.probe.gpu.present && x.probe.gpu.adapter && x.probe.gpu.device));
  const flaggedDisable = all.filter((x) => (x.extraArgs || []).some((a) => /disable-features=WebGPU/.test(a)));
  report.summary = {
    probedCount: all.length,
    webgpuUsable: usable.map((x) => x.label),
    webgpuUnusable: unusable.map((x) => x.label),
    recommendedWebgpuEnv: (usable[0] || {}).label || null,
    recommendedWasmEnv: (unusable[0] || {}).label || null,
    browserBlockedInAgentSandbox: all.length === 0,
    disableFeaturesWebGpuIneffective: flaggedDisable.length > 0 && flaggedDisable.every((x) => x.probe.gpu && x.probe.gpu.usable),
    simulatedNoWebGpuEnvs: simulated.map((x) => ({ label: x.label, gpuPresent: !!(x.probe.gpu && x.probe.gpu.present), gpuUsable: !!(x.probe.gpu && x.probe.gpu.usable), screenshot: x.screenshot })),
    note: 'Chrome 156 中 --disable-features=WebGPU 已被忽略：加该参数后 navigator.gpu 仍返回硬件 adapter 且 device 可建。WASM 降级环境用 CDP 注入隐藏 navigator.gpu 构造（label=wasm-simulated，页面内 navigator.gpu=undefined），e2e/run.mjs --env wasm 自动注入并在 summary.webgpuSimulated 如实标记。',
    detail: all.length === 0 ? '所有启动路径均失败：agent 沙箱禁止命名管道，Chromium Mojo IPC 无法初始化（环境限制）' : null,
  };
}

(async () => {
  let server = null;
  try {
    log('===== 浏览器能力探测 =====');
    log(JSON.stringify({ mode: report.mode, chromePath: CHROME_PATH, chromeExists: report.chromeExists }));
    server = await startProbeServer();
    log('探测页服务: http://127.0.0.1:' + PROBE_PORT + '/probe.html');

    if (report.mode === 'attach') {
      if (args.cdpUrl) {
        report.attaches.push(await runAttach('webgpu-attach', args.cdpUrl, '00-probe-webgpu.png'));
        if (!args.noSimulate) {
          // 同一 Chrome 内再探测一次「注入隐藏 navigator.gpu」后的等价环境（WASM 降级路径的能力依据）
          report.attaches.push(await runAttach('wasm-simulated', args.cdpUrl, '00-probe-wasm-simulated.png', { simulate: true }));
        }
      }
      if (args.cdpUrlWasm) report.attaches.push(await runAttach('wasm-attach', args.cdpUrlWasm, '00-probe-wasm.png'));
    } else {
      for (let i = 0; i < SPAWN_CONFIGS.length; i++) report.spawns.push(await runSpawn(SPAWN_CONFIGS[i], i));
    }
    summarize();
    report.finishedAt = new Date().toISOString();
    const ok = (report.summary.probedCount || 0) > 0;
    log('===== 汇总 =====');
    log(JSON.stringify(report.summary, null, 2));
    const jsonPath = path.join(OUT_DIR, 'browser-probe-' + stamp + '.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'browser-probe-latest.json'), JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(path.join(EVIDENCE_DIR, '00-browser-capability.json'), JSON.stringify(report, null, 2), 'utf8');
    log('报告: ' + jsonPath + ' / submission/evidence/00-browser-capability.json');
    if (!ok) {
      log('');
      log('⚠ 浏览器在当前 agent 沙箱内不可用（环境限制，非功能失败）。');
      log('  请在沙箱外的普通终端运行: pwsh -File e2e/launch-chrome.ps1 -Env both');
      log('  然后运行: node e2e/probe-browser.mjs --cdp-url http://127.0.0.1:19222 --cdp-url-wasm http://127.0.0.1:19223');
      process.exitCode = 3;
    }
  } catch (e) {
    report.fatal = String(e && e.stack || e);
    log('[FATAL] ' + report.fatal);
    try { fs.writeFileSync(path.join(OUT_DIR, 'browser-probe-fatal-' + stamp + '.json'), JSON.stringify(report, null, 2), 'utf8'); } catch { /* ignore */ }
    process.exitCode = 1;
  } finally {
    if (server) {
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      try { server.close(); } catch { /* ignore */ }
    }
    // 浏览器标签页/keep-alive 连接可能让 Node 不退出；这里显式退出
    const code = process.exitCode || 0;
    setTimeout(() => process.exit(code), 150).unref();
  }
})();
