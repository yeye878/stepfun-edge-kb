// e2e/lib/page.mjs — 用 CDP 打开/操作一个页面（不依赖 Playwright，attach 模式也适用）
import fs from 'node:fs';
import path from 'node:path';
import { CDP, newPageTarget } from './cdp.mjs';

/**
 * 在已就绪的 Chrome 调试端口上新建页面并导航。
 * @param {{port:number, url:string, viewport?:{width:number,height:number}, loadTimeoutMs?:number, logDir?:string, preloadScripts?:string[]}} opts
 *   preloadScripts 会在页面脚本执行前注入（Page.addScriptToEvaluateOnNewDocument），
 *   用于构造「WebGPU 不可用」环境（Chrome 156 的 --disable-features=WebGPU 已失效，见 README）。
 */
export async function openPage({ port, url, viewport = { width: 1440, height: 900 }, loadTimeoutMs = 30000, logDir = null, preloadScripts = [] }) {
  const target = await newPageTarget(port, 'about:blank');
  const targetId = target.id;
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const consoleErrors = [];
  const consoleTexts = [];
  const exceptions = [];
  cdp.listeners.add((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      consoleTexts.push({ type: msg.params.type, text: String(text).slice(0, 1000) });
      if (msg.params.type === 'error') consoleErrors.push(String(text).slice(0, 1000));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      exceptions.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown').slice(0, 1500));
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // ---- 网络请求采集（页面 + Web Worker/Service Worker，用 Target.setAutoAttach 自动挂 worker）----
  const network = [];
  const byRequestId = new Map();
  const workerSessions = new Map();
  cdp.listeners.add((msg) => {
    if (msg.method === 'Target.attachedToTarget') {
      const info = msg.params.targetInfo || {};
      const sid = msg.params.sessionId;
      if (sid) {
        workerSessions.set(sid, (info.type || 'worker') + ':' + (info.url || ''));
        // 子 target 也要开 Network，才能看到 Worker 内部的模型/静态资源请求
        cdp.send('Network.enable', {}, { sessionId: sid }).catch(() => {});
      }
      return;
    }
    if (msg.method === 'Network.requestWillBeSent') {
      const req = msg.params.request || {};
      const rec = {
        requestId: msg.params.requestId,
        session: msg.sessionId || null,
        source: msg.sessionId ? (workerSessions.get(msg.sessionId) || 'worker') : 'page',
        method: req.method,
        url: req.url,
        type: msg.params.type || null,
        ts: Date.now(),
      };
      network.push(rec);
      byRequestId.set(msg.params.requestId, rec);
      return;
    }
    if (msg.method === 'Network.responseReceived') {
      const rec = byRequestId.get(msg.params.requestId);
      if (rec) {
        rec.status = msg.params.response ? msg.params.response.status : null;
        rec.mimeType = msg.params.response ? msg.params.response.mimeType : null;
        rec.remoteIPAddress = msg.params.response && msg.params.response.remoteIPAddress ? msg.params.response.remoteIPAddress : null;
      }
    }
  });
  await cdp.send('Network.enable');
  try {
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  } catch (e) { /* 老版本不支持时忽略，仅丢 worker 请求 */ }

  if (viewport) await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
  const preloadIds = [];
  for (const source of preloadScripts) {
    const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
    preloadIds.push(r.identifier);
  }
  const loaded = cdp.waitEvent('Page.loadEventFired', { timeoutMs: loadTimeoutMs });
  const nav = await cdp.send('Page.navigate', { url });
  if (nav.errorText) throw new Error('导航失败: ' + nav.errorText + ' / url=' + url);
  await loaded;

  const page = {
    cdp,
    url,
    port,
    targetId,
    consoleErrors,
    consoleTexts,
    exceptions,
    preloadScripts,
    closed: false,

    async evaluate(expression, { awaitPromise = true, timeoutMs = 120000 } = {}) {
      const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true, timeout: timeoutMs }, { timeoutMs: timeoutMs + 15000 });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        const detail = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown';
        throw new Error('页面内异常: ' + String(detail).slice(0, 1500));
      }
      return res.result ? res.result.value : undefined;
    },

    async screenshot(file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      return file;
    },

    /** 轮询页面内的布尔表达式直到为 true；超时抛错（带当前页面摘要）。 */
    async waitFor(expression, { timeoutMs = 60000, intervalMs = 250, label = null } = {}) {
      const deadline = Date.now() + timeoutMs;
      let lastErr = null;
      while (Date.now() < deadline) {
        try {
          const ok = await this.evaluate('(function(){ try { return !!(' + expression + '); } catch (e) { return false; } })()', { awaitPromise: false, timeoutMs: 10000 });
          if (ok) return true;
        } catch (e) { lastErr = e; }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      const info = await this.evaluate('({ url: location.href, title: document.title, body: (document.body && document.body.innerText || "").slice(0, 500) })', { awaitPromise: false }).catch(() => null);
      throw new Error('等待页面条件超时 ' + timeoutMs + 'ms: ' + (label || expression) + (lastErr ? ' / last: ' + lastErr.message : '') + ' / page=' + JSON.stringify(info));
    },

    /** 取页面可见文本（用于状态栏断言与证据）。 */
    async visibleText() {
      return this.evaluate('(document.body && document.body.innerText || "").slice(0, 8000)', { awaitPromise: false });
    },

    /** 网络请求清单（含 Worker 内请求），用于证明无云端推理 API 调用。 */
    networkSummary() {
      const byHost = {};
      const bySource = {};
      for (const r of network) {
        let host = '(opaque)';
        try { const u = new URL(r.url); host = u.host || '(no-host)'; } catch (e) { /* ignore */ }
        byHost[host] = (byHost[host] || 0) + 1;
        bySource[r.source] = (bySource[r.source] || 0) + 1;
      }
      return { total: network.length, byHost, bySource, requests: network.slice(0, 500) };
    },

    /** 把页面元素滚动到视口中间（截图证据用）。 */
    async scrollTo(selector) {
      return this.evaluate('(function(){ var el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; el.scrollIntoView({ block: "center" }); return true; })()', { awaitPromise: false, timeoutMs: 10000 });
    },

    /** 关闭页面 target（attach 模式下只关自己开的标签页，不影响 Lead 的 Chrome 实例）。 */
    async close() {
      if (this.closed) return;
      this.closed = true;
      for (const id of preloadIds) { try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }, { timeoutMs: 3000 }); } catch { /* ignore */ } }
      cdp.close();
      // 通过 HTTP 端点关掉 target，避免在外部浏览器里残留标签页
      try { await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`); } catch { /* ignore */ }
    },
  };
  return page;
}
