/**
 * 主线程侧的 Worker 封装（APP-CONTRACT §4 / 题面“优先 WebGPU，不支持时自动降级 WASM 并提示”）。
 *
 * 降级链（auto）：webgpu+fp16 → wasm+q8 → wasm+int8 → （仅开发联调）桩模式
 * - 先做 WebGPU 能力预检（navigator.gpu / requestAdapter / shader-f16），失败直接跳过 WebGPU
 * - 每个后端单独新建 Worker 尝试，失败会记录原因；成功后把 fallbackReason 暴露给 UI
 * - bench 使用 exact 模式：只加载指定配置，失败如实标记 skipped，不静默降级
 */

import type {
  Device,
  Dtype,
  ModelConfig,
  ModelInfo,
  ModelRuntimeState,
  WorkerRequest,
  WorkerResponse,
} from './types';

const MODEL_BASE = '/models/';
const MODEL_ID = 'bge-small-zh-v1.5';
const INIT_TIMEOUT_MS = 240_000;

export interface WebgpuCapability {
  available: boolean;
  fp16: boolean;
  reason?: string;
  adapter?: string;
}

export interface InitOptions {
  /** 仅尝试指定配置，失败直接报错（评测用，保证表格配置纯净） */
  exact?: boolean;
  /** exact 模式下唯一尝试的配置 */
  config?: ModelConfig;
  /** 允许在全部真实后端失败后进入桩模式（仅 ?stub=1 开发联调） */
  allowStub?: boolean;
  /** 自定义模型目录名 */
  modelId?: string;
}

export interface EmbedBatchResult {
  vectors: number[][];
  dim: number;
  embedMs: number;
  throughput: number;
}

export class EmbedError extends Error {
  readonly attempts: Array<{ config: ModelConfig; ok: boolean; reason?: string; ms?: number }>;
  constructor(message: string, attempts: ModelRuntimeState['attempts']) {
    super(message);
    this.name = 'EmbedError';
    this.attempts = attempts;
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface GpuLike {
  requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<{
    features?: { has?(name: string): boolean } | Set<string>;
    info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  } | null>;
}

/** 主线程 WebGPU 能力预检（比 Worker 内失败更早、原因更可读）。 */
export async function detectWebgpu(): Promise<WebgpuCapability> {
  const nav = navigator as unknown as { gpu?: GpuLike };
  if (!nav.gpu) {
    return { available: false, fp16: false, reason: 'navigator.gpu 不存在（浏览器未启用 WebGPU）' };
  }
  try {
    const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return { available: false, fp16: false, reason: 'requestAdapter() 返回 null（无可用 GPU 适配器）' };
    }
    const hasFeature = (name: string): boolean => {
      const features = adapter.features as unknown;
      if (!features) return false;
      if (typeof (features as { has?: (n: string) => boolean }).has === 'function') {
        return (features as { has: (n: string) => boolean }).has(name);
      }
      if (features instanceof Set) return features.has(name);
      return false;
    };
    const fp16 = hasFeature('shader-f16');
    const info = adapter.info;
    const parts = [info?.vendor, info?.architecture, info?.device, info?.description].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    const cap: WebgpuCapability = {
      available: true,
      fp16,
      adapter: parts.join(' / ') || undefined,
      reason: fp16 ? undefined : 'GPU 适配器不支持 shader-f16，无法运行 FP16 模型',
    };
    return cap;
  } catch (err) {
    return { available: false, fp16: false, reason: 'requestAdapter() 异常：' + errorText(err) };
  }
}

function describeConfig(config: ModelConfig): string {
  return (config.device === 'webgpu' ? 'WebGPU' : 'WASM') + ' · ' + config.dtype.toUpperCase();
}

function badgeLabel(config: ModelConfig): string {
  return config.device === 'webgpu' ? 'WebGPU · FP16' : 'WASM · ' + (config.dtype === 'fp32' ? 'FP32' : 'INT8');
}

export class EmbeddingClient {
  state: ModelRuntimeState = {
    status: 'idle',
    progress: null,
    backend: null,
    dtype: null,
    fallbackReason: null,
    attempts: [],
    info: null,
    error: null,
    stub: false,
  };

