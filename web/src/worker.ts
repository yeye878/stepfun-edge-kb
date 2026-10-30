/// <reference lib="webworker" />
/**
 * StepKB 端侧 embedding Worker（APP-CONTRACT §4）
 *
 * 合规要点：
 * - 模型从同源 /models/bge-small-zh-v1.5/ 自托管加载，env.allowRemoteModels=false；
 *   v4 在浏览器/Worker 中 env.allowLocalModels 默认 false，必须显式开启（已实测源码）。
 * - 向量在本 Worker 内计算，返回前做 L2 归一化；主线程/后端都不做推理。
 * - dtype → 文件名（v4.3.2 src/utils/dtypes.js）：
 *     fp32 → onnx/model.onnx
 *     fp16 → onnx/model_fp16.onnx
 *     int8 → onnx/model_int8.onnx
 *     q8   → onnx/model_quantized.onnx
 * - 池化：CLS（bge-small-zh-v1.5 官方用法），查询不加 instruction；归一化自行完成。
 */

import { env, pipeline } from '@huggingface/transformers';
import type { Dtype, ModelConfig, ModelInfo, WorkerRequest, WorkerResponse } from './types';

const MODEL_BASE = '/models/';
const DEFAULT_MODEL_ID = 'bge-small-zh-v1.5';
const ORT_BASE = '/ort/';
const ORT_ARTIFACT = 'ort-wasm-simd-threaded.asyncify';

const ONNX_FILE_BY_DTYPE: Record<Dtype, string> = {
  fp32: 'onnx/model.onnx',
  fp16: 'onnx/model_fp16.onnx',
  int8: 'onnx/model_int8.onnx',
  q8: 'onnx/model_quantized.onnx',
};

interface TensorLike {
  dims: number[];
  tolist(): unknown;
}

type Extractor = (
  texts: string | string[],
  options?: { pooling?: 'none' | 'mean' | 'cls' | 'first_token' | 'eos' | 'last_token'; normalize?: boolean },
) => Promise<TensorLike>;

interface ManifestFile {
  path?: string;
  bytes?: number;
}

