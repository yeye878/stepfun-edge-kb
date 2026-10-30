/**
 * StepKB 共享类型：后端 API（APP-CONTRACT §3）、Worker 协议（§4）、评测结果。
 * 后端字段契约以 notes/APP-CONTRACT.md 为准，前端只读不改名。
 */

/* ------------------------------------------------------------------ */
/* 端侧推理                                                            */
/* ------------------------------------------------------------------ */

export type Device = 'webgpu' | 'wasm';
export type Dtype = 'fp32' | 'fp16' | 'int8' | 'q8';

export interface ModelConfig {
  device: Device;
  dtype: Dtype;
}

export interface ModelInfo {
  /** 固定自托管目录名 */
  modelId: string;
  /** 模型实际输出维度（bge-small-zh-v1.5 = 512；由推理输出实测，不写死） */
  dim: number;
  backend: Device;
  dtype: Dtype;
  /** pipeline 构造耗时（不含预热） */
  loadMs: number;
  /** 首次推理（含 shader 编译）耗时；-1 表示未测 */
  warmupMs: number;
  /** 本次 dtype 对应 onnx 文件实际字节数 */
  onnxBytes: number;
  /** q8 降级时记录 modelInfo 对应的真实文件；用于体积展示 */
  onnxFile?: string;
  /** fp32 基线字节数（已知时给出压缩比） */
  fp32Bytes?: number;
  compressionRatio?: number;
  /** WASM 线程数（ORT 运行时；null 表示未使用 wasm） */
  wasmThreads?: number | null;
  /** 页面是否 crossOriginIsolated（WASM 多线程前提） */
  crossOriginIsolated: boolean;
  /** WebGPU 适配器信息（若可用） */
  webgpuAdapter?: string;
  /** 池化/归一化方式（展示与自证） */
  pooling: 'cls';
  normalize: 'l2';
  /** 是否桩模式（仅开发联调，正常构建不应出现；真实推理为 false/undefined） */
  stub?: boolean;
}

export interface ModelRuntimeState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** 加载进度（0-100，null 表示不确定） */
  progress: number | null;
  progressText?: string;
  backend: Device | null;
  dtype: Dtype | null;
  fallbackReason: string | null;
  /** 尝试记录（降级链证据） */
  attempts: Array<{ config: ModelConfig; ok: boolean; reason?: string; ms?: number }>;
  info: ModelInfo | null;
  error: string | null;
  /** 是否处于桩模式（仅开发联调；正常构建不应出现） */
  stub: boolean;
}

/* ------------------------------------------------------------------ */
/* Worker 协议（APP-CONTRACT §4，主线程 embedClient 使用）              */
/* ------------------------------------------------------------------ */

export type WorkerRequest =
  | { type: 'init'; config: ModelConfig; modelBase: string; modelId?: string; stub?: boolean; fp32Bytes?: number }
  | { type: 'embed'; id: number; texts: string[]; batchSize?: number }
  | { type: 'warmup'; id: number }
  | { type: 'info' };

export type WorkerResponse =
  | {
      type: 'ready';
      backend: Device;
      dtype: Dtype;
      loadMs: number;
      warmupMs: number;
      modelInfo: ModelInfo;
      fallbackReason?: string | null;
    }
  | {
      type: 'progress';
      phase: 'download' | 'init';
      file?: string;
      loaded: number;
      total: number;
      progress: number | null;
    }
  | {
      type: 'embedded';
      id: number;
      vectors: number[][];
      dim: number;
      embedMs: number;
      throughput: number;
    }
  | { type: 'warmup'; id: number; warmupMs: number }
  | { type: 'info'; info: ModelInfo }
  | { type: 'error'; id?: number; message: string; recoverable: boolean; stack?: string };

/* ------------------------------------------------------------------ */
/* 后端 API（APP-CONTRACT §3）                                          */
/* ------------------------------------------------------------------ */

export interface ApiErrorPayload {
  error?: { code?: string; message?: string };
}

export interface HealthResponse {
  ok: boolean;
  dbMode: 'embedded' | 'server';
  dbVersion: string;
  uptimeMs: number;
}

export interface KbInfo {
  id: string;
  name: string;
  table: string;
  dim: number;
  model: string;
  docCount: number;
  createdAt: string;
}

export interface KbListResponse {
  kbs: KbInfo[];
}

export interface CreateKbRequest {
  name: string;
  dim?: number;
  model?: string;
}

export interface CreateKbResponse {
  kb: KbInfo;
}

export interface ImportDoc {
  id?: string;
  text: string;
  category?: string;
  meta?: Record<string, unknown>;
}

