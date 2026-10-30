// e2e/lib/chrome.mjs — 手动拉起/关闭 Chrome（stdio 全部不走管道，规避沙箱 EPERM）
// 重要结论（2026-10-31 实测，见 e2e/README.md）：本机 agent 沙箱禁止创建命名管道，
// Chromium 的 Mojo IPC 依赖命名管道，因此 **在 agent 沙箱内 Chrome/Edge 无法启动**（crashpad OpenProcess 拒绝访问
// + FATAL mojo platform_channel.cc Check failed）。
// 本模块提供两种模式：
//   1) launchChrome：在「非沙箱」环境（评审机/人类终端）自行拉起 Chrome；
//   2) attachChrome：连一个已在沙箱外运行、带 --remote-debugging-port 的 Chrome（agent 内可用）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { waitForDevtools, sleep } from './cdp.mjs';

export const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const BASE_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-component-update',
  '--disable-extensions',
  '--disable-breakpad',
  '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
  '--force-device-scale-factor=1',
  '--window-size=1440,900',
  '--hide-scrollbars',
];

/** 沙箱内启动失败的固定特征，用于给出可读的「环境限制，不是功能失败」结论。 */
export function classifyLaunchFailure(errorText) {
  const text = String(errorText || '');
  if (text.includes('EPERM') || text.includes('platform_channel.cc') || text.includes('crashpad_client_win.cc')) {
    return {
      code: 'SANDBOX_BLOCKS_BROWSER',
      message: 'agent 沙箱禁止创建命名管道，Chromium Mojo IPC 无法初始化 → Chrome 在沙箱内无法启动（环境限制，不是用例失败）',
      hint: '在沙箱外终端运行 e2e/launch-chrome.ps1（或按 README 的命令）起 Chrome，再用 --cdp-url attach',
    };
  }
  return { code: 'BROWSER_LAUNCH_FAILED', message: text.slice(0, 500), hint: '检查 CHROME_PATH / Chrome 是否可执行' };
}

/**
 * 启动 Chrome 并等待 CDP 端口就绪。
 * @param {{port:number, headless?:boolean, userDataDir:string, extraArgs?:string[], logDir?:string, exe?:string, timeoutMs?:number}} opts
 */
export async function launchChrome({ port, headless = true, userDataDir, extraArgs = [], logDir = null, exe = CHROME_PATH, timeoutMs = 30000 }) {
  if (!fs.existsSync(exe)) throw new Error('浏览器不存在: ' + exe);
  fs.mkdirSync(userDataDir, { recursive: true });
  const dir = logDir || userDataDir;
  fs.mkdirSync(dir, { recursive: true });
  const outFd = fs.openSync(path.join(dir, 'chrome.stdout.log'), 'a');
  const errFd = fs.openSync(path.join(dir, 'chrome.stderr.log'), 'a');
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, ...BASE_ARGS];
  if (headless) args.push('--headless=new');
  args.push(...extraArgs);
  const child = spawn(exe, args, { stdio: ['ignore', outFd, errFd], detached: false, windowsHide: true });
  const handle = { child, port, userDataDir, args, exe, logDir: dir, outFd, errFd };
  child.on('error', (e) => { child.__spawnError = e; });
  child.on('exit', (code, signal) => { child.__exitInfo = { code, signal, ms: Date.now() - handle.startedAt }; });
  handle.startedAt = Date.now();
  try {
    const { info, endpoint } = await waitForDevtools(port, { timeoutMs, child });
    handle.info = info;
    handle.endpoint = endpoint;
    handle.version = info.Browser || info['User-Agent'];
    return handle;
  } catch (e) {
    const stderr = fs.existsSync(path.join(dir, 'chrome.stderr.log')) ? fs.readFileSync(path.join(dir, 'chrome.stderr.log'), 'utf8') : '';
    const classified = classifyLaunchFailure(stderr + ' ' + e.message);
    const err = new Error(classified.message + ' | 底层: ' + e.message + ' | chrome stderr: ' + stderr.split(/\r?\n/).filter(Boolean).slice(0, 4).join(' ; '));
    err.code = classified.code;
    err.hint = classified.hint;
    err.chromeStderr = stderr;
    try { await killChrome(handle, { removeProfile: false }); } catch { /* ignore */ }
    throw err;
  } finally {
    try { fs.closeSync(outFd); } catch { /* ignore */ }
    try { fs.closeSync(errFd); } catch { /* ignore */ }
  }
}

/** 连接一个已经在运行（通常由沙箱外终端启动）的 Chrome，返回 { endpoint, info }。 */
export async function attachChrome(cdpUrl) {
  const m = /^http:\/\/([^/:]+):(\d+)\/?$/.exec(String(cdpUrl).trim());
  if (!m) throw new Error('--cdp-url 需形如 http://127.0.0.1:19222，收到: ' + cdpUrl);
  const port = Number(m[2]);
  const { info, endpoint } = await waitForDevtools(port, { timeoutMs: 15000 });
  return { mode: 'attach', port, endpoint, info, version: info.Browser || info['User-Agent'] };
}

/** 关闭 Chrome：先正常退出，再按进程树强杀，最后清理临时 profile。 */
export async function killChrome(handle, { removeProfile = true } = {}) {
  if (!handle || !handle.child) return;
  const { child, port, userDataDir } = handle;
  try { await fetch(`http://127.0.0.1:${port}/json/close`, { method: 'GET' }).catch(() => {}); } catch { /* ignore */ }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const t = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
  await new Promise((resolve) => {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    k.once('exit', resolve);
    k.once('error', resolve);
  });
  await sleep(200);
  if (removeProfile && userDataDir) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