interface Manifest {
  model?: string;
  dim?: number;
  pooling?: string;
  normalize?: string;
  files?: Record<string, ManifestFile | number>;
  totals?: Record<string, number>;
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

let extractor: Extractor | null = null;
let modelInfo: ModelInfo | null = null;
let modelId = DEFAULT_MODEL_ID;
let stubMode = false;
let lastProgressAt = 0;

/** 串行执行推理任务，避免 ORT 会话并发冲突。 */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function post(msg: WorkerResponse): void {
  workerScope.postMessage(msg);
}

function postProgress(
  phase: 'download' | 'init',
  file: string | undefined,
  loaded: number,
  total: number,
  force = false,
): void {
  const now = performance.now();
  if (!force && phase === 'download' && now - lastProgressAt < 120) return;
  lastProgressAt = now;
  post({
    type: 'progress',
    phase,
    file,
    loaded,
    total,
    progress: total > 0 ? Math.min(100, (loaded / total) * 100) : null,
  });
}

/** 配置 transformers.js v4 环境（自托管、本地优先、禁止远端）。 */
function configureEnv(): void {
  env.allowLocalModels = true; // v4 在 web/worker 环境默认 false，必须显式打开
  env.allowRemoteModels = false; // 不访问 HF Hub，模型完全同源自托管
  env.localModelPath = MODEL_BASE;
  env.useBrowserCache = false; // 避免 dev 期间缓存旧模型；静态服务器 HTTP 缓存已足够
  const wasm = env.backends.onnx.wasm as unknown as {
    wasmPaths?: { mjs: string; wasm: string };
    numThreads?: number;
  };
  wasm.wasmPaths = {
    mjs: ORT_BASE + ORT_ARTIFACT + '.mjs',
    wasm: ORT_BASE + ORT_ARTIFACT + '.wasm',
  };
}

function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return vec.slice();
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

async function probeWebgpuAdapter(): Promise<string | undefined> {
  interface GpuLike {
    requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<{
      info?: { vendor?: string; architecture?: string; device?: string; description?: string };
    } | null>;
  }
  const nav = navigator as unknown as { gpu?: GpuLike };
  if (!nav.gpu) return undefined;
  try {
    const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return undefined;
    const info = adapter.info;
    const parts = [info?.vendor, info?.architecture, info?.device, info?.description].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    return parts.join(' / ') || 'WebGPU 适配器已就绪';
  } catch {
    return undefined;
  }
}

async function headContentLength(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    const len = res.headers.get('content-length');
    if (res.ok && len) return Number.parseInt(len, 10);
  } catch {
    /* ignore */
  }
  // 某些静态服务器不支持 HEAD：用 Range 探测
  try {
    const res = await fetch(url, { headers: { range: 'bytes=0-0' }, cache: 'no-store' });
    const range = res.headers.get('content-range');
    if (range) {
      const total = range.split('/').pop();
      if (total) {
        const n = Number.parseInt(total, 10);
        if (Number.isFinite(n)) return n;
      }
    }
    if (res.status === 200) {
      const blob = await res.blob();
      return blob.size;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 读取模型文件字节数：优先 manifest.json（eval-data 产出），否则 HEAD Content-Length 兜底。 */
async function probeModelBytes(
  dtype: Dtype,
): Promise<{ bytes: number; fp32Bytes?: number; onnxFile?: string }> {
  const base = MODEL_BASE + modelId + '/';
  try {
    const res = await fetch(base + 'manifest.json', { cache: 'no-store' });
    if (res.ok) {
      const manifest = (await res.json()) as Manifest;
      const files = manifest.files ?? {};
      const readBytes = (key: string): number | undefined => {
        const entry = files[key];
        if (typeof entry === 'number') return entry;
        if (entry && typeof entry.bytes === 'number') return entry.bytes;
        return undefined;
      };
      const bytes = readBytes(dtype);
      if (bytes && bytes > 0) {
        const fp32 = readBytes('fp32');
        const entry = files[dtype];
        return {
          bytes,
          fp32Bytes: fp32 && fp32 > 0 ? fp32 : undefined,
          onnxFile: typeof entry === 'object' && entry?.path ? entry.path : ONNX_FILE_BY_DTYPE[dtype],
        };
      }
    }
  } catch {
    /* manifest 不存在时走 HEAD */
  }
  const onnxFile = ONNX_FILE_BY_DTYPE[dtype];
  const bytes = await headContentLength(base + onnxFile);
  const fp32 = dtype === 'fp32' ? bytes : await headContentLength(base + ONNX_FILE_BY_DTYPE.fp32);
  return {
    bytes: bytes ?? 0,
    fp32Bytes: fp32 && fp32 > 0 ? fp32 : undefined,
    onnxFile,
  };
}

function readWasmThreads(): number | null {
  const wasm = env.backends.onnx.wasm as unknown as { numThreads?: number };
  const n = wasm.numThreads;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

async function buildRealModel(config: ModelConfig): Promise<{ loadMs: number; warmupMs: number; info: ModelInfo }> {
  configureEnv();
  postProgress('init', '构造 pipeline', 0, 0, true);
  const t0 = performance.now();
  const pipe = await pipeline('feature-extraction', modelId, {
    device: config.device,
    dtype: config.dtype,
    progress_callback: (p: unknown) => {
      const evt = p as {
        status?: string;
        file?: string;
        loaded?: number;
        total?: number;
      } | null;
      if (!evt) return;
      if (evt.status === 'progress') {
        postProgress('download', evt.file, evt.loaded ?? 0, evt.total ?? 0);
      } else if (evt.status === 'done' || evt.status === 'ready') {
        postProgress('download', evt.file, evt.total ?? 0, evt.total ?? 0, true);
      }
    },
  });
  extractor = pipe as unknown as Extractor;
  const loadMs = performance.now() - t0;

  // 预热：强制第一次真实推理（WebGPU 首次会编译 shader），失败视为该后端不可用
  postProgress('init', '首次推理预热', 0, 0, true);
  const w0 = performance.now();
  const warm = await extractor(['预热'], { pooling: 'cls' });
  const warmupMs = performance.now() - w0;
  const dim = warm.dims[warm.dims.length - 1] ?? 384;

  const bytes = await probeModelBytes(config.dtype);
  const adapter = config.device === 'webgpu' ? await probeWebgpuAdapter() : undefined;
  const compressionRatio =
    bytes.fp32Bytes && bytes.bytes > 0 ? bytes.fp32Bytes / bytes.bytes : undefined;

  const info: ModelInfo = {
    modelId,
    dim,
    backend: config.device,
    dtype: config.dtype,
    loadMs,
    warmupMs,
    onnxBytes: bytes.bytes,
    onnxFile: bytes.onnxFile,
    fp32Bytes: bytes.fp32Bytes,
    compressionRatio,
    wasmThreads: config.device === 'wasm' ? readWasmThreads() : null,
    crossOriginIsolated: workerScope.crossOriginIsolated === true,
    webgpuAdapter: adapter,
    pooling: 'cls',
    normalize: 'l2',
    stub: false,
  };
  return { loadMs, warmupMs, info };
}

/* ------------------------- 桩模式（仅开发联调） ------------------------- */
/**
 * 在没有模型文件时，用确定性哈希向量把 UI/接口跑通。
 * 明确标记 stub=true，界面会显示醒目的“桩模式”提示；正式验收必须使用真实模型。
 */

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function stubEmbedOne(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const chars = Array.from(text.trim());
  if (chars.length === 0) {
    vec[0] = 1;
    return vec;
  }
  for (let i = 0; i < chars.length; i++) {
    const gram = chars[i] + (chars[i + 1] ?? '');
    const h = fnv1a(gram);
    const idx = h % dim;
    const sign = (h >>> 9) & 1 ? 1 : -1;
    vec[idx] += sign;
  }
  return l2normalize(vec);
}

function buildStubModel(config: ModelConfig): { loadMs: number; warmupMs: number; info: ModelInfo } {
  const t0 = performance.now();
  const dim = 384;
  const stub: Extractor = async (texts) => {
    const arr = Array.isArray(texts) ? texts : [texts];
    const rows = arr.map((t) => stubEmbedOne(String(t), dim));
    return {
      dims: [rows.length, dim],
      tolist: () => rows,
    };
  };
  extractor = stub;
  const loadMs = performance.now() - t0;
  const info: ModelInfo = {
    modelId: 'stub-hash-embedding',
    dim,
    backend: config.device,
    dtype: config.dtype,
    loadMs,
    warmupMs: 0,
    onnxBytes: 0,
    fp32Bytes: undefined,
    compressionRatio: undefined,
    wasmThreads: null,
    crossOriginIsolated: workerScope.crossOriginIsolated === true,
    pooling: 'cls',
    normalize: 'l2',
    stub: true,
  };
  return { loadMs, warmupMs: 0, info };
}

/* ------------------------------- 消息处理 ------------------------------- */

async function handleInit(req: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  modelId = req.modelId ?? DEFAULT_MODEL_ID;
  stubMode = req.stub === true;
  if (stubMode) {
    const { loadMs, warmupMs, info } = buildStubModel(req.config);
    modelInfo = info;
    post({ type: 'ready', backend: info.backend, dtype: info.dtype, loadMs, warmupMs, modelInfo: info });
    return;
  }
  const { loadMs, warmupMs, info } = await buildRealModel(req.config);
  modelInfo = info;
  post({ type: 'ready', backend: info.backend, dtype: info.dtype, loadMs, warmupMs, modelInfo: info });
}

async function handleEmbed(req: Extract<WorkerRequest, { type: 'embed' }>): Promise<void> {
  if (!extractor) {
    post({ type: 'error', id: req.id, message: '模型尚未初始化', recoverable: true });
    return;
  }
  const texts = Array.isArray(req.texts) ? req.texts.filter((t) => typeof t === 'string') : [];
  const batchSize = Math.max(1, Math.min(64, req.batchSize ?? 8));
  const t0 = performance.now();
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const chunk = texts.slice(i, i + batchSize);
    const output = await extractor(chunk, { pooling: 'cls', normalize: false });
    const rows = output.tolist() as number[][];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length === 0) {
        throw new Error('模型输出维度异常');
      }
      vectors.push(l2normalize(row.map((x) => Number(x))));
    }
  }
  const embedMs = performance.now() - t0;
  const dim = vectors[0]?.length ?? modelInfo?.dim ?? 384;
  post({
    type: 'embedded',
    id: req.id,
    vectors,
    dim,
    embedMs,
    throughput: embedMs > 0 ? texts.length / (embedMs / 1000) : 0,
  });
}

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (!req || typeof req !== 'object' || typeof (req as { type?: unknown }).type !== 'string') return;

  if (req.type === 'init') {
    enqueue(() => handleInit(req)).catch((err: unknown) => {
      post({
        type: 'error',
        message: errorText(err),
        recoverable: true,
        stack: err instanceof Error ? err.stack : undefined,
      });
    });
    return;
  }

  if (req.type === 'embed') {
    const id = req.id;
    enqueue(() => handleEmbed(req)).catch((err: unknown) => {
      post({ type: 'error', id, message: errorText(err), recoverable: false, stack: err instanceof Error ? err.stack : undefined });
    });
    return;
  }

  if (req.type === 'warmup') {
    const id = req.id;
    enqueue(async () => {
      if (!extractor) {
        post({ type: 'error', id, message: '模型尚未初始化', recoverable: true });
        return;
      }
      const t0 = performance.now();
      await extractor(['预热检索'], { pooling: 'cls' });
      post({ type: 'warmup', id, warmupMs: performance.now() - t0 });
    }).catch((err: unknown) => {
      post({ type: 'error', id, message: errorText(err), recoverable: false });
    });
    return;
  }

  if (req.type === 'info') {
    if (modelInfo) post({ type: 'info', info: modelInfo });
    return;
  }
};

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
