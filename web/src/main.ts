/**
 * StepKB 入口：装配 UI、启动端侧模型、暴露自动化测试钩子 window.__stepkb。
 *
 * 合规自证：
 * - 向量只在浏览器 Worker 内计算（embedding 模型同源自托管）；
 * - 后端只做 SQL 转发；检索由 seekdb 内单条 SQL 完成；
 * - 不调用任何云端推理 API。
 */

import './styles.css';
import { store } from './appStore';
import { EmbeddingClient, detectWebgpu } from './embedClient';
import { qs } from './dom';
import { fmtMs } from './format';
import { api } from './api';
import * as services from './services';
import { bootKbSelection, checkHealth, describeApiError, loadDbInfo, loadStats, resolveKb } from './services';
import type {
  HookImportResult,
  HookSearchResult,
  ImportSummary,
  KbInfo,
  RefreshResponse,
  SearchMode,
  StepKbHooks,
  StepKbLogEntry,
  StepKbSummaryState,
} from './types';
import { setupStatusBar } from './ui/statusBar';
import { setupBanner } from './ui/banner';
import { setupImportPanel } from './ui/importPanel';
import { setupSearchPanel } from './ui/searchPanel';
import { setupDataPanel } from './ui/dataPanel';
import { setupBenchPanel } from './ui/benchPanel';
import { toast } from './ui/toast';

declare global {
  interface Window {
    __stepkb?: StepKbHooks;
    __stepkbVersion?: number;
  }
}

const client = new EmbeddingClient();
services.setEmbeddingClient(client);

const params = new URLSearchParams(location.search);
const allowStub = params.get('stub') === '1';

/* ------------------------------- 面板装配 ------------------------------- */

const statusBar = setupStatusBar(qs('#status-strip'));
const importPanel = setupImportPanel(qs('#import-body'));
const searchPanel = setupSearchPanel(qs('#search-body'), qs('#search-mode-flag'));
const dataPanel = setupDataPanel(qs('#data-body'), qs('#btn-refresh-index'));
const benchPanel = setupBenchPanel(qs('#bench-body'), qs('#btn-bench-run'), qs('#btn-bench-export'));
const banner = setupBanner(qs('#banner-slot'), {
  retryModel: () => void initModel(),
  retryDb: () => void bootBackend(),
});

function renderAll(): void {
  statusBar.render();
  banner.render();
  importPanel.render();
  searchPanel.render();
  dataPanel.render();
  benchPanel.render();
  renderFooter();
}

store.subscribe(renderAll);

function renderFooter(): void {
  const footer = document.getElementById('footer-env');
  if (!footer) return;
  const info = store.model.info;
  const bits = [
    'crossOriginIsolated=' + (window.crossOriginIsolated === true),
    'WebGPU=' + (store.webgpu?.available ? (store.webgpu.fp16 ? '可用' : '无 shader-f16') : '不可用'),
    info && !info.stub ? 'WASM 线程=' + (info.wasmThreads ?? '—') : '',
    'UA=' + (navigator.userAgent.includes('HeadlessChrome') ? 'HeadlessChrome' : 'Chrome'),
  ].filter(Boolean);
  footer.textContent = bits.join(' · ');
}

/* -------------------------------- 启动 -------------------------------- */

client.onState = (state) => {
  store.model = state;
  store.notify();
};

let resolveReady: (() => void) | null = null;
const readyPromise = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

async function initModel(): Promise<void> {
  store.setBusy('model', true);
  store.log('info', '开始加载端侧模型（降级链：WebGPU+FP16 → WASM+Q8 → WASM+INT8）', undefined, 'model');
  try {
    const info = await client.init({ allowStub });
    store.model = client.state;
    store.log(
      'ok',
      '模型就绪：' + (info.stub ? '桩模式' : info.backend + ' / ' + info.dtype) +
        '，加载 ' + fmtMs(info.loadMs) + '，预热 ' + fmtMs(info.warmupMs) +
        (info.onnxBytes ? '，ONNX ' + (info.onnxBytes / 1e6).toFixed(2) + ' MB' : ''),
      { onnxBytes: info.onnxBytes, compressionRatio: info.compressionRatio, fallbackReason: store.model.fallbackReason },
      'model',
    );
  } catch (err) {
    store.model = client.state;
    store.log('err', '模型加载失败：' + describeApiError(err), { attempts: store.model.attempts }, 'model');
  } finally {
    store.setBusy('model', false);
    store.notify();
    renderAll();
  }
}

async function bootBackend(): Promise<void> {
  const health = await checkHealth();
  if (!health) {
    store.log('err', '后端不可达：' + (store.db.error ?? ''), undefined, 'db');
    return;
  }
  store.log('ok', 'seekdb 就绪：' + health.dbVersion + '（' + health.dbMode + '）', undefined, 'db');
  try {
    await bootKbSelection();
    const kb = store.activeKb();
    if (kb) await loadStats(kb.id).catch(() => null);
    await loadDbInfo();
    store.log('info', '知识库列表：' + store.kbs.length + ' 个' + (store.activeKb() ? '，当前 ' + store.activeKb()!.name : ''), undefined, 'db');
  } catch (err) {
    store.log('err', '加载知识库失败：' + describeApiError(err), undefined, 'db');
  }
}

