/**
 * 应用级操作：把 Worker 向量化 + 后端 API + 全局状态串起来。
 * 面板与 window.__stepkb 钩子都调用这里，保证两条路径行为一致。
 */

import { api, ApiError, errorMessage } from './api';
import { store } from './appStore';
import type { EmbeddingClient } from './embedClient';
import { contentId } from './format';
import type {
  DbInfoResponse,
  HealthResponse,
  ImportDoc,
  ImportSummary,
  KbInfo,
  KbStatsResponse,
  RefreshResponse,
  SearchMode,
  SearchResultView,
  SearchTimings,
} from './types';

const EMBED_BATCH = 16;
const WRITE_BATCH = 64;

let client: EmbeddingClient | null = null;

export function setEmbeddingClient(c: EmbeddingClient): void {
  client = c;
}

export function getEmbeddingClient(): EmbeddingClient {
  if (!client) throw new Error('EmbeddingClient 未初始化');
  return client;
}

export function isModelReady(): boolean {
  return client?.state.status === 'ready';
}

/* ------------------------------ 健康 / 知识库 ------------------------------ */

export async function checkHealth(): Promise<HealthResponse | null> {
  try {
    const health = await api.health();
    store.db = { status: 'ok', health, error: null };
    store.notify();
    return health;
  } catch (err) {
    store.db = { status: 'error', health: null, error: errorMessage(err) };
    store.notify();
    return null;
  }
}

export async function refreshKbList(): Promise<KbInfo[]> {
  const res = await api.listKbs();
  store.kbs = res.kbs ?? [];
  store.notify();
  return store.kbs;
}

/** 按 id 或 name 解析知识库；不传则用当前激活库。 */
export function resolveKb(ref?: string | null): KbInfo {
  const list = store.kbs;
  if (ref) {
    const byId = list.find((kb) => kb.id === ref);
    if (byId) return byId;
    const byName = list.find((kb) => kb.name === ref);
    if (byName) return byName;
    throw new Error('找不到知识库：' + ref + '（现有：' + list.map((k) => k.id + '/' + k.name).join('、') + '）');
  }
  const active = store.activeKb();
  if (active) return active;
  throw new Error('尚未选择知识库，请先新建或选择');
}

export function currentModelDim(): number {
  const info = client?.state.info;
  return info && info.dim > 0 ? info.dim : 512; // bge-small-zh-v1.5 实际为 512 维（config.json hidden_size=512）
}

export async function createKb(name: string): Promise<KbInfo> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('知识库名称不能为空');
  const res = await api.createKb({ name: trimmed, dim: currentModelDim(), model: 'bge-small-zh-v1.5' });
  const kb = res.kb;
  await refreshKbList();
  store.setActiveKb(kb.id);
  store.log('ok', '知识库就绪：' + kb.name + '（' + kb.id + '）', undefined, 'db');
  await loadStats(kb.id).catch(() => undefined);
  return store.kbs.find((k) => k.id === kb.id) ?? kb;
}

export async function deleteKb(id: string): Promise<{ ok: boolean }> {
  const res = await api.deleteKb(id);
  if (store.activeKbId === id) store.setActiveKb(null);
  await refreshKbList();
  const next = store.kbs[0];
  if (next) store.setActiveKb(next.id);
  store.notify();
  store.log('ok', '已删除知识库 ' + id, undefined, 'db');
  return res;
}

export async function loadStats(kbId: string): Promise<KbStatsResponse | null> {
  try {
    const stats = await api.stats(kbId);
    if (store.activeKbId === kbId) {
      store.stats = stats;
      store.notify();
    }
    return stats;
  } catch (err) {
    store.log('warn', '读取 /stats 失败：' + errorMessage(err), undefined, 'db');
    return null;
  }
}

export async function loadDbInfo(): Promise<DbInfoResponse | null> {
  try {
    const info = await api.dbInfo();
    store.dbInfo = info;
    store.notify();
    return info;
  } catch (err) {
    store.log('warn', '读取 /api/db/info 失败：' + errorMessage(err), undefined, 'db');
    return null;
  }
}

export async function selectKb(kbId: string): Promise<void> {
  store.setActiveKb(kbId);
  store.stats = null;
  store.notify();
  await loadStats(kbId).catch(() => undefined);
}

