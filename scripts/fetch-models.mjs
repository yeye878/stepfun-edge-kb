#!/usr/bin/env node
/**
 * fetch-models.mjs — 自托管 embedding 模型下载脚本（赛题 27「端侧 AI 推理优化与 seekdb 混合检索」）
 *
 * 目标模型：Xenova/bge-small-zh-v1.5（中文，512 维，CLS pooling；384 是同系列英文 bge-small-en-v1.5）
 * 落盘目录：web/public/models/bge-small-zh-v1.5/（浏览器同源加载，彻底规避 HF 直连失败）
 *
 * 为什么需要本脚本（而不是运行时从 HF 拉）：
 *   赛题 2.2 要求端侧推理，评委现场若访问 huggingface.co 失败 = 应用直接白屏。
 *   因此把 config/tokenizer + fp32/fp16/int8(q8) 三档 ONNX 全部自托管到同域静态目录。
 *
 * dtype → 文件名映射（已读 node_modules/@huggingface/transformers@4.3.2 源码核实，
 * 见 src/utils/dtypes.js 的 DEFAULT_DTYPE_SUFFIX_MAPPING）：
 *   fp32  → ''          → onnx/model.onnx
 *   fp16  → '_fp16'     → onnx/model_fp16.onnx
 *   int8  → '_int8'     → onnx/model_int8.onnx
 *   q8    → '_quantized'→ onnx/model_quantized.onnx   ← v4 的 q8 不是 int8 文件名！
 *   uint8 → '_uint8'    → onnx/model_uint8.onnx
 * 注意：web-ui 的降级链是 wasm+q8，所以 model_quantized.onnx 必须落盘；
 *       另在 HF 缺文件时自动用 model_int8.onnx 复制成 model_quantized.onnx 兜底（双向别名互备）。
 *
 * 每个文件都做完整性校验：
 *   - LFS 大文件（onnx/*）：比对 HF 文件树 API 的 lfs.oid（sha256）
 *   - 小文件（config/tokenizer）：比对 git blob sha1（sha1("blob <len>\0" + content)）
 *
 * 用法：
 *   node scripts/fetch-models.mjs             # 已存在且校验通过则跳过
 *   node scripts/fetch-models.mjs --force     # 强制重新下载
 *   HF_ENDPOINT=https://hf-mirror.com node scripts/fetch-models.mjs   # 镜像
 *   FETCH_SKIP_UINT8=1 node scripts/fetch-models.mjs                  # 不下载 uint8（可选档）
 *   HF_REVISION=main ...（默认 main）
 *
 * 产物：
 *   web/public/models/bge-small-zh-v1.5/{config.json,tokenizer.json,tokenizer_config.json,
 *     special_tokens_map.json,vocab.txt,quantize_config.json,onnx/*.onnx}
 *   web/public/models/bge-small-zh-v1.5/manifest.json   ← 前端解析体积/压缩比/文件名映射
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..');
const DEST_DIR = path.join(SRC_ROOT, 'web', 'public', 'models', 'bge-small-zh-v1.5');

const REPO = 'Xenova/bge-small-zh-v1.5';
const REVISION = process.env.HF_REVISION || 'main';
const ENDPOINT = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const RETRIES = Number(process.env.FETCH_RETRIES || 4);
const SKIP_UINT8 = process.env.FETCH_SKIP_UINT8 === '1';
const FORCE = process.argv.includes('--force');

/** 期望文件表：size/sha256/gitOid 全部取自 https://huggingface.co/api/models/Xenova/bge-small-zh-v1.5/tree/main?expand=true（2026-10-31 抓取） */
const FILES = [
  // ---- 元数据 / tokenizer（口径：模型体积必须含 tokenizer，否则会与别人对不上）----
  { path: 'config.json', role: 'meta', bytes: 716, gitOid: 'd590a6643f5dcdd0cfb0477e3c291488c16fc2d7' },
  { path: 'tokenizer.json', role: 'meta', bytes: 439125, gitOid: 'cdb3043fc938fc918c06e66cf704c2ba58f88747' },
  { path: 'tokenizer_config.json', role: 'meta', bytes: 367, gitOid: '3a59388f0fd1bd22dec2ce7902c1be8e1fb84107' },
  { path: 'special_tokens_map.json', role: 'meta', bytes: 125, gitOid: 'a8b3208c2884c4efb86e49300fdd3dc877220cdf' },
  { path: 'vocab.txt', role: 'meta', bytes: 109540, gitOid: 'ca4f9781030019ab9b253c6dcb8c7878b6dc87a5' },
  { path: 'quantize_config.json', role: 'meta', bytes: 674, gitOid: '1930f78444c1fa23c7c5dc01e60d98b19c6e2be9' },
  // ---- 三档量化 ONNX（必下）----
  { path: 'onnx/model.onnx', role: 'onnx', dtype: 'fp32', bytes: 94851877, sha256: '69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a' },
  { path: 'onnx/model_fp16.onnx', role: 'onnx', dtype: 'fp16', bytes: 47497427, sha256: '60d0fe5eb8d4e251d4b24dff010a2625c10a013503f0d09f625e8a9b0311315f' },
  { path: 'onnx/model_int8.onnx', role: 'onnx', dtype: 'int8', bytes: 23903394, sha256: 'b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5' },
  // ---- v4 的 dtype='q8' 实际读这个文件（WASM 降级路径）----
  { path: 'onnx/model_quantized.onnx', role: 'onnx', dtype: 'q8', bytes: 24010842, sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc' },
  // ---- 可选档：dtype='uint8' ----
  { path: 'onnx/model_uint8.onnx', role: 'onnx', dtype: 'uint8', bytes: 23903404, sha256: 'eac2f9cd2d4663cf0b3ffd372cb0162376726e4d14d7295fb36b0fe3f5edc7d2', optional: true },
];

/** 文件名兼容别名：目标缺失时由源文件复制（HF 仓若删了某个 dtype 文件也能跑）*/
const ALIASES = [
  { target: 'onnx/model_quantized.onnx', source: 'onnx/model_int8.onnx', why: "v4 dtype='q8' → *_quantized.onnx" },
  { target: 'onnx/model_int8.onnx', source: 'onnx/model_quantized.onnx', why: "v4 dtype='int8' → *_int8.onnx" },
];

const t0 = Date.now();
const log = (...a) => console.log(...a);
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const gitBlobSha1 = (buf) => crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');

function targetOf(rel) {
  return path.join(DEST_DIR, ...rel.split('/'));
}

/** 校验本地已有文件；返回 true=存在且完整 */
function verifyLocal(rel, spec) {
  const p = targetOf(rel);
  if (!fs.existsSync(p)) return { ok: false, reason: 'missing' };
  const st = fs.statSync(p);
  if (st.size !== spec.bytes) return { ok: false, reason: 'size ' + st.size + ' != ' + spec.bytes };
  const buf = fs.readFileSync(p);
  const want = spec.sha256 || spec.gitOid;
  const got = spec.sha256 ? s256(buf) : gitBlobSha1(buf);
  if (want && got !== want) return { ok: false, reason: 'hash mismatch' };
  return { ok: true, bytes: st.size };
}

async function downloadOne(spec) {
  const rel = spec.path;
  const url = ENDPOINT + '/' + REPO + '/resolve/' + REVISION + '/' + rel;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const t = Date.now();
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'stepkb-fetch-models/1.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== spec.bytes) throw new Error('size mismatch got=' + buf.length + ' want=' + spec.bytes);
      const want = spec.sha256 || spec.gitOid;
      const got = spec.sha256 ? s256(buf) : gitBlobSha1(buf);
      if (want && got !== want) throw new Error('hash mismatch got=' + got + ' want=' + want);
      const dest = targetOf(rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.part';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      const ms = Date.now() - t;
      log('  [downloaded] ' + rel.padEnd(30) + ' ' + mb(buf.length).padStart(9) + '  ' + (ms / 1000).toFixed(2) + ' s  ' + (buf.length / 1024 / (ms / 1000 + 0.001) / 1024).toFixed(2) + ' MB/s');
      return { bytes: buf.length, ms, verified: true, sha256: spec.sha256 || null, gitBlobSha1: spec.sha256 ? null : got };
    } catch (e) {
      log('  [retry ' + attempt + '/' + RETRIES + '] ' + rel + ' :: ' + e.message);
      if (attempt === RETRIES) throw e;
      await sleep(600 * 2 ** (attempt - 1));
    }
  }
}

