/**
 * Vite 启动包装器（沙箱兼容）。
 *
 * 背景：本机 DSH 沙箱禁止带 pipe 的 child_process（spawn EPERM），而 Vite 8 在 Windows 上
 * 初始化时执行 `exec("net use")` 探测网络盘（vite/dist/node/chunks/node.js optimizeSafeRealPathSync），
 * 导致 `vite build` / `vite` 在加载配置阶段直接失败。
 *
 * 处理：在导入 vite 之前，把 child_process.exec/execFile 包成「同步失败则走回调」的版本——
 * 只影响 EPERM 这种启动失败，正常机器上行为与原版完全一致（原始实现优先调用）。
 * 这样 npm run build / npm run dev:web 在受限沙箱与普通机器上都能工作。
 *
 * 用法（package.json）：
 *   "build": "node web/dev/vite-run.mjs build"
 *   "dev:web": "node web/dev/vite-run.mjs serve"
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');

function fakeChild() {
  return {
    pid: -1,
    stdout: null,
    stderr: null,
    stdin: null,
    stdio: [],
    on() { return this; },
    once() { return this; },
    off() { return this; },
    removeListener() { return this; },
    kill() {},
    unref() { return this; },
    ref() { return this; },
  };
}

function patchExec(name) {
  const original = cp[name];
  if (typeof original !== 'function') return;
  cp[name] = function patched(...args) {
    try {
      return original.apply(this, args);
    } catch (err) {
      const cb = args.find((a) => typeof a === 'function');
      if (cb) queueMicrotask(() => cb(err, '', ''));
      return fakeChild();
    }
  };
}

patchExec('exec');
patchExec('execFile');

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..'); // src/
const webRoot = path.join(projectRoot, 'web');
const configFile = path.join(webRoot, 'vite.config.ts');

const mode = process.argv[2] === 'serve' ? 'serve' : 'build';
const vite = await import('vite');

if (mode === 'serve') {
  const server = await vite.createServer({ configFile, root: webRoot });
  await server.listen();
  server.printUrls();
  process.on('SIGINT', () => {
    server.close().then(() => process.exit(0));
  });
} else {
  await vite.build({ configFile, root: webRoot });
}
