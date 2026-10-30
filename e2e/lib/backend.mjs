// e2e/lib/backend.mjs — 在 e2e 进程内拉起/关闭后端（server/index.mjs），stdio 不用管道
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './cdp.mjs';

/** 启动后端；返回句柄。日志写 logDir/backend.{stdout,stderr}.log。 */
export function startBackend({ cwd, port = 18270, logDir, env = {}, entry = 'server/index.mjs' }) {
  const entryPath = path.join(cwd, entry);
  if (!fs.existsSync(entryPath)) {
    const err = new Error('后端入口不存在: ' + entryPath + '（Lead 的 server/ 尚未就绪）');
    err.code = 'BACKEND_MISSING';
    throw err;
  }
  fs.mkdirSync(logDir, { recursive: true });
  const outPath = path.join(logDir, 'backend.stdout.log');
  const errPath = path.join(logDir, 'backend.stderr.log');
  const outFd = fs.openSync(outPath, 'a');
  const errFd = fs.openSync(errPath, 'a');
  const child = spawn(process.execPath, [entry], {
    cwd,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    // 后端 JSON 日志默认写到本次运行目录（server/index.mjs 用 BACKEND_LOG_FILE；seekdb 打开后 stdout 会失效）
    env: { ...process.env, PORT: String(port), BACKEND_LOG_FILE: path.join(logDir, 'backend.log'), ...env },
  });
  const handle = { child, port, baseUrl: 'http://127.0.0.1:' + port, outPath, errPath, startedAt: Date.now(), outFd, errFd };
  child.__spawnError = null;
  child.on('error', (e) => { child.__spawnError = e; });
  child.on('exit', (code, signal) => { child.__exitInfo = { code, signal, ms: Date.now() - handle.startedAt }; });
  // 注意：**不能**在父进程里立即 close 这两个 fd。Windows 上 seekdb 原生插件会重定向/接管 stdout/stderr，
  // 父进程过早关闭会导致后端进程后来写日志报 EBADF 崩溃（2026-10-31 实测）。统一在 stopBackend 里关闭。
  return handle;
}

/** 轮询 /api/health 直到后端就绪（或超时/进程退出）。 */
export async function waitForHealth(handle, { timeoutMs = 120000, path: healthPath = '/api/health', onTick = null } = {}) {
  const url = handle.baseUrl + healthPath;
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    const { child } = handle;
    if (child.__spawnError) throw new Error('后端 spawn 失败: ' + child.__spawnError.message);
    if (child.__exitInfo) {
      const tail = readTail(handle.errPath, 3000) + readTail(handle.outPath, 1000);
      throw new Error('后端进程提前退出（code=' + child.__exitInfo.code + '）\n--- backend stderr ---\n' + tail);
    }
    try {
      const r = await fetch(url);
      if (r.ok) {
        const body = await r.json().catch(() => null);
        handle.health = body;
        return body;
      }
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
    if (onTick) onTick(Date.now());
    await sleep(300);
  }
  throw new Error('等待后端 /api/health 超时 ' + timeoutMs + 'ms' + (lastErr ? ' / last: ' + lastErr.message : ''));
}

function readTail(file, maxBytes) {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
  } catch { return ''; }
}

export async function stopBackend(handle) {
  if (!handle || !handle.child) return;
  const { child } = handle;
  const closeFds = () => {
    for (const fd of [handle.outFd, handle.errFd]) {
      if (typeof fd === 'number') { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
    handle.outFd = null;
    handle.errFd = null;
  };
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
  closeFds();
  await sleep(200);
}