function copyAlias(a, results) {
  const tgt = targetOf(a.target);
  if (fs.existsSync(tgt)) return null;
  const src = targetOf(a.source);
  if (!fs.existsSync(src)) return null;
  fs.mkdirSync(path.dirname(tgt), { recursive: true });
  fs.copyFileSync(src, tgt);
  const bytes = fs.statSync(tgt).size;
  const rec = { target: a.target, source: a.source, bytes, why: a.why };
  if (results) results.push(rec);
  log('  [alias] ' + a.target + ' <- ' + a.source + '  (' + mb(bytes) + ')  ' + a.why);
  return rec;
}

function buildManifest(results, aliases, failures) {
  const byPath = new Map(results.map((r) => [r.path, r]));
  const onnx = {};
  for (const f of FILES) {
    if (f.role !== 'onnx') continue;
    const rec = byPath.get(f.path);
    if (rec) onnx[f.dtype] = { file: f.path, bytes: rec.bytes, verified: rec.verified, sha256: f.sha256 || null };
  }
  const metaFiles = results.filter((r) => r.role === 'meta');
  const metaBytes = metaFiles.reduce((s, r) => s + r.bytes, 0);
  const fp32 = onnx.fp32 ? onnx.fp32.bytes : null;
  const ratio = (b) => (fp32 && b ? Number((fp32 / b).toFixed(4)) : null);
  const tierDownload = (dtype) => (onnx[dtype] ? onnx[dtype].bytes + metaBytes : null);
  const onDisk = results.reduce((s, r) => s + r.bytes, 0);
  const threeTierWeights = (onnx.fp32?.bytes || 0) + (onnx.fp16?.bytes || 0) + (onnx.int8?.bytes || 0);
  // onnx 同时以 onnx.{dtype}.file 与 files.{dtype}.path 两种键名呈现：
  // web-ui 按 onnx.* 解析、Lead schema 按 files.* 解析，二者取并集，避免下游互相等待。
  const fileEntries = {};
  for (const [dtype, v] of Object.entries(onnx)) {
    fileEntries[dtype] = { path: v.file, file: v.file, bytes: v.bytes, verified: v.verified, sha256: v.sha256 };
  }
  const ratioText = (dtype) => (ratio(onnx[dtype]?.bytes) == null ? null : ratio(onnx[dtype]?.bytes).toFixed(2) + 'x');
  return {
    // ---- 基本信息（web-ui 与 Lead 的字段取并集；见 2026-10-31 对齐消息）----
    model: 'bge-small-zh-v1.5',
    modelId: REPO,
    repo: REPO,
    // 真实维度：config.json hidden_size=512（2026-10-31 复核；384 是英文 bge-small-en-v1.5 的维度）
    dim: 512,
    pooling: 'cls',            // BGE v1.5 官方 CLS pooling（不是 mean！）
    normalize: true,           // 输出向量 L2 归一化
    normalizeMode: 'l2',
    maxLength: 512,
    onnx,                      // web-ui 口径: onnx.fp32.file / .bytes
    files: fileEntries,        // Lead 口径:  files.fp32.path / .bytes
    compressionRatio: {       // 压缩比 = fp32 权重体积 / 该档权重体积（题面 3.2 口径；不含 tokenizer）
      fp16: ratio(onnx.fp16?.bytes),
      int8: ratio(onnx.int8?.bytes),
      q8: ratio(onnx.q8?.bytes),
      uint8: ratio(onnx.uint8?.bytes),
    },
    compressionRatioText: {   // 同上的人类可读形式（Lead schema: "2.00x"）
      fp16: ratioText('fp16'),
      int8: ratioText('int8'),
      q8: ratioText('q8'),
      uint8: ratioText('uint8'),
    },
    // ---- 扩展信息（体积口径 + 可复现证据）----
    hfEndpoint: ENDPOINT,
    revision: REVISION,
    dtypeFileMap: {
      fp32: 'onnx/model.onnx',
      fp16: 'onnx/model_fp16.onnx',
      int8: 'onnx/model_int8.onnx',
      q8: 'onnx/model_quantized.onnx',
      uint8: 'onnx/model_uint8.onnx',
    },
    dtypeNote: "映射核实自 @huggingface/transformers@4.3.2 src/utils/dtypes.js DEFAULT_DTYPE_SUFFIX_MAPPING：fp32=''、fp16='_fp16'、int8='_int8'、q8='_quantized'、uint8='_uint8'",
    tokenizer: {
      files: metaFiles.map((r) => r.path),
      bytes: metaBytes,
      vocabSize: 21128,
    },
    totals: {
      // 单档权重字节数（扁平形式，Lead schema 要求 totals.fp32 为数字）
      fp32: onnx.fp32?.bytes || null,
      fp16: onnx.fp16?.bytes || null,
      int8: onnx.int8?.bytes || null,
      q8: onnx.q8?.bytes || null,
      tokenizer: metaBytes,
      weightsBytes: {
        fp32: onnx.fp32?.bytes || null,
        fp16: onnx.fp16?.bytes || null,
        int8: onnx.int8?.bytes || null,
        q8: onnx.q8?.bytes || null,
        uint8: onnx.uint8?.bytes || null,
      },
      // 单档完整下载量 = 权重 + tokenizer/config（正确口径，避免只报权重）
      downloadBytesPerTier: {
        fp32: tierDownload('fp32'),
        fp16: tierDownload('fp16'),
        int8: tierDownload('int8'),
        q8: tierDownload('q8'),
      },
      threeTierWeightsBytes: threeTierWeights,                                  // fp32+fp16+int8 权重合计
      threeTierDownloadBytes: threeTierWeights + metaBytes * 3,                  // 三档各自全量下载合计（上界）
      onDiskBytes: onDisk,                                                       // 目录实际占用
      onDiskHuman: mb(onDisk),
    },
    // 逐文件明细（数组；注意不要占用 files 键，files 是 web-ui/Lead 约定的 dtype 映射对象）
    fileList: results.map((r) => ({ path: r.path, role: r.role, dtype: r.dtype || null, bytes: r.bytes, verified: r.verified, source: r.source })),
    aliases,
    failures,
    generatedAt: new Date().toISOString(),
    elidedSeconds: Number(((Date.now() - t0) / 1000).toFixed(2)),
  };
}