async function boot(): Promise<void> {
  store.log('info', 'StepKB 启动：浏览器本地向量化 + seekdb 混合检索', undefined, 'ui');
  try {
    const cap = await detectWebgpu();
    store.webgpu = cap;
    store.notify();
    if (!cap.available) {
      store.log('warn', 'WebGPU 不可用：' + (cap.reason ?? '未知原因') + '（将使用 WASM）', undefined, 'model');
    } else if (!cap.fp16) {
      store.log('warn', 'WebGPU 不支持 shader-f16：' + (cap.reason ?? '') + '（将使用 WASM）', undefined, 'model');
    } else {
      store.log('info', 'WebGPU 可用（shader-f16 ✅）' + (cap.adapter ? '，适配器：' + cap.adapter : ''), undefined, 'model');
    }
  } catch (err) {
    store.log('warn', 'WebGPU 预检异常：' + describeApiError(err), undefined, 'model');
  }

  await Promise.allSettled([initModel(), bootBackend()]);

  store.ready = true;
  store.notify();
  renderAll();
  store.log('ok', '应用就绪', undefined, 'ui');
  resolveReady?.();
  resolveReady = null;

  // 后端状态轮询（只更新状态，不打扰用户）
  let lastDbStatus = store.db.status;
  window.setInterval(() => {
    const prev = store.db.status;
    void checkHealth().then(() => {
      if (store.db.status !== prev) {
        if (store.db.status === 'ok' && lastDbStatus !== 'ok') {
          store.log('ok', '后端已连接', undefined, 'db');
          void bootBackend();
        } else if (store.db.status === 'error') {
          store.log('warn', '后端连接中断', undefined, 'db');
        }
      }
      lastDbStatus = store.db.status;
    });
  }, 20_000);
}

/* ------------------------------ 测试钩子 ------------------------------ */

function currentKbId(ref?: string | null): string {
  return resolveKb(ref ?? null).id;
}

function summaryState(): StepKbSummaryState {
  const kb = store.activeKb();
  return {
    ready: store.ready,
    backend: store.model.backend,
    dtype: store.model.dtype,
    fallbackReason: store.model.fallbackReason,
    dbOk: store.db.status === 'ok',
    docCount: kb?.docCount ?? 0,
    currentKb: kb?.id,
    modelStatus: store.model.status,
    stub: store.model.stub,
    searchMode: store.lastSearch?.response.mode ?? null,
  };
}

function isLegacyImportArgs(arg0: unknown, arg1: unknown): boolean {
  return typeof arg0 === 'string' && Array.isArray(arg1);
}

async function hookImportTexts(arg0: unknown, arg1?: unknown): Promise<HookImportResult | ImportSummary> {
  if (isLegacyImportArgs(arg0, arg1)) {
    const kbId = currentKbId(arg0 as string);
    const summary = await services.importTexts(kbId, arg1 as string[]);
    return summary;
  }
  const opts = (arg1 ?? {}) as { kb?: string };
  const kbId = currentKbId(opts.kb ?? null);
  const texts = Array.isArray(arg0) ? (arg0 as Array<string | { id?: string; text: string }>) : [];
  const summary = await services.importTexts(kbId, texts);
  const result: HookImportResult = {
    inserted: summary.inserted,
    total: summary.docs,
    writeMs: summary.writeMs,
    refreshMs: summary.refreshMs,
  };
  return result;
}

function isLegacySearchArgs(arg0: unknown, arg1: unknown): boolean {
  return (
    typeof arg0 === 'string' &&
    arg1 != null &&
    typeof arg1 === 'object' &&
    !Array.isArray(arg1) &&
    typeof (arg1 as { query?: unknown }).query === 'string'
  );
}

async function hookSearch(
  arg0: unknown,
  arg1?: unknown,
  arg2?: unknown,
): Promise<HookSearchResult | { response: unknown; timings: unknown }> {
  if (isLegacySearchArgs(arg0, arg1)) {
    const kbId = currentKbId(arg0 as string);
    const opts = arg1 as { mode?: SearchMode; query: string; k?: number };
    const view = await services.search(kbId, {
      mode: opts.mode ?? 'hybrid',
      query: opts.query,
      k: opts.k,
    });
    return { response: view.response, timings: view.timings };
  }
  const kbId = currentKbId(null);
  const mode = (typeof arg1 === 'string' ? arg1 : 'hybrid') as SearchMode;
  const view = await services.search(kbId, {
    mode,
    query: String(arg0 ?? ''),
    k: typeof arg2 === 'number' ? arg2 : undefined,
  });
  return {
    rows: view.response.rows,
    sql: view.response.sql,
    dbMs: view.response.dbMs,
    queryEmbedMs: view.timings.embedMs,
  };
}

const hooks: StepKbHooks = {
  ready: () => readyPromise,
  state: () => summaryState(),
  getState: () => store.snapshot(),
  getLogs: (): StepKbLogEntry[] => store.getLogs(200),
  createKb: (name: string): Promise<KbInfo> => services.createKb(name),
  deleteKb: (id: string) => services.deleteKb(id),
  importTexts: hookImportTexts as StepKbHooks['importTexts'],
  search: hookSearch as StepKbHooks['search'],
  refresh: (kbId?: string): Promise<RefreshResponse> => services.refreshIndex(kbId ?? undefined),
  runBenchmark: (options) => {
    if (typeof options === 'string') return benchPanel.run(options);
    return benchPanel.run(options?.configs, options?.runs ?? 5);
  },
  getBenchmarkResult: () => store.benchmark,
};

window.__stepkb = hooks;
window.__stepkbVersion = 1;

/* 方便排查：把关键状态挂到 console */
(window as unknown as { stepkbDebug?: () => unknown }).stepkbDebug = () => {
  return {
    state: store.snapshot(),
    logs: store.getLogs(50),
    apiBase: location.origin + '/api',
  };
};

/* 启动 */
void boot();

/* 供其它模块/调试引用的导出 */
export { api, toast };