export interface ImportDocsRequest {
  docs: ImportDoc[];
  vectors: number[][];
  batchId?: string;
}

export interface ImportDocsResponse {
  inserted: number;
  total: number;
  writeMs: number;
  refreshMs: number;
}

export interface RefreshResponse {
  ok: boolean;
  docCount: number;
  refreshMs: number;
}

export type SearchMode = 'hybrid' | 'vector' | 'fulltext';

export interface SearchRequest {
  mode: SearchMode;
  query: string;
  vector?: number[];
  k?: number;
}

export interface SearchRow {
  id: string;
  text: string;
  category?: string | null;
  meta?: Record<string, unknown> | null;
  /** 全文相关度（MATCH ... AGAINST），vector 模式可能为 null */
  score?: number | null;
  /** L2 距离（对归一化向量），fulltext 模式可能为 null */
  distance?: number | null;
}

export interface SearchResponse {
  mode: SearchMode;
  k: number;
  rows: SearchRow[];
  /** 服务端实际执行的单条 SQL（混合检索的核心证据） */
  sql: string;
  /** 服务端 SQL 耗时（performance.now 包住 client.execute） */
  dbMs: number;
}

export interface IndexInfo {
  name: string;
  type: string;
  /** 契约字段 columns；旧版后端可能返回 column（前端两者都兼容） */
  columns?: string;
  column?: string;
}

export interface KbStatsResponse {
  docCount: number;
  createTableSql: string;
  indexes: IndexInfo[];
  sampleHybridSql: string;
}

export interface DbInfoResponse {
  mode: string;
  version: string;
  bindings?: string;
  path?: string;
  showCreateTable?: unknown;
  showIndex?: unknown;
}

/* ------------------------------------------------------------------ */
/* 检索阶段计时（浏览器侧实测）                                         */
/* ------------------------------------------------------------------ */

export interface SearchTimings {
  /** 查询向量化（Worker 内实测） */
  embedMs: number;
  /** 服务端 SQL 耗时（seekdb 检索） */
  dbMs: number;
  /** 浏览器 → 后端 HTTP 往返（含 JSON 序列化） */
  apiMs: number;
  /** 端到端 = embed + HTTP 往返 */
  e2eMs: number;
}

export interface SearchResultView {
  request: SearchRequest;
  response: SearchResponse;
  timings: SearchTimings;
  at: number;
  kbId: string;
}

/* ------------------------------------------------------------------ */
/* 导入摘要                                                            */
/* ------------------------------------------------------------------ */

export interface ImportSummary {
  kbId: string;
  docs: number;
  batches: number;
  vectorizeMs: number;
  writeMs: number;
  refreshMs: number;
  totalMs: number;
  inserted: number;
  at: number;
  ids: string[];
}

/* ------------------------------------------------------------------ */
/* 评测                                                                */
/* ------------------------------------------------------------------ */

export interface BenchConfigDef {
  id: string;
  label: string;
  device: Device;
  dtype: Dtype;
}

export interface CorpusDoc {
  id: string;
  title?: string;
  text: string;
  category?: string;
}

export interface QueryItem {
  qid: string;
  query: string;
  goldId?: string;
}

export interface QrelItem {
  qid: string;
  goldId: string;
  rel: number;
}

export interface BenchRunDetail {
  index: number;
  /** 单次全量查询的耗时中位数 */
  embedMsMedian: number;
  dbMsMedian: number;
  apiMsMedian: number;
  e2eMsMedian: number;
  /** 首次查询（冷）端到端 */
  e2eFirst: number;
  recall10: number;
  ndcg10: number;
  hits: number;
  queries: number;
  perQuery: Array<{
    qid: string;
    query: string;
    goldId: string;
    rankedIds: string[];
    recall10: number;
    ndcg10: number;
    embedMs: number;
    dbMs: number;
    apiMs: number;
    e2eMs: number;
  }>;
}

export interface BenchConfigResult {
  id: string;
  label: string;
  device: Device;
  dtype: Dtype;
  status: 'ok' | 'skipped' | 'error';
  statusReason?: string;
  model?: {
    onnxBytes: number;
    fp32Bytes?: number;
    compressionRatio?: number;
    loadMs?: number;
    warmupMs?: number;
    wasmThreads?: number | null;
  };
  kbId?: string;
  /** 语料向量化吞吐（docs/s） */
  vectorize?: { ms: number; docs: number; docsPerSec: number; batches: number };
  /** 写入 seekdb 耗时 */
  write?: { writeMs: number; refreshMs: number; docCount: number };
  runs?: BenchRunDetail[];
  summary?: {
    runs: number;
    /** 预热后（第 2..N 次）中位数 */
    embedMsMedian: number;
    dbMsMedian: number;
    apiMsMedian: number;
    e2eMsMedian: number;
    /** 首次运行（冷启动）指标 */
    firstRunE2eMs: number;
    recall10: number;
    ndcg10: number;
  };
}

