// e2e/lib/cdp.mjs — 极简 CDP 客户端（只用 Node 内置全局 WebSocket，不依赖 child_process 管道）
// 背景：本机沙箱下 Node spawn 的默认 stdio:'pipe' 可能 EPERM（见 DEV-ENV.md / probe 结论），
// 因此浏览器由 stdio:'ignore' 方式手动拉起，再通过 --remote-debugging-port 的 WebSocket 驱动。

export class CDP {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`CDP error: ${msg.error.message} (code ${msg.error.code})`));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const l of this.listeners) { try { l(msg); } catch { /* listener errors are non-fatal */ } }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  static async connect(wsUrl, { timeoutMs = 20000 } = {}) {
    const ws = new WebSocket(wsUrl);
    const client = new CDP(ws);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket open timeout')), timeoutMs);
      const ok = () => { clearTimeout(timer); resolve(); };
      const fail = () => { clearTimeout(timer); reject(new Error('CDP WebSocket error (connect failed)')); };
      if (ws.readyState === 1) return ok();
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', fail, { once: true });
    });
    return client;
  }

  send(method, params = {}, { sessionId, timeoutMs = 60000 } = {}) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  waitEvent(method, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error(`CDP event timeout: ${method}`)); }, timeoutMs);
      const listener = (msg) => {
        if (msg.method === method) { clearTimeout(timer); this.listeners.delete(listener); resolve(msg.params); }
      };
      this.listeners.add(listener);
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询 http://host:port/json/version 直到 Chrome 调试端口就绪。 */
export async function waitForDevtools(port, { timeoutMs = 40000, child } = {}) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (child && child.__spawnError) {
      throw new Error(`chrome spawn failed: ${child.__spawnError.code || ''} ${child.__spawnError.message || ''}`);
    }
    if (child && (child.exitCode !== null || child.__exitInfo)) {
      const info = child.__exitInfo || { code: child.exitCode, signal: child.signalCode };
      throw new Error(`chrome 进程提前退出（code=${info.code}, signal=${info.signal || null}），调试端口未就绪`);
    }
    try {
      const r = await fetch(`${endpoint}/json/version`);
      if (r.ok) return { info: await r.json(), endpoint };
    } catch (e) { lastErr = e; }
    await sleep(250);
  }
  throw new Error(`等待 Chrome 调试端口 ${port} 超时 ${timeoutMs}ms${lastErr ? ' / last: ' + lastErr.message : ''}`);
}

/** 在已就绪的调试端口上新建一个页面 target 并返回其 webSocketDebuggerUrl。 */
export async function newPageTarget(port, url = 'about:blank') {
  const base = `http://127.0.0.1:${port}`;
  const tryFetch = async (method) => {
    const r = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method });
    const text = await r.text();
    if (!r.ok) throw new Error(`/json/new ${method} -> HTTP ${r.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    if (!j.webSocketDebuggerUrl) throw new Error('/json/new 未返回 webSocketDebuggerUrl: ' + text.slice(0, 200));
    return j;
  };
  try { return await tryFetch('PUT'); }
  catch (e) { try { return await tryFetch('GET'); } catch (e2) { throw new Error(`/json/new 失败: PUT=${e.message} | GET=${e2.message}`); } }
}