function updateKbDocCount(kbId: string, docCount: number): void {
  const kb = store.kbs.find((k) => k.id === kbId);
  if (kb) kb.docCount = docCount;
  store.notify();
}

/* --------------------------------- 导入 --------------------------------- */

function setImportProgress(patch: Partial<NonNullable<typeof store.importProgress>>): void {
  store.importProgress = {
    phase: 'embed',
    vectorized: 0,
    written: 0,
    total: 0,
    embedMs: 0,
    writeMs: 0,
    message: '',
    ...(store.importProgress ?? {}),
    ...patch,
  };
  store.notify();
}

export interface ImportInputItem {
  id?: string;
  text: string;
  category?: string;
  meta?: Record<string, unknown>;
}

/**
 * 浏览器内向量化 → 分批写入 seekdb → 刷新索引。
 * embed 每批 16 篇（Worker 内再按 batchSize 细分），写库每批 64 篇（服务端 100/事务）。
 */
export async function importTexts(
  kbId: string,
  input: Array<string | ImportInputItem>,
): Promise<ImportSummary> {
  const kb = resolveKb(kbId);
  const embedClient = getEmbeddingClient();
  if (embedClient.state.status !== 'ready') {
    throw new Error('模型尚未就绪，无法在浏览器内向量化');
  }

  const normalized: ImportInputItem[] = [];
  for (const raw of input) {
    const item = typeof raw === 'string' ? { text: raw } : raw;
    const text = (item.text ?? '').trim();
    if (!text) continue;
    normalized.push({ ...item, text });
  }
  if (normalized.length === 0) throw new Error('没有可导入的非空文本');

  for (const item of normalized) {
    if (!item.id) item.id = await contentId(item.text);
  }

  const total = normalized.length;
  const startedAt = performance.now();
  let vectorized = 0;
  let written = 0;
  let embedMsTotal = 0;
  let writeMsTotal = 0;
  let refreshMsTotal = 0;
  let batches = 0;

  let pendingDocs: ImportDoc[] = [];
  let pendingVectors: number[][] = [];

  setImportProgress({
    phase: 'embed',
    vectorized: 0,
    written: 0,
    total,
    embedMs: 0,
    writeMs: 0,
    message: '开始向量化 0/' + total,
  });
  store.log('info', '开始导入 ' + total + ' 篇 → ' + kb.name, { kbId: kb.id }, 'import');

  const flush = async (): Promise<void> => {
    if (pendingDocs.length === 0) return;
    setImportProgress({ phase: 'write', message: '写入 seekdb：' + written + '/' + total });
    const res = await api.importDocs(kb.id, {
      docs: pendingDocs,
      vectors: pendingVectors,
      batchId: 'imp-' + Date.now(),
    });
    written += res.inserted;
    writeMsTotal += res.writeMs;
    refreshMsTotal += res.refreshMs;
    batches += 1;
    pendingDocs = [];
    pendingVectors = [];
    setImportProgress({ phase: 'write', written, message: '已写入 ' + written + '/' + total });
  };

  for (let i = 0; i < normalized.length; i += EMBED_BATCH) {
    const chunk = normalized.slice(i, i + EMBED_BATCH);
    const tEmbed = performance.now();
    const result = await embedClient.embed(
      chunk.map((c) => c.text),
      { batchSize: 8 },
    );
    embedMsTotal += result.embedMs > 0 ? result.embedMs : performance.now() - tEmbed;
    if (result.vectors.length !== chunk.length) {
      throw new Error('向量数量与文本数量不一致：' + result.vectors.length + ' vs ' + chunk.length);
    }
    chunk.forEach((item, idx) => {
      pendingDocs.push({
        id: item.id,
        text: item.text,
        category: item.category,
        meta: item.meta,
      });
      pendingVectors.push(result.vectors[idx]);
    });
    vectorized = Math.min(total, i + chunk.length);
    setImportProgress({
      phase: 'embed',
      vectorized,
      written,
      embedMs: embedMsTotal,
      writeMs: writeMsTotal,
      message: '已向量化 ' + vectorized + '/' + total + '（' + result.dim + ' 维）',
    });
    if (pendingDocs.length >= WRITE_BATCH) await flush();
  }
  await flush();

  setImportProgress({ phase: 'refresh', vectorized: total, written, message: '显式刷新索引（就绪探针）' });
  const refresh = await api.refresh(kb.id);
  refreshMsTotal += refresh.refreshMs;
  updateKbDocCount(kb.id, refresh.docCount);

  const totalMs = performance.now() - startedAt;
  const summary: ImportSummary = {
    kbId: kb.id,
    docs: total,
    batches,
    vectorizeMs: embedMsTotal,
    writeMs: writeMsTotal,
    refreshMs: refreshMsTotal,
    totalMs,
    inserted: written,
    at: Date.now(),
    ids: normalized.map((item) => item.id as string),
  };
  store.lastImport = summary;
  setImportProgress({
    phase: 'idle',
    vectorized: total,
    written,
    total,
    embedMs: embedMsTotal,
    writeMs: writeMsTotal,
    message: '完成：写入 ' + written + ' 篇',
  });
  store.log(
    'ok',
    '导入完成：' + written + '/' + total + ' 篇，向量化 ' + embedMsTotal.toFixed(0) + 'ms，写入 ' + writeMsTotal.toFixed(0) + 'ms，刷新 ' + refreshMsTotal.toFixed(1) + 'ms',
    { docCount: refresh.docCount },
    'import',
  );
  await loadStats(kb.id).catch(() => undefined);
  return summary;
}

