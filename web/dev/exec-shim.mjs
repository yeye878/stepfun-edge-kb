/**
 * 沙箱兼容 shim：被 NODE_OPTIONS=--import 预加载时，把 child_process 的同步 EPERM 转成回调错误。
 *
 * 本机 DSH 沙箱禁止带 pipe 的 child_process（spawn EPERM），而 Vite 8 在 Windows 上会执行
 * exec("net use") 探测网络盘，导致 vite 在加载配置阶段失败。此 shim 只做兜底：
 * 原始实现优先调用，仅当它同步抛错时才改走回调；普通机器上行为完全不变。
 *
 * 用法见 src/.npmrc：node-options=--import=./web/dev/exec-shim.mjs（由 Lead 合入）
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');

function fakeChild() {
  return {
    pid: -1, stdout: null, stderr: null, stdin: null, stdio: [],
    on() { return this; }, once() { return this; }, off() { return this; },
    removeListener() { return this; }, kill() {}, unref() { return this; }, ref() { return this; },
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

if (process.env.STEPKB_SHIM_QUIET !== '1') {
  console.log('[stepkb sandbox shim] child_process EPERM 兜底已启用（仅影响受限沙箱）');
}