export interface BenchmarkResult {
  app: 'StepKB';
  task: 'OceanBase 2026 t27';
  generatedAt: string;
  mode: 'hybrid';
  k: 10;
  runs: number;
  env: {
    userAgent: string;
    crossOriginIsolated: boolean;
    hardwareConcurrency: number;
    webgpuAvailable: boolean;
    webgpuAdapter?: string;
    wasmThreads?: number | null;
    origin: string;
  };
  dataset: {
    corpus: number;
    queries: number;
    qrels: number;
    sources: string[];
  };
  configs: BenchConfigResult[];
}

/* ------------------------------------------------------------------ */
/* 全局测试钩子（browser-e2e 依赖）                                     */
/* ------------------------------------------------------------------ */

export interface StepKbLogEntry {
  ts: number;
  level: 'info' | 'ok' | 'warn' | 'err';
  /** 阶段标记（APP-CONTRACT v1.1：model / import / search / bench / db / ui） */
  phase?: string;
  msg: string;
  data?: Record<string, unknown>;
}

/** APP-CONTRACT v1.1：__stepkb.state() 的精简摘要（e2e 断言用） */
export interface StepKbSummaryState {
  ready: boolean;
  backend: Device | null;
  dtype: Dtype | null;
  fallbackReason?: string | null;
  dbOk: boolean;
  docCount: number;
  currentKb?: string;
  modelStatus: ModelRuntimeState['status'];
  stub: boolean;
  searchMode?: SearchMode | null;
}

export interface HookImportResult {
  inserted: number;
  total: number;
  writeMs: number;
  refreshMs: number;
}

export interface HookSearchResult {
  rows: SearchRow[];
  sql: string;
  dbMs: number;
  queryEmbedMs: number;
}

export interface StepKbStateSnapshot {
  ready: boolean;
  webgpu: { available: boolean; fp16: boolean; reason?: string; adapter?: string } | null;
  model: ModelRuntimeState;
  db: { status: 'unknown' | 'ok' | 'error'; health: HealthResponse | null; error: string | null };
  kbs: KbInfo[];
  activeKbId: string | null;
  lastSearch: SearchResultView | null;
  lastImport: ImportSummary | null;
  benchmark: BenchmarkResult | null;
  busy: { model: boolean; import: boolean; search: boolean; bench: boolean };
}

/**
 * window.__stepkb —— 自动化测试钩子。
 *
 * 同时兼容两版契约：
 * - APP-CONTRACT v1.1（Lead，2026-10-31）：importTexts(texts, opts) / search(query, mode, k) /
 *   state() / refresh() 使用“当前知识库”；
 * - 任务书旧版：importTexts(kbId, texts) / search(kbId, {mode,query,k}) / refresh(kbId) 显式指定 kb。
 * 运行时按参数类型区分，两侧都可驱动。
 */
export interface StepKbHooks {
  ready(): Promise<void>;
  /** v1.1 精简状态 */
  state(): StepKbSummaryState;
  /** 旧版：完整状态快照 */
  getState(): StepKbStateSnapshot;
  getLogs(): StepKbLogEntry[];
  createKb(name: string): Promise<KbInfo>;
  deleteKb(id: string): Promise<{ ok: boolean }>;
  /** v1.1 形式（kb 由 opts.kb 或当前激活知识库决定） */
  importTexts(
    texts: string[] | Array<{ id?: string; text: string }>,
    opts?: { kb?: string },
  ): Promise<HookImportResult>;
  /** 任务书旧版形式（显式 kbId） */
  importTexts(kbId: string, texts: string[]): Promise<ImportSummary>;
  /** v1.1 形式：使用当前知识库 */
  search(query: string, mode?: SearchMode, k?: number): Promise<HookSearchResult>;
  /** 任务书旧版形式：显式 kbId */
  search(
    kbId: string,
    opts: { mode: SearchMode; query: string; k?: number },
  ): Promise<{ response: SearchResponse; timings: SearchTimings }>;
  /** v1.1：刷新当前知识库；旧版可传 kbId */
  refresh(kbId?: string): Promise<RefreshResponse>;
  runBenchmark(
    options?: string | { configs?: string[]; runs?: number },
  ): Promise<BenchmarkResult>;
  getBenchmarkResult(): BenchmarkResult | null;
}
