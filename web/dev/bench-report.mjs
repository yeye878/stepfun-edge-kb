/**
 * 从浏览器评测 JSON 生成最终基准产物：
 *   - tasks/t27_stepfun_edge/outputs/logs/2026-10-31_final-benchmark.json（规范化，含全部原始字段）
 *   - tasks/t27_stepfun_edge/outputs/logs/2026-10-31_final-benchmark.md（可直接进技术说明的表格）
 *
 * 用法：node web/dev/bench-report.mjs <benchmark.json> [--out-dir <dir>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..', '..');
const taskRoot = path.resolve(srcRoot, '..');

const argv = process.argv.slice(2);
const input = argv[0];
if (!input) {
  console.error('用法：node web/dev/bench-report.mjs <benchmark.json> [--out-dir <dir>]');
  process.exit(1);
}
const outIdx = argv.indexOf('--out-dir');
const outDir = outIdx >= 0 && argv[outIdx + 1] ? argv[outIdx + 1] : path.join(taskRoot, 'outputs', 'logs');
fs.mkdirSync(outDir, { recursive: true });

const raw = JSON.parse(fs.readFileSync(input, 'utf8'));

function fmtBytes(n) {
  if (n == null) return '—';
  return (n / 1e6).toFixed(2) + ' MB';
}
function fmtRatio(n) {
  if (n == null) return '—';
  return n.toFixed(2) + '×';
}
function fmtMs(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n < 1000 ? n.toFixed(1) + ' ms' : (n / 1000).toFixed(2) + ' s';
}
function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}
function fmtNum(n, d = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(d);
}

const normalized = {
  app: raw.app,
  task: raw.task,
  generatedAt: raw.generatedAt,
  exportedAt: new Date().toISOString(),
  mode: raw.mode,
  k: raw.k,
  runs: raw.runs,
  env: raw.env,
  dataset: raw.dataset,
  configs: raw.configs,
};

const jsonPath = path.join(outDir, '2026-10-31_final-benchmark.json');
fs.writeFileSync(jsonPath, JSON.stringify(normalized, null, 2), 'utf8');

const configOrder = ['fp32-wasm', 'fp16-webgpu', 'int8-wasm'];
const byId = new Map((normalized.configs || []).map((c) => [c.id, c]));

const header =
  '| 配置 | 状态 | 模型体积 | 压缩比 | 模型加载 cold（load+warmup） | 文档向量化吞吐 | 查询向量化(中位) | seekdb 检索(中位) | 端到端 首次 | 端到端 预热后中位 | Recall@10 | nDCG@10 |';
const divider =
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
const rows = [];
for (const id of configOrder) {
  const c = byId.get(id);
  if (!c) {
    rows.push('| ' + id + ' | 未运行 | — | — | — | — | — | — | — | — | — | — |');
    continue;
  }
  if (c.status !== 'ok') {
    rows.push('| ' + c.label + ' | ' + c.status + (c.statusReason ? '：' + c.statusReason.replace(/\|/g, '/') : '') + ' | ' + fmtBytes(c.model?.onnxBytes) + ' | ' + fmtRatio(c.model?.compressionRatio) + ' | — | — | — | — | — | — | — | — |');
    continue;
  }
  const m = c.model ?? {};
  const s = c.summary ?? {};
  const loadAll = (m.loadMs ?? 0) + (m.warmupMs ?? 0);
  rows.push(
    '| ' +
      c.label +
      ' | 成功 | ' + fmtBytes(m.onnxBytes) +
      ' | ' + (c.dtype === 'fp32' ? '基线（1.00×）' : fmtRatio(m.compressionRatio)) +
      ' | ' + fmtMs(loadAll) + '（' + fmtMs(m.loadMs) + ' + ' + fmtMs(m.warmupMs) + '）' +
      ' | ' + fmtNum(c.vectorize?.docsPerSec) + ' docs/s' +
      ' | ' + fmtMs(s.embedMsMedian) +
      ' | ' + fmtMs(s.dbMsMedian) +
      ' | ' + fmtMs(s.firstRunE2eMs) +
      ' | ' + fmtMs(s.e2eMsMedian) +
      ' | ' + fmtPct(s.recall10) +
      ' | ' + fmtNum(s.ndcg10, 4) +
      ' |',
  );
}

const md = [];
md.push('# StepKB 最终基准测试（浏览器端侧推理 + seekdb 混合检索）');
md.push('');
md.push('- 生成时间：' + normalized.generatedAt + '（导出 ' + normalized.exportedAt + '）');
md.push('- 环境：' + normalized.env.userAgent);
md.push('- crossOriginIsolated=' + normalized.env.crossOriginIsolated +
  ' · WebGPU=' + (normalized.env.webgpuAvailable ? '可用（' + (normalized.env.webgpuAdapter || '') + '）' : '不可用') +
  ' · hardwareConcurrency=' + normalized.env.hardwareConcurrency);
md.push('- 数据：语料 ' + normalized.dataset.corpus + ' 篇 / 查询 ' + normalized.dataset.queries + ' 条 / qrels ' + normalized.dataset.qrels + ' 条（' + normalized.dataset.sources.join('、') + '）');
md.push('- 检索：hybrid 单条 SQL（MATCH(content) AGAINST + ORDER BY l2_distance(...) APPROXIMATE），k=' + normalized.k + '；每配置运行 ' + normalized.runs + ' 次，预热后取中位；Recall@10 / nDCG@10 为各次运行均值再取中位');
md.push('- 池化：CLS pooling + L2 归一化（向量在 Worker 内归一化后返回），query 不加 instruction');
md.push('- 体积口径：模型文件实际字节（manifest 校验），压缩比 = FP32 字节 / 该档字节');
md.push('');
md.push(header);
md.push(divider);
for (const row of rows) md.push(row);
md.push('');
md.push('## 说明');
md.push('');
md.push('- **模型加载 cold** = pipeline 构造（loadMs，含首次 HTTP 取模型 + ORT 初始化）+ 首次推理预热（warmupMs，含 WebGPU shader 编译）。');
md.push('- **端到端 首次** = 第 1 次运行（5 次里第一次）30 条查询端到端耗时的中位数；**预热后中位** = 第 2–5 次运行的中位数。');
md.push('- **查询向量化** 在浏览器 Worker 内计时（含 Worker 消息往返）；**seekdb 检索** 为服务端 SQL 执行耗时（performance.now 包住 client.execute）；**端到端** = 查询向量化 + HTTP 往返（含 seekdb）。');
md.push('- **文档向量化吞吐** = 50 篇语料向量化（含分批 Worker 调用）的总耗时换算，首次构建该配置的评测库时测得，未扣除写入 seekdb 时间。');
md.push('- WebGPU 不可用时 FP16+WebGPU 行会如实标记 skipped；本次运行三行均为实测。');
md.push('- 所有向量均由浏览器本地计算（无云端推理 API）；后端只做 SQL 转发。');
md.push('');

const mdPath = path.join(outDir, '2026-10-31_final-benchmark.md');
fs.writeFileSync(mdPath, md.join('\n'), 'utf8');
console.log('JSON: ' + jsonPath);
console.log('MD:   ' + mdPath);
console.log(md.join('\n'));