/* --------------------------------- 检索 --------------------------------- */

export async function search(
  kbId: string,
  req: { mode: SearchMode; query: string; k?: number },
): Promise<SearchResultView> {
  const kb = resolveKb(kbId);
  const query = (req.query ?? '').trim();
  if (!query) throw new Error('查询不能为空');
  const mode = req.mode ?? 'hybrid';
  const k = req.k ?? 10;
  const embedClient = getEmbeddingClient();

  const t0 = performance.now();
  let vector: number[] | undefined;
  let embedMs = 0;
  if (mode !== 'fulltext') {
    if (embedClient.state.status !== 'ready') throw new Error('模型尚未就绪，无法向量化查询');
    const embedded = await embedClient.embed([query]);
    vector = embedded.vectors[0];
    embedMs = embedded.embedMs;
  }
  const t1 = performance.now();
  const response = await api.search(kb.id, { mode, query, vector, k });
  const t2 = performance.now();

  const timings: SearchTimings = {
    embedMs,
    dbMs: response.dbMs,
    apiMs: t2 - t1,
    e2eMs: t2 - t0,
  };
  const view: SearchResultView = {
    request: { mode, query, k },
    response,
    timings,
    at: Date.now(),
    kbId: kb.id,
  };
  store.lastSearch = view;
  store.notify();
  store.log(
    'info',
    '检索[' + mode + '] "' + query.slice(0, 24) + '" → ' + response.rows.length + ' 条；向量化 ' + embedMs.toFixed(1) + 'ms，SQL ' + response.dbMs.toFixed(1) + 'ms，端到端 ' + timings.e2eMs.toFixed(1) + 'ms',
    undefined,
    'search',
  );
  return view;
}

/* ------------------------------ 刷新索引 ------------------------------- */

export async function refreshIndex(kbId?: string): Promise<RefreshResponse> {
  const kb = resolveKb(kbId);
  const res = await api.refresh(kb.id);
  updateKbDocCount(kb.id, res.docCount);
  await loadStats(kb.id).catch(() => undefined);
  store.log('ok', '索引刷新完成：' + res.docCount + ' 篇，耗时 ' + res.refreshMs.toFixed(1) + 'ms', undefined, 'db');
  return res;
}

/* ------------------------------ 启动细节 ------------------------------- */

/** 刷新知识库列表并恢复到上次选择；不自动创建知识库。 */
export async function bootKbSelection(): Promise<void> {
  await refreshKbList();
  const remembered = store.restoreKbChoice();
  const active = store.activeKb();
  if (active) return;
  const pick = (remembered && store.kbs.find((k) => k.id === remembered)) || store.kbs[0] || null;
  if (pick) store.setActiveKb(pick.id);
}

export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return errorMessage(err);
}
