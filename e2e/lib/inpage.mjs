// e2e/lib/inpage.mjs — 页面内可注入的探测表达式（探测与 e2e 共用，保证口径一致）

/**
 * 在页面脚本执行前隐藏 navigator.gpu，构造「浏览器不支持 WebGPU」的等价环境。
 * 用途：Chrome 156 实测 --disable-features=WebGPU 已被忽略（仍返回硬件 adapter），
 * 无法用启动参数得到真实的 WebGPU 不可用环境，故选 CDP 注入；evidence 中会如实标注为「模拟」。
 */
export const HIDE_WEBGPU_PRELOAD = `(() => {
  try { Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true }); } catch (e) { /* ignore */ }
})();`;

/** 在页面里探测 navigator.gpu / WebGL / WASM / 隔离环境，返回 JSON 可序列化对象。 */
export const ENV_PROBE_EXPR = `(async () => {
  const out = {
    ua: navigator.userAgent,
    isSecureContext: self.isSecureContext,
    crossOriginIsolated: self.crossOriginIsolated,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
  };
  const m = /Chrome\\/(\\d+)\\.([\\d.]+)/.exec(navigator.userAgent);
  out.chromeVersion = m ? m[1] + '.' + m[2] : null;
  out.gpu = { present: !!navigator.gpu };
  if (navigator.gpu) {
    try {
      const t0 = performance.now();
      const adapter = await navigator.gpu.requestAdapter();
      out.gpu.requestAdapterMs = Math.round((performance.now() - t0) * 10) / 10;
      out.gpu.adapter = !!adapter;
      if (adapter) {
        out.gpu.isFallbackAdapter = adapter.isFallbackAdapter ?? null;
        if (adapter.info) {
          out.gpu.info = {};
          for (const k of ['vendor', 'architecture', 'device', 'description']) {
            if (adapter.info[k] !== undefined) out.gpu.info[k] = adapter.info[k];
          }
        }
        try { out.gpu.features = Array.from(adapter.features); } catch (e) { out.gpu.features = []; }
        try {
          const t1 = performance.now();
          const device = await adapter.requestDevice();
          out.gpu.requestDeviceMs = Math.round((performance.now() - t1) * 10) / 10;
          out.gpu.device = !!device;
          try { device.destroy(); } catch (e) { /* ignore */ }
        } catch (e) {
          out.gpu.device = false;
          out.gpu.deviceError = String(e && e.message || e);
        }
      }
    } catch (e) {
      out.gpu.requestAdapterError = String(e && e.message || e);
    }
  }
  out.gpu.usable = !!(out.gpu.present && out.gpu.adapter && out.gpu.device);
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out.webgl = {
        version: gl.getParameter(gl.VERSION),
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      };
    }
  } catch (e) { out.webglError = String(e); }
  out.wasm = { supported: typeof WebAssembly === 'object' };
  try {
    out.wasm.simd = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
  } catch (e) { out.wasm.simd = false; }
  return out;
})()`;

/** 等待并读取 window.__stepkb 钩子（APP-CONTRACT 建议补充的 e2e 钩子）。 */
export const HOOK_PROBE_EXPR = `(async () => {
  const t0 = Date.now();
  while (!window.__stepkb && Date.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!window.__stepkb) return { hasHook: false };
  return {
    hasHook: true,
    keys: Object.keys(window.__stepkb),
    hasReady: typeof window.__stepkb.ready === 'function',
    hasState: typeof window.__stepkb.state === 'function',
    hasGetState: typeof window.__stepkb.getState === 'function',
    hasGetLogs: typeof window.__stepkb.getLogs === 'function',
    hasImportTexts: typeof window.__stepkb.importTexts === 'function',
    hasSearch: typeof window.__stepkb.search === 'function',
    hasRefresh: typeof window.__stepkb.refresh === 'function',
    hasCreateKb: typeof window.__stepkb.createKb === 'function',
    hasRunBenchmark: typeof window.__stepkb.runBenchmark === 'function',
  };
})()`;

/** 读取界面状态栏 / 后端徽标 / 降级横幅 / 检索结果（以 web 的 data-testid 为准）。 */
export const BADGE_PROBE_EXPR = `(() => {
  const pick = (sel) => { const el = document.querySelector(sel); return el ? (el.innerText || el.textContent || '').trim() : null; };
  const badgeEl = document.querySelector('[data-testid=backend-badge]');
  const badge = badgeEl ? {
    text: (badgeEl.innerText || badgeEl.textContent || '').trim(),
    backend: badgeEl.getAttribute('data-backend'),
    dtype: badgeEl.getAttribute('data-dtype'),
    title: badgeEl.getAttribute('title'),
    cls: badgeEl.className,
  } : null;
  const resultList = document.querySelector('[data-testid=result-list]');
  return {
    badge,
    statusBar: pick('[data-testid=status-bar]'),
    modelInfo: pick('[data-testid=model-info]'),
    dbStatus: pick('[data-testid=db-status]'),
    kbStatus: pick('[data-testid=kb-status]'),
    fallbackBanner: pick('[data-testid=fallback-banner]'),
    stubBanner: pick('[data-testid=stub-banner]'),
    modelErrorBanner: pick('[data-testid=model-error-banner]'),
    dbErrorBanner: pick('[data-testid=db-error-banner]'),
    importSummary: pick('[data-testid=import-summary]'),
    docCount: pick('[data-testid=doc-count]'),
    searchTimings: pick('[data-testid=search-timings]'),
    sampleSql: pick('[data-testid=sample-sql]'),
    resultCount: resultList ? resultList.children.length : null,
    resultListText: resultList ? (resultList.innerText || '').slice(0, 3000) : null,
    bodyText: ((document.body && document.body.innerText) || '').slice(0, 6000),
  };
})()`;