(async () => {
  log('==========================================================');
  log(' fetch-models.mjs  ' + new Date().toISOString());
  log(' repo     : ' + REPO + ' @' + REVISION);
  log(' endpoint : ' + ENDPOINT);
  log(' dest     : ' + DEST_DIR);
  log('==========================================================');
  fs.mkdirSync(DEST_DIR, { recursive: true });

  const results = [];
  const failures = [];
  for (const spec of FILES) {
    if (spec.optional && SKIP_UINT8) { log('  [skip] ' + spec.path + ' (FETCH_SKIP_UINT8=1)'); continue; }
    const local = verifyLocal(spec.path, spec);
    if (local.ok && !FORCE) {
      log('  [ok       ] ' + spec.path.padEnd(30) + ' ' + mb(local.bytes).padStart(9) + '  (已存在且校验通过)');
      results.push({ ...spec, bytes: local.bytes, verified: true, source: 'existing' });
      continue;
    }
    if (!local.ok) log('  [need     ] ' + spec.path + '  (' + local.reason + ')');
    try {
      const r = await downloadOne(spec);
      results.push({ ...spec, ...r, source: 'hf' });
    } catch (e) {
      log('  [FAILED   ] ' + spec.path + ' :: ' + e.message);
      failures.push({ path: spec.path, error: e.message, optional: !!spec.optional });
    }
  }

  // 别名兜底（HF 缺某 dtype 文件时用另一份 int8 兼容名复制）
  const aliases = [];
  for (const a of ALIASES) copyAlias(a, aliases);

  const manifest = buildManifest(results, aliases, failures);
  const manifestPath = path.join(DEST_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  log('');
  log('----------------------------------------------------------');
  log(' 文件清单');
  for (const r of results) log('   ' + r.path.padEnd(30) + ' ' + String(r.bytes).padStart(12) + ' B  ' + mb(r.bytes).padStart(9));
  log(' 别名兼容: ' + (aliases.length ? JSON.stringify(aliases.map((a) => a.target + '<-' + a.source)) : '无（HF 三档文件齐全，无需复制）'));
  log(' 三档权重合计: ' + threeTierHuman(manifest) + '  (' + manifest.totals.threeTierWeightsBytes + ' B)');
  log(' 压缩比: ' + JSON.stringify(manifest.compressionRatio));
  log(' manifest: ' + manifestPath);
  log('----------------------------------------------------------');

  if (failures.length) {
    log('❌ 有 ' + failures.length + ' 个文件下载失败: ' + JSON.stringify(failures));
    const hard = failures.filter((f) => !f.optional);
    if (hard.length) process.exitCode = 1;
  } else {
    log('✅ 全部期望文件已落盘并通过完整性校验（sha256 / git-blob-sha1）');
  }
  log('总耗时: ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});

function threeTierHuman(m) {
  return mb(m.totals.threeTierWeightsBytes);
}