  onState: ((state: ModelRuntimeState) => void) | null = null;
  onProgress: ((msg: Extract<WorkerResponse, { type: 'progress' }>, attempt: number) => void) | null = null;

  private worker: Worker | null = null;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private nextId = 1;
  private initAttemptIndex = 0;

  get backendLabel(): string {
    if (this.state.stub) return '桩模式（开发联调）';
    if (!this.state.backend || !this.state.dtype) return '未就绪';
    return badgeLabel({ device: this.state.backend, dtype: this.state.dtype });
  }

  private setState(patch: Partial<ModelRuntimeState>): void {
    this.state = { ...this.state, ...patch };
    this.onState?.(this.state);
  }

  /** 自动降级加载；返回成功配置的 ModelInfo。 */
  async init(options: InitOptions = {}): Promise<ModelInfo> {
    const modelId = options.modelId ?? MODEL_ID;
    this.setState({
      status: 'loading',
      progress: 0,
      progressText: '检测 WebGPU 能力…',
      error: null,
      fallbackReason: null,
      attempts: [],
      stub: false,
    });

    const attempts: ModelRuntimeState['attempts'] = [];
    let fallbackReason: string | null = null;

    if (!options.exact) {
      const cap = await detectWebgpu();
      if (!cap.available) {
        fallbackReason = cap.reason ?? 'WebGPU 不可用';
      } else if (!cap.fp16) {
        fallbackReason = cap.reason ?? 'GPU 不支持 shader-f16';
      }
    }

    let chain: ModelConfig[];
    if (options.exact) {
      if (!options.config) throw new Error('exact 模式必须提供 config');
      chain = [options.config];
    } else {
      chain = [
        { device: 'webgpu', dtype: 'fp16' },
        { device: 'wasm', dtype: 'q8' },
        { device: 'wasm', dtype: 'int8' },
      ];
      // 如果 WebGPU 预检明确不可用/不支持 fp16，则不浪费时间尝试（原因已在 fallbackReason）
      if (fallbackReason) chain = chain.filter((c) => c.device !== 'webgpu');
    }

    for (const config of chain) {
      const started = performance.now();
      try {
        const info = await this.tryLoad(config, modelId, attempts.length + 1);
        attempts.push({ config, ok: true, ms: performance.now() - started });
        this.initAttemptIndex = 0;
        this.setState({
          status: 'ready',
          progress: 100,
          progressText: undefined,
          backend: info.backend,
          dtype: info.dtype,
          info,
          fallbackReason,
          attempts,
          stub: info.stub === true,
          error: null,
        });
        return info;
      } catch (err) {
        const reason = errorText(err);
        attempts.push({ config, ok: false, reason, ms: performance.now() - started });
        fallbackReason = (fallbackReason ? fallbackReason + '；' : '') + describeConfig(config) + ' 不可用：' + reason;
        this.setState({ attempts: [...attempts], fallbackReason });
        await this.teardownWorker();
      }
    }

    if (options.allowStub) {
      const stubConfig: ModelConfig = { device: 'wasm', dtype: 'int8' };
      try {
        const info = await this.tryLoad(stubConfig, modelId, attempts.length + 1, true);
        attempts.push({ config: stubConfig, ok: true, reason: '桩模式', ms: info.loadMs });
        this.setState({
          status: 'ready',
          progress: 100,
          progressText: undefined,
          backend: info.backend,
          dtype: info.dtype,
          info,
          fallbackReason: (fallbackReason ? fallbackReason + '；' : '') + '已进入桩模式（仅 UI/接口联调，不是真实推理）',
          attempts,
          stub: true,
          error: null,
        });
        return info;
      } catch (err) {
        attempts.push({ config: stubConfig, ok: false, reason: errorText(err) });
        await this.teardownWorker();
      }
    }

    const message = '模型加载失败：' + (fallbackReason ?? '所有后端均不可用');
    this.setState({ status: 'error', error: message, attempts, fallbackReason });
    throw new EmbedError(message, attempts);
  }

