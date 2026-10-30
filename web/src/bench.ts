/**
 * 浏览器内评测：3 配置 × N 次
 *   fp32 + WASM / fp16 + WebGPU / int8 + WASM
 *
 * 每次运行的真实流程（全部在本机完成，无云端）：
 *   用该配置的模型向量化语料 → 写入 seekdb 独立知识库 → 30 条查询逐条：
 *   浏览器向量化查询 → 单条 SQL 混合检索 → 按 gold 计算 Recall@10 / nDCG@10
 * 体积来自模型文件实际字节（manifest / HEAD 兜底），压缩比 = fp32 字节 / 该档字节。
 * WebGPU 不可用时该行标记 skipped 并给出原因，不伪造数字。
 */

import { api } from './api';
import { EmbeddingClient, detectWebgpu, type WebgpuCapability } from './embedClient';
import { clamp, median } from './format';
import type {
  BenchConfigDef,
  BenchConfigResult,
  BenchRunDetail,
  BenchmarkResult,
  CorpusDoc,
  Dtype,
  QrelItem,
  QueryItem,
} from './types';

export const BENCH_CONFIGS: BenchConfigDef[] = [
  { id: 'fp32-wasm', label: 'FP32 + WASM', device: 'wasm', dtype: 'fp32' },
  { id: 'fp16-webgpu', label: 'FP16 + WebGPU', device: 'webgpu', dtype: 'fp16' },
  { id: 'int8-wasm', label: 'INT8 + WASM', device: 'wasm', dtype: 'int8' },
];

const BENCH_K = 10;
const EMBED_BATCH = 16;
const WRITE_BATCH = 64;
const DATASET_SOURCES = ['/data/corpus.json', '/data/queries.json', '/data/qrels.json'];

export interface Dataset {
  corpus: CorpusDoc[];
  queries: QueryItem[];
  qrels: QrelItem[];
}

export interface BenchProgress {
  running: boolean;
  configId?: string;
  label?: string;
  index?: number;
  total?: number;
  detail: string;
  progress?: number | null;
}

export interface BenchOptions {
  configs?: string[];
  runs?: number;
  onProgress?: (p: BenchProgress) => void;
  onLog?: (level: 'info' | 'ok' | 'warn' | 'err', msg: string, data?: Record<string, unknown>) => void;
}

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    throw new Error('读取评测数据失败：' + url + '（' + (err instanceof Error ? err.message : String(err)) + '）');
  }
  if (!res.ok) {
    throw new Error(
      '缺少评测数据 ' + url + '（HTTP ' + res.status + '）。评测数据由 eval-data 生成，见 notes/APP-CONTRACT.md §5。',
    );
  }
  return res.json();
}

function pickArray<T>(raw: unknown, key: string, url: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const value = (raw as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as T[];
  }
  throw new Error('评测数据格式不符：' + url + '（期望数组或 {' + key + ': [...]}）');
}

export async function loadDataset(): Promise<Dataset> {
  const [corpusRaw, queriesRaw, qrelsRaw] = await Promise.all([
    fetchJson(DATASET_SOURCES[0]),
    fetchJson(DATASET_SOURCES[1]),
    fetchJson(DATASET_SOURCES[2]),
  ]);
  const corpus = pickArray<CorpusDoc>(corpusRaw, 'docs', DATASET_SOURCES[0]).filter(
    (d) => d && typeof d.id === 'string' && typeof d.text === 'string',
  );
  const queries = pickArray<QueryItem>(queriesRaw, 'queries', DATASET_SOURCES[1]).filter(
    (q) => q && typeof q.qid === 'string' && typeof q.query === 'string',
  );
  const qrels = pickArray<QrelItem>(qrelsRaw, 'qrels', DATASET_SOURCES[2]).filter(
    (r) => r && typeof r.qid === 'string' && typeof r.goldId === 'string',
  );
  if (corpus.length === 0) throw new Error('语料为空：' + DATASET_SOURCES[0]);
  if (queries.length === 0) throw new Error('查询为空：' + DATASET_SOURCES[1]);
  if (qrels.length === 0) throw new Error('qrels 为空：' + DATASET_SOURCES[2]);
  return { corpus, queries, qrels };
}