  /** 精确加载指定配置（评测用，失败直接抛出，不降级）。 */
  async initExact(config: ModelConfig, modelId = MODEL_ID): Promise<ModelInfo> {
    return this.init({ exact: true, config, modelId, allowStub: false });
  }

  private async tryLoad(
    config: ModelConfig,
    modelId: string,
    attempt: number,
    stub = false,
  ): Promise<ModelInfo> {
    await this.teardownWorker();
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'stepkb-embed',
    });
    this.worker = worker;
    this.initAttemptIndex = attempt;

    return new Promise<ModelInfo>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('模型加载超时（' + Math.round(INIT_TIMEOUT_MS / 1000) + 's）'));
      }, INIT_TIMEOUT_MS);

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'progress': {
            if (msg.phase === 'download' && msg.progress != null) {
              const text =
                '加载模型文件 ' + (msg.file ?? '') + ' ' + msg.progress.toFixed(0) + '%' +
                (msg.total > 0 ? '（' + (msg.loaded / 1e6).toFixed(1) + ' / ' + (msg.total / 1e6).toFixed(1) + ' MB）' : '');
              this.setState({ progress: msg.progress, progressText: text });
            } else {
              this.setState({ progress: null, progressText: msg.file ?? '初始化推理运行时…' });
            }
            this.onProgress?.(msg, attempt);
            break;
          }
          case 'ready': {
            finish(() => resolve(msg.modelInfo));
            break;
          }
          case 'embedded': {
            const entry = this.pending.get(msg.id);
            if (entry) {
              this.pending.delete(msg.id);
              entry.resolve({
                vectors: msg.vectors,
                dim: msg.dim,
                embedMs: msg.embedMs,
                throughput: msg.throughput,
              });
            }
            break;
          }
          case 'warmup': {
            const entry = this.pending.get(msg.id);
            if (entry) {
              this.pending.delete(msg.id);
              entry.resolve(msg.warmupMs);
            }
            break;
          }
          case 'info': {
            break;
          }
          case 'error': {
            if (msg.id != null) {
              const entry = this.pending.get(msg.id);
              if (entry) {
                this.pending.delete(msg.id);
                entry.reject(new Error(msg.message));
              }
            } else {
              finish(() => reject(new Error(msg.message)));
            }
            break;
          }
          default:
            break;
        }
      };

      worker.onerror = (ev: ErrorEvent) => {
        finish(() => reject(new Error('Worker 启动失败：' + (ev.message || '脚本加载错误'))));
      };

      const req: WorkerRequest = {
        type: 'init',
        config,
        modelBase: MODEL_BASE,
        modelId,
        stub,
      };
      worker.postMessage(req);
    });
  }

  /** 批量向量化；返回的向量已在 Worker 内做过 L2 归一化。 */
  embed(texts: string[], options: { batchSize?: number } = {}): Promise<EmbedBatchResult> {
    if (!this.worker || !this.state.info) {
      return Promise.reject(new Error('模型尚未初始化，无法向量化'));
    }
    if (!Array.isArray(texts) || texts.length === 0) {
      return Promise.resolve({ vectors: [], dim: this.state.info.dim, embedMs: 0, throughput: 0 });
    }
    const id = this.nextId++;
    return new Promise<EmbedBatchResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('向量化超时（120s）'));
      }, 120_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as EmbedBatchResult);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      const req: WorkerRequest = { type: 'embed', id, texts, batchSize: options.batchSize };
      this.worker?.postMessage(req);
    });
  }

  warmup(): Promise<number> {
    if (!this.worker) return Promise.reject(new Error('模型尚未初始化'));
    const id = this.nextId++;
    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('预热超时'));
      }, 120_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as number);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      this.worker?.postMessage({ type: 'warmup', id } satisfies WorkerRequest);
    });
  }

  async dispose(): Promise<void> {
    await this.teardownWorker();
    this.setState({ status: 'idle', info: null, backend: null, dtype: null });
  }

  private async teardownWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.pending.clear();
    if (worker) {
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
    }
  }
}

export { badgeLabel, describeConfig };