function recallAtK(rankedIds: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) {
    if (relevant.has(rankedIds[i])) hits += 1;
  }
  return hits / relevant.size;
}

function ndcgAtK(rankedIds: string[], relMap: Map<string, number>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rankedIds.length); i++) {
    const rel = relMap.get(rankedIds[i]) ?? 0;
    if (rel > 0) dcg += rel / Math.log2(i + 2);
  }
  const idealRels = Array.from(relMap.values()).sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < idealRels.length; i++) {
    if (idealRels[i] > 0) idcg += idealRels[i] / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

async function probeModelBytes(
  dtype: Dtype,
): Promise<{ bytes: number; fp32Bytes?: number; ratio?: number }> {
  const base = '/models/bge-small-zh-v1.5/';
  const fallbackFile: Record<Dtype, string> = {
    fp32: 'onnx/model.onnx',
    fp16: 'onnx/model_fp16.onnx',
    int8: 'onnx/model_int8.onnx',
    q8: 'onnx/model_quantized.onnx',
  };
  try {
    const res = await fetch(base + 'manifest.json', { cache: 'no-store' });
    if (res.ok) {
      const manifest = (await res.json()) as {
        files?: Record<string, { path?: string; bytes?: number } | number>;
        onnx?: Record<string, { file?: string; bytes?: number } | number>;
      };
      const read = (key: string): number | undefined => {
        for (const table of [manifest.files, manifest.onnx]) {
          const entry = table?.[key];
          if (typeof entry === 'number') return entry;
          if (entry && typeof entry.bytes === 'number') return entry.bytes;
        }
        return undefined;
      };
      const bytes = read(dtype);
      const fp32 = read('fp32');
      if (bytes && bytes > 0) {
        return { bytes, fp32Bytes: fp32, ratio: fp32 && fp32 > 0 ? fp32 / bytes : undefined };
      }
    }
  } catch {
    /* 走 HEAD 兜底 */
  }
  const fetchLen = async (path: string): Promise<number | undefined> => {
    try {
      const res = await fetch(base + path, { method: 'HEAD', cache: 'no-store' });
      const len = res.headers.get('content-length');
      if (res.ok && len) return Number.parseInt(len, 10);
    } catch {
      /* ignore */
    }
    return undefined;
  };
  const bytes = await fetchLen(fallbackFile[dtype]);
  const fp32 = dtype === 'fp32' ? bytes : await fetchLen(fallbackFile.fp32);
  return {
    bytes: bytes ?? 0,
    fp32Bytes: fp32,
    ratio: bytes && fp32 && bytes > 0 ? fp32 / bytes : undefined,
  };
}

interface EmbedWriteResult {
  vectorizeMs: number;
  batches: number;
  writeMs: number;
  refreshMs: number;
  docCount: number;
}

async function embedAndWrite(
  client: EmbeddingClient,
  kbId: string,
  corpus: CorpusDoc[],
  onProgress?: (done: number, total: number) => void,
): Promise<EmbedWriteResult> {
  const t0 = performance.now();
  let pendingDocs: Array<{ id: string; text: string; category?: string; meta?: Record<string, unknown> }> = [];
  let pendingVectors: number[][] = [];
  let writeMs = 0;
  let batches = 0;

  const flush = async (): Promise<void> => {
    if (pendingDocs.length === 0) return;
    const res = await api.importDocs(kbId, { docs: pendingDocs, vectors: pendingVectors, batchId: 'bench-' + Date.now() });
    writeMs += res.writeMs;
    batches += 1;
    pendingDocs = [];
    pendingVectors = [];
  };

  let done = 0;
  for (let i = 0; i < corpus.length; i += EMBED_BATCH) {
    const chunk = corpus.slice(i, i + EMBED_BATCH);
    const embedded = await client.embed(
      chunk.map((doc) => doc.text),
      { batchSize: 8 },
    );
    chunk.forEach((doc, idx) => {
      pendingDocs.push({
        id: doc.id,
        text: doc.text,
        category: doc.category,
        meta: doc.title ? { title: doc.title } : undefined,
      });
      pendingVectors.push(embedded.vectors[idx]);
    });
    done = Math.min(corpus.length, i + chunk.length);
    onProgress?.(done, corpus.length);
    if (pendingDocs.length >= WRITE_BATCH) await flush();
  }
  await flush();
  const vectorizeMs = performance.now() - t0;
  const refresh = await api.refresh(kbId);
  return {
    vectorizeMs,
    batches,
    writeMs,
    refreshMs: refresh.refreshMs,
    docCount: refresh.docCount,
  };
}

function filterConfigs(selector?: string[]): BenchConfigDef[] {
  if (!selector || selector.length === 0) return BENCH_CONFIGS;
  const wanted = selector.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const picked = BENCH_CONFIGS.filter((cfg) =>
    wanted.some((w) => cfg.id.toLowerCase() === w || cfg.label.toLowerCase().includes(w) || cfg.dtype === w || cfg.device === w),
  );
  return picked.length > 0 ? picked : BENCH_CONFIGS;
}

/**
 * 运行评测。会为每个配置新建/覆盖独立知识库（bench-<configId>），
 * 逐配置创建 Worker → 完成后再销毁，避免显存/线程互相干扰。
 */
export async function runBenchmark(options: BenchOptions = {}): Promise<BenchmarkResult> {
  const runs = clamp(Math.round(options.runs ?? 5), 1, 20);
  const selected = filterConfigs(options.configs);
  const progress = (p: BenchProgress): void => options.onProgress?.(p);
  const log = (level: 'info' | 'ok' | 'warn' | 'err', msg: string, data?: Record<string, unknown>): void =>
    options.onLog?.(level, msg, data);

  log('info', '加载评测数据 ' + DATASET_SOURCES.join(' / '));
  const dataset = await loadDataset();
  const qrelsByQid = new Map<string, Map<string, number>>();
  for (const rel of dataset.qrels) {
    let map = qrelsByQid.get(rel.qid);
    if (!map) {
      map = new Map();
      qrelsByQid.set(rel.qid, map);
    }
    map.set(rel.goldId, rel.rel ?? 1);
  }
  // 回退：qrels 缺少某查询时用 queries.goldId
  for (const q of dataset.queries) {
    if (!qrelsByQid.has(q.qid) && q.goldId) qrelsByQid.set(q.qid, new Map([[q.goldId, 1]]));
  }

  const cap: WebgpuCapability = await detectWebgpu();
  log(
    cap.available ? 'info' : 'warn',
    'WebGPU 预检：' + (cap.available ? (cap.fp16 ? '可用（shader-f16 ✅）' : '可用但不支持 shader-f16') : '不可用：' + cap.reason) +
      (cap.adapter ? '；适配器 ' + cap.adapter : ''),
  );

  const env: BenchmarkResult['env'] = {
    userAgent: navigator.userAgent,
    crossOriginIsolated: window.crossOriginIsolated === true,
    hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
    webgpuAvailable: cap.available && cap.fp16,
    webgpuAdapter: cap.adapter,
    origin: location.origin,
  };

  const results: BenchConfigResult[] = [];

  for (let idx = 0; idx < selected.length; idx++) {
    const cfg = selected[idx];
    progress({
      running: true,
      configId: cfg.id,
      label: cfg.label,
      index: idx + 1,
      total: selected.length,
      detail: '准备 ' + cfg.label,
      progress: null,
    });

    if (cfg.device === 'webgpu' && !(cap.available && cap.fp16)) {
      const bytes = await probeModelBytes(cfg.dtype);
      results.push({
        id: cfg.id,
        label: cfg.label,
        device: cfg.device,
        dtype: cfg.dtype,
        status: 'skipped',
        statusReason: cap.reason ?? 'WebGPU 不可用（无法验证 FP16 路径）',
        model: {
          onnxBytes: bytes.bytes,
          fp32Bytes: bytes.fp32Bytes,
          compressionRatio: bytes.ratio,
        },
      });
      log('warn', '跳过 ' + cfg.label + '：' + (cap.reason ?? 'WebGPU 不可用'));
      continue;
    }

    let client: EmbeddingClient | null = null;
    try {
      client = new EmbeddingClient();
      client.onProgress = (msg) => {
        if (msg.phase === 'download' && msg.progress != null) {
          progress({
            running: true,
            configId: cfg.id,
            label: cfg.label,
            index: idx + 1,
            total: selected.length,
            detail: '加载模型 ' + (msg.file ?? '') + ' ' + msg.progress.toFixed(0) + '%',
            progress: msg.progress,
          });
        }
      };
      progress({
        running: true,
        configId: cfg.id,
        label: cfg.label,
        index: idx + 1,
        total: selected.length,
        detail: '加载模型（' + cfg.label + '）…',
        progress: null,
      });
      const info = await client.initExact({ device: cfg.device, dtype: cfg.dtype });
      log('ok', '模型就绪 ' + cfg.label + '：' + (info.onnxBytes / 1e6).toFixed(2) + ' MB，load ' + info.loadMs.toFixed(0) + 'ms，warmup ' + info.warmupMs.toFixed(0) + 'ms');

      // 独立知识库（同名复用会被清空重建，保证 docCount 与语料一致）
      const kbName = 'bench-' + cfg.id;
      const existing = (await api.listKbs()).kbs.find((kb) => kb.name === kbName);
      if (existing) {
        await api.deleteKb(existing.id).catch((err) => log('warn', '清理旧评测知识库失败（可忽略）：' + String(err)));
      }
      const created = await api.createKb({ name: kbName, dim: info.dim, model: info.modelId });
      const kbId = created.kb.id;

      progress({
        running: true,
        configId: cfg.id,
        label: cfg.label,
        index: idx + 1,
        total: selected.length,
        detail: '向量化语料（' + dataset.corpus.length + ' 篇，' + cfg.label + '）…',
        progress: 0,
      });
      const write = await embedAndWrite(client, kbId, dataset.corpus, (done, total) => {
        progress({
          running: true,
          configId: cfg.id,
          label: cfg.label,
          index: idx + 1,
          total: selected.length,
          detail: '向量化语料 ' + done + '/' + total,
          progress: total > 0 ? (done / total) * 100 : null,
        });
      });
      if (write.docCount < dataset.corpus.length) {
        log('warn', '写入后 docCount=' + write.docCount + ' < 语料 ' + dataset.corpus.length + '（按实际返回记录）');
      }

      const runDetails: BenchRunDetail[] = [];
      for (let r = 0; r < runs; r++) {
        progress({
          running: true,
          configId: cfg.id,
          label: cfg.label,
          index: idx + 1,
          total: selected.length,
          detail: '第 ' + (r + 1) + '/' + runs + ' 次检索（' + dataset.queries.length + ' 条查询）…',
          progress: (r / runs) * 100,
        });
        const embedTimes: number[] = [];
        const dbTimes: number[] = [];
        const apiTimes: number[] = [];
        const e2eTimes: number[] = [];
        const recalls: number[] = [];
        const ndcgs: number[] = [];
        const perQuery: BenchRunDetail['perQuery'] = [];
        let e2eFirst = 0;

        for (let qi = 0; qi < dataset.queries.length; qi++) {
          const q = dataset.queries[qi];
          const t0 = performance.now();
          const embedded = await client.embed([q.query]);
          const t1 = performance.now();
          const res = await api.search(kbId, {
            mode: 'hybrid',
            query: q.query,
            vector: embedded.vectors[0],
            k: BENCH_K,
          });
          const t2 = performance.now();
          const embedMs = embedded.embedMs > 0 ? embedded.embedMs : t1 - t0;
          const apiMs = t2 - t1;
          const e2eMs = t2 - t0;
          if (qi === 0 && r === 0) e2eFirst = e2eMs;
          const rankedIds = res.rows.map((row) => row.id);
          const relMap = qrelsByQid.get(q.qid) ?? new Map<string, number>(q.goldId ? [[q.goldId, 1]] : []);
          const recall = recallAtK(rankedIds, new Set(relMap.keys()), BENCH_K);
          const ndcg = ndcgAtK(rankedIds, relMap, BENCH_K);
          embedTimes.push(embedMs);
          dbTimes.push(res.dbMs);
          apiTimes.push(apiMs);
          e2eTimes.push(e2eMs);
          recalls.push(recall);
          ndcgs.push(ndcg);
          perQuery.push({
            qid: q.qid,
            query: q.query,
            goldId: q.goldId ?? '',
            rankedIds,
            recall10: recall,
            ndcg10: ndcg,
            embedMs,
            dbMs: res.dbMs,
            apiMs,
            e2eMs,
          });
        }

        const mean = (arr: number[]): number => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
        runDetails.push({
          index: r + 1,
          embedMsMedian: median(embedTimes),
          dbMsMedian: median(dbTimes),
          apiMsMedian: median(apiTimes),
          e2eMsMedian: median(e2eTimes),
          e2eFirst: e2eFirst || median(e2eTimes),
          recall10: mean(recalls),
          ndcg10: mean(ndcgs),
          hits: recalls.reduce((a, b) => a + b, 0),
          queries: dataset.queries.length,
          perQuery,
        });
        log(
          'info',
          cfg.label + ' 第 ' + (r + 1) + '/' + runs + ' 次：Recall@10=' + (runDetails[r].recall10 * 100).toFixed(1) + '%，nDCG@10=' + runDetails[r].ndcg10.toFixed(4) + '，e2e 中位 ' + runDetails[r].e2eMsMedian.toFixed(1) + 'ms',
        );
      }

      const warmRuns = runDetails.length > 1 ? runDetails.slice(1) : runDetails;
      const summary = {
        runs: runDetails.length,
        embedMsMedian: median(warmRuns.map((r) => r.embedMsMedian)),
        dbMsMedian: median(warmRuns.map((r) => r.dbMsMedian)),
        apiMsMedian: median(warmRuns.map((r) => r.apiMsMedian)),
        e2eMsMedian: median(warmRuns.map((r) => r.e2eMsMedian)),
        firstRunE2eMs: runDetails[0]?.e2eMsMedian ?? NaN,
        recall10: median(runDetails.map((r) => r.recall10)),
        ndcg10: median(runDetails.map((r) => r.ndcg10)),
      };

      results.push({
        id: cfg.id,
        label: cfg.label,
        device: cfg.device,
        dtype: cfg.dtype,
        status: 'ok',
        model: {
          onnxBytes: info.onnxBytes,
          fp32Bytes: info.fp32Bytes,
          compressionRatio: info.compressionRatio,
          loadMs: info.loadMs,
          warmupMs: info.warmupMs,
          wasmThreads: info.wasmThreads,
        },
        kbId,
        vectorize: {
          ms: write.vectorizeMs,
          docs: dataset.corpus.length,
          docsPerSec: write.vectorizeMs > 0 ? (dataset.corpus.length / write.vectorizeMs) * 1000 : 0,
          batches: write.batches,
        },
        write: { writeMs: write.writeMs, refreshMs: write.refreshMs, docCount: write.docCount },
        runs: runDetails,
        summary,
      });
      log(
        'ok',
        cfg.label + ' 完成：体积 ' + (info.onnxBytes / 1e6).toFixed(2) + ' MB，压缩比 ' + (info.compressionRatio ?? NaN).toFixed(2) + '×，吞吐 ' + ((dataset.corpus.length / write.vectorizeMs) * 1000).toFixed(1) + ' docs/s，Recall@10 ' + (summary.recall10 * 100).toFixed(1) + '%',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        id: cfg.id,
        label: cfg.label,
        device: cfg.device,
        dtype: cfg.dtype,
        status: 'error',
        statusReason: message,
      });
      log('err', cfg.label + ' 失败：' + message);
    } finally {
      if (client) {
        try {
          await client.dispose();
        } catch {
          /* ignore */
        }
      }
    }
  }

  const result: BenchmarkResult = {
    app: 'StepKB',
    task: 'OceanBase 2026 t27',
    generatedAt: new Date().toISOString(),
    mode: 'hybrid',
    k: BENCH_K as BenchmarkResult['k'],
    runs,
    env,
    dataset: {
      corpus: dataset.corpus.length,
      queries: dataset.queries.length,
      qrels: dataset.qrels.length,
      sources: DATASET_SOURCES.slice(),
    },
    configs: results,
  };
  progress({ running: false, detail: '评测完成' });
  log('ok', '评测完成（' + results.filter((r) => r.status === 'ok').length + '/' + results.length + ' 个配置成功）');
  return result;
}

/** 导出 JSON 文件名 */
export function benchmarkFileName(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return 'stepkb-benchmark-' + ts + '.json';
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
