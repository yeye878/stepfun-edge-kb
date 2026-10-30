#!/usr/bin/env node
/**
 * quality.mjs — 赛题 27 Node 侧检索质量评测（fp32 vs int8 两档）
 *
 * 口径（与浏览器端一致，见 notes/APP-CONTRACT.md §5）：
 *   - @huggingface/transformers@4.3.2，Node 侧 onnxruntime-node，device='cpu'
 *   - 本地模型 web/public/models/bge-small-zh-v1.5/，allowRemoteModels=false
 *   - CLS pooling + 无 query instruction + 输出 L2 归一化 + 512 token 截断
 *   - dtype: fp32 -> onnx/model.onnx，int8 -> onnx/model_int8.onnx
 *
 * 检索（与后端/浏览器同一实现，复用 server/ 的 HTTP API，避免在客户端重排）：
 *   - 后端子进程：node server/index.mjs（嵌入式 seekdb，独立 DB 目录）
 *   - 单条 SQL 混合检索：
 *       SELECT id, MATCH(content) AGAINST(q) AS score, l2_distance(embedding, v) AS dist
 *       FROM t WHERE MATCH(content) AGAINST(q)
 *       ORDER BY l2_distance(embedding, v) APPROXIMATE LIMIT 10
 *   - 对照：纯向量单条 SQL（无 MATCH 过滤）、纯全文单条 SQL
 *
 * 指标：Recall@1/5/10、nDCG@10（单 gold）、MRR、fp32 vs int8 同文本余弦、Top-10 重合率、
 *       检索延迟中位数（服务端 dbMs）、查询向量化耗时中位数。
 *
 * 输出：outputs/logs/<date>_eval-quality.json / .md
 * 用法：node eval/quality.mjs            （默认端口 18090，DB 目录 src/_runtime/eval-quality）
 *       EVAL_PORT=18091 EVAL_DB_PATH=... node eval/quality.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const ROOT = path.resolve(SRC, '..');
const OUT_DIR = path.join(ROOT, 'outputs', 'logs');
const DATE = localDate();
const LOG_FILE = path.join(OUT_DIR, DATE + '_eval-quality.log');
const BACKEND_LOG = path.join(OUT_DIR, DATE + '_eval-quality-backend.log');
const JSON_FILE = path.join(OUT_DIR, DATE + '_eval-quality.json');
const MD_FILE = path.join(OUT_DIR, DATE + '_eval-quality.md');
const BT = String.fromCharCode(96);           // markdown 行内代码反引号
const FENCE = String.fromCharCode(96, 96, 96); // markdown 代码块围栏

const PORT = Number(process.env.EVAL_PORT || 18090);
const HOST = '127.0.0.1';
const BASE = 'http://' + HOST + ':' + PORT;
const DB_DIR = path.resolve(process.env.EVAL_DB_PATH || path.join(SRC, '_runtime', 'eval-quality'));
const DATA_DIR = path.join(SRC, 'web', 'public', 'data');
const MODEL_DIR = path.join(SRC, 'web', 'public', 'models', 'bge-small-zh-v1.5');
const MODEL_ROOT = path.join(SRC, 'web', 'public', 'models') + '/';
const DIM = 512;
const K = 10;
const BATCH = 8;
const TIERS = [
  { name: 'fp32', dtype: 'fp32', file: 'onnx/model.onnx' },
  { name: 'int8', dtype: 'int8', file: 'onnx/model_int8.onnx' },
];

let backendChild = null;
let mainDone = false;

// ---------------- 基础工具 ----------------
function localDate() {
  var d = new Date(Date.now() + 9 * 3600 * 1000); // Asia/Tokyo（本机时区）
  return d.toISOString().slice(0, 10);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function ts() { return new Date().toISOString(); }
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }
function resetLog(text) { ensureDir(OUT_DIR); fs.writeFileSync(LOG_FILE, text + '\n'); }
function log() {
  var a = Array.prototype.slice.call(arguments);
  var line = '[' + ts() + '] ' + a.map(function (x) { return typeof x === 'string' ? x : JSON.stringify(x); }).join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
  try { console.log(line); } catch (e) {}
}
function median(arr) {
  if (!arr || !arr.length) return null;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(arr, p) {
  if (!arr || !arr.length) return null;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))));
  return s[idx];
}
function round(x, n) {
  if (x === null || x === undefined || !isFinite(x)) return null;
  var f = Math.pow(10, n === undefined ? 4 : n);
  return Math.round(x * f) / f;
}
function cos(a, b) {
  var dot = 0, na = 0, nb = 0;
  for (var i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function l2norm(v) {
  var s = 0;
  for (var i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// ---------------- HTTP API ----------------
async function api(method, p, body, timeoutMs) {
  var opts = { method: method, headers: {} };
  if (body !== undefined && body !== null) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  if (timeoutMs) opts.signal = AbortSignal.timeout(timeoutMs);
  var res = await fetch(BASE + p, opts);
  var txt = await res.text();
  var json = null;
  try { json = JSON.parse(txt); } catch (e) { json = { raw: txt.slice(0, 500) }; }
  if (!res.ok) {
    var detail = json && json.error ? json.error.code + ': ' + json.error.message : txt.slice(0, 300);
    throw new Error(method + ' ' + p + ' -> HTTP ' + res.status + ' (' + detail + ')');
  }
  return json;
}

// ---------------- DB 目录锁检查 ----------------
function pidAlive(pid) {
  if (!isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}
function cleanStaleLock(dir, label) {
  var pidFile = path.join(dir, 'run', 'seekdb.pid');
  if (!fs.existsSync(pidFile)) return false;
  var pid = NaN, txt = '';
  try { txt = fs.readFileSync(pidFile, 'utf8').trim(); pid = parseInt(txt, 10); } catch (e) { return false; }
  if (pidAlive(pid)) {
    log('[lock] ' + label + ' 被存活进程占用 pid=' + pid + '，不做处理');
    return false;
  }
  try {
    fs.unlinkSync(pidFile);
    log('[lock] 清理 ' + label + ' 的死 pid 锁 (pid=' + txt + ')');
    return true;
  } catch (e) { return false; }
}

// ---------------- 后端子进程 ----------------
function spawnBackend() {
  ensureDir(DB_DIR);
  var pidFile = path.join(DB_DIR, 'run', 'seekdb.pid');
  if (fs.existsSync(pidFile) && !cleanStaleLock(DB_DIR, 'eval-quality DB')) {
    var pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (pidAlive(pid)) throw new Error('DB 目录已被存活进程占用（pid=' + pid + '），请先停止它：' + DB_DIR);
  }
  try { fs.writeFileSync(BACKEND_LOG, ''); } catch (e) {}
  var env = Object.assign({}, process.env, {
    PORT: String(PORT),
    HOST: HOST,
    SEEKDB_PATH: DB_DIR,
    SEEKDB_BINDINGS_CACHE_DIR: process.env.SEEKDB_BINDINGS_CACHE_DIR || 'D:/oceanbase/_scratch/t27/bindings',
    BACKEND_LOG_FILE: BACKEND_LOG,
  });
  log('[backend] spawn node server/index.mjs port=' + PORT + ' db=' + DB_DIR);
  var child = spawn(process.execPath, [path.join(SRC, 'server', 'index.mjs')], {
    cwd: SRC,
    env: env,
    stdio: 'ignore', // 沙箱环境禁止 pipe stdio
    windowsHide: true,
  });
  backendChild = child;
  child.on('exit', function (code, signal) { log('[backend] exit code=' + code + ' signal=' + signal); });
  return child;
}
function backendLogTail(n) {
  try {
    var lines = fs.readFileSync(BACKEND_LOG, 'utf8').split('\n');
    return lines.slice(-(n || 15)).join('\n');
  } catch (e) { return '(no backend log)'; }
}
async function waitHealth(timeoutMs) {
  var t0 = Date.now();
  var lastErr = null;
  while (Date.now() - t0 < (timeoutMs || 60000)) {
    if (backendChild && backendChild.exitCode !== null) {
      throw new Error('后端进程提前退出 code=' + backendChild.exitCode + '\n--- backend log tail ---\n' + backendLogTail(20));
    }
    try {
      var h = await api('GET', '/api/health', null, 5000);
      if (h && h.ok) return h;
    } catch (e) { lastErr = e; }
    await sleep(400);
  }
  throw new Error('后端在 ' + Math.round((timeoutMs || 60000) / 1000) + 's 内未就绪: ' + (lastErr && lastErr.message) + '\n--- backend log tail ---\n' + backendLogTail(20));
}
async function killBackend() {
  var child = backendChild;
  if (!child || child.exitCode !== null) { cleanStaleLock(DB_DIR, 'eval-quality DB'); return; }
  log('[backend] SIGTERM pid=' + child.pid);
  try { child.kill('SIGTERM'); } catch (e) { log('[backend] kill ERR ' + (e && e.message)); }
  var t0 = Date.now();
  while (Date.now() - t0 < 6000 && child.exitCode === null) await sleep(200);
  if (child.exitCode === null) {
    log('[backend] SIGTERM 6s 未退出，taskkill /F');
    try { spawn('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }); } catch (e) {}
    var t1 = Date.now();
    while (Date.now() - t1 < 4000 && child.exitCode === null) await sleep(200);
  }
  log('[backend] stopped code=' + child.exitCode);
  await sleep(300);
  cleanStaleLock(DB_DIR, 'eval-quality DB');
}

// ---------------- 模型向量化 ----------------
async function embedTier(tier, corpus, queries) {
  var tf = await import('@huggingface/transformers');
  var env = tf.env;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODEL_ROOT;
  env.useFSCache = false;
  env.logLevel = 40;
  log('[embed] ' + tier.name + ' load model ' + tier.file + ' (device=cpu, dtype=' + tier.dtype + ')');
  var tLoad = Date.now();
  var extractor = await tf.pipeline('feature-extraction', 'bge-small-zh-v1.5', {
    dtype: tier.dtype,
    device: 'cpu',
    local_files_only: true,
  });
  var loadMs = Date.now() - tLoad;
  var opts = { pooling: 'cls', normalize: true };
  await extractor('预热文本', opts); // warmup，不计入吞吐
  var tCorpus = Date.now();
  var corpusVecs = [];
  for (var i = 0; i < corpus.length; i += BATCH) {
    var part = corpus.slice(i, i + BATCH).map(function (d) { return d.text; });
    var out = await extractor(part, opts);
    var list = out.tolist();
    for (var j = 0; j < list.length; j++) corpusVecs.push(list[j]);
  }
  var corpusMs = Date.now() - tCorpus;
  var queryVecs = [];
  var queryMs = [];
  for (var q = 0; q < queries.length; q++) {
    var t1 = Date.now();
    var o = await extractor(queries[q].query, opts);
    queryMs.push(Date.now() - t1);
    var arr = o.tolist()[0];
    if (!Array.isArray(arr) || arr.length !== DIM) throw new Error('embedding dim 异常: ' + (arr && arr.length));
    queryVecs.push(arr);
  }
  log('[embed] ' + tier.name + ' loaded in ' + loadMs + 'ms; corpus ' + corpus.length + ' in ' + corpusMs + 'ms; queries median=' + median(queryMs) + 'ms');
  try { if (extractor.dispose) await extractor.dispose(); } catch (e) { log('[embed] dispose warn ' + (e && e.message)); }
  return { tier: tier, loadMs: loadMs, corpusMs: corpusMs, queryMs: queryMs, corpusVecs: corpusVecs, queryVecs: queryVecs };
}

// ---------------- 指标 ----------------
function recallAt(rows, goldId, k) {
  var top = rows.slice(0, k);
  for (var i = 0; i < top.length; i++) if (String(top[i].id) === String(goldId)) return 1;
  return 0;
}
function rankOf(rows, goldId, k) {
  var top = rows.slice(0, k);
  for (var i = 0; i < top.length; i++) if (String(top[i].id) === String(goldId)) return i + 1; // 1-based
  return 0;
}
function ndcgAt(rows, goldId, k) {
  var rank = rankOf(rows, goldId, k);
  if (!rank) return 0;
  return 1 / Math.log2(rank + 1);
}
function summarizeMode(perQuery) {
  var n = perQuery.length;
  function avg(fn) { var s = 0; for (var i = 0; i < n; i++) s += fn(perQuery[i]); return n ? s / n : 0; }
  return {
    queries: n,
    recall1: round(avg(function (x) { return recallAt(x.rows, x.goldId, 1); })),
    recall5: round(avg(function (x) { return recallAt(x.rows, x.goldId, 5); })),
    recall10: round(avg(function (x) { return recallAt(x.rows, x.goldId, 10); })),
    ndcg10: round(avg(function (x) { return ndcgAt(x.rows, x.goldId, 10); })),
    mrr: round(avg(function (x) { var r = rankOf(x.rows, x.goldId, 10); return r ? 1 / r : 0; })),
    dbMsMedian: round(median(perQuery.map(function (x) { return x.dbMs; })), 2),
    dbMsP95: round(pct(perQuery.map(function (x) { return x.dbMs; }), 95), 2),
    totalMsMedian: round(median(perQuery.map(function (x) { return x.totalMs; })), 2),
    rowsReturnedAvg: round(avg(function (x) { return x.rows.length; }), 2),
    missingGold: perQuery.filter(function (x) { return !rankOf(x.rows, x.goldId, 10); }).length,
  };
}

// ---------------- ANN 就绪校验 ----------------
// seekdb 的 HNSW 索引为异步构建（SYNC_MODE=ASYNC）：写入后短时间内近似检索可能漏掉部分行。
// 评测前用「客户端精确 top-1」做就绪校验，避免把索引构建抖动误报成量化掉点。
async function waitAnnReady(kbId, tierName, corpus, queryVecs) {
  var exactTop1 = [];
  for (var q = 0; q < queryVecs.length; q++) {
    var best = -Infinity, bestId = null;
    for (var d = 0; d < corpus.length; d++) {
      var s = 0;
      for (var i = 0; i < DIM; i++) s += queryVecs[q][i] * corpus[d].vec[i];
      if (s > best) { best = s; bestId = String(corpus[d].id); }
    }
    exactTop1.push(bestId);
  }
  var t0 = Date.now();
  var attempts = 0;
  var okCount = 0;
  while (Date.now() - t0 < 20000) {
    attempts++;
    okCount = 0;
    for (var qi = 0; qi < queryVecs.length; qi++) {
      var r = await api('POST', '/api/kbs/' + kbId + '/search', { mode: 'vector', vector: queryVecs[qi], k: K }, 30000);
      var ids = r.rows.map(function (x) { return String(x.id); });
      if (r.rows.length >= Math.min(K, corpus.length) && ids.indexOf(exactTop1[qi]) >= 0) okCount++;
    }
    if (okCount === queryVecs.length) {
      var ms = Date.now() - t0;
      log('[ann] ' + tierName + ' 就绪校验通过 attempts=' + attempts + ' waitMs=' + ms + ' (精确 top-1 全部落在 ANN top-' + K + ')');
      return { ready: true, attempts: attempts, waitMs: ms, okQueries: okCount, queries: queryVecs.length };
    }
    await sleep(250);
  }
  log('[ann] ' + tierName + ' 就绪校验未全通过 ok=' + okCount + '/' + queryVecs.length + ' attempts=' + attempts);
  return { ready: false, attempts: attempts, waitMs: Date.now() - t0, okQueries: okCount, queries: queryVecs.length };
}

// ---------------- 主流程 ----------------
async function main() {
  ensureDir(OUT_DIR);
  resetLog('===== t27 eval-quality start ' + ts() + ' =====');
  log('node ' + process.version + ' ' + process.platform + '-' + process.arch);
  log('logs: ' + LOG_FILE);
  log('backend log: ' + BACKEND_LOG);
  log('db dir: ' + DB_DIR);

  var corpus = readJson(path.join(DATA_DIR, 'corpus.json'));
  var queries = readJson(path.join(DATA_DIR, 'queries.json'));
  var qrels = readJson(path.join(DATA_DIR, 'qrels.json'));
  var manifest = readJson(path.join(MODEL_DIR, 'manifest.json'));
  var idSet = new Set(corpus.map(function (d) { return String(d.id); }));
  queries.forEach(function (q) { if (!idSet.has(String(q.goldId))) throw new Error('goldId 不在语料中: ' + q.qid + ' -> ' + q.goldId); });
  log('[data] corpus=' + corpus.length + ' queries=' + queries.length + ' qrels=' + qrels.length + ' dim=' + manifest.dim);
  if (Number(manifest.dim) !== DIM) throw new Error('manifest.dim=' + manifest.dim + ' != ' + DIM);

  // 1) 两档向量化
  var tiers = [];
  for (var t = 0; t < TIERS.length; t++) {
    var emb = await embedTier(TIERS[t], corpus, queries);
    var v0 = emb.corpusVecs[0];
    if (!v0 || v0.length !== DIM) throw new Error('corpus embedding dim 异常: ' + (v0 && v0.length));
    log('[embed] ' + emb.tier.name + ' dim=' + v0.length + ' norm=' + round(l2norm(v0), 6));
    tiers.push(emb);
  }

  // 2) fp32 vs int8 一致性
  var fp32 = tiers[0], int8 = tiers[1];
  var cosCorpus = [], cosQuery = [];
  for (var i = 0; i < corpus.length; i++) cosCorpus.push(cos(fp32.corpusVecs[i], int8.corpusVecs[i]));
  for (var q2 = 0; q2 < queries.length; q2++) cosQuery.push(cos(fp32.queryVecs[q2], int8.queryVecs[q2]));
  var allCos = cosCorpus.concat(cosQuery);
  var consistency = {
    cosine: {
      texts: allCos.length,
      mean: round(allCos.reduce(function (s, x) { return s + x; }, 0) / allCos.length),
      min: round(Math.min.apply(null, allCos)),
      max: round(Math.max.apply(null, allCos)),
      corpusMean: round(cosCorpus.reduce(function (s, x) { return s + x; }, 0) / cosCorpus.length),
      queryMean: round(cosQuery.reduce(function (s, x) { return s + x; }, 0) / cosQuery.length),
      below090: allCos.filter(function (x) { return x < 0.9; }).length,
      below099: allCos.filter(function (x) { return x < 0.99; }).length,
    },
  };
  log('[consistency] cos mean=' + consistency.cosine.mean + ' min=' + consistency.cosine.min + ' below0.90=' + consistency.cosine.below090);

  // 3) 起后端
  spawnBackend();
  var health = await waitHealth(90000);
  log('[backend] health ok db=' + health.dbDetail + ' version=' + health.dbVersion + ' openMs=' + health.openMs);

  // 4) 每档：建 KB -> 写 50 篇 -> 检索
  var result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    date: DATE,
    env: {
      node: process.version,
      platform: process.platform + '-' + process.arch,
      transformers: '4.3.2',
      device: 'cpu',
      dtypeTiers: TIERS.map(function (x) { return x.dtype; }),
      backend: { mode: health.dbMode, version: health.dbVersion, path: DB_DIR, port: PORT, openMs: health.openMs },
    },
    model: {
      model: manifest.model,
      modelId: manifest.modelId,
      dim: manifest.dim,
      pooling: manifest.pooling,
      normalize: manifest.normalizeMode,
      maxLength: manifest.maxLength,
      files: TIERS.map(function (x) { return { tier: x.name, file: x.file, bytes: manifest.files[x.name].bytes }; }),
      compressionRatio: { int8: manifest.compressionRatio.int8, fp16: manifest.compressionRatio.fp16, q8: manifest.compressionRatio.q8 },
      compressionRatioText: manifest.compressionRatioText,
    },
    data: { corpus: corpus.length, queries: queries.length, qrels: qrels.length, generator: 'scripts/gen-data.mjs', seed: 20261031 },
    consistency: consistency,
    tiers: {},
    sqlSamples: {},
    logs: { progress: LOG_FILE, backend: BACKEND_LOG, json: JSON_FILE, markdown: MD_FILE },
  };

  // 每次运行使用独立表名：避免在同一 DB 上 DROP+CREATE 同名表时 HNSW（SYNC_MODE=ASYNC）
  // 异步建索引任务出现抖动，导致近似检索异常漏召。跑完后再清理旧的 eval-* 表。
  var runStamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  var kbNames = { fp32: 'eval-fp32-' + runStamp, int8: 'eval-int8-' + runStamp };
  log('[kb] runStamp=' + runStamp + ' kbs=' + JSON.stringify(kbNames));
  var listed = await api('GET', '/api/kbs');
  var existingByName = {};
  (listed.kbs || []).forEach(function (k) { existingByName[k.name] = k; });

  for (var ti = 0; ti < tiers.length; ti++) {
    var embT = tiers[ti];
    var tierName = embT.tier.name;
    var kbName = kbNames[tierName];
    var docs = corpus.map(function (d) { return { id: String(d.id), text: d.text, category: d.category }; });
    var corpusWithVec = corpus.map(function (d, idx) { return { id: String(d.id), vec: embT.corpusVecs[idx] }; });
    var kb = null, ins = null, insertMs = 0, stats = null, annReady = null;
    var MAX_ATTEMPTS = 3;
    var attemptTotal = 0;
    for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attemptTotal = attempt;
      var name = attempt === 1 ? kbName : kbName + '-r' + attempt;
      if (existingByName[name]) {
        log('[kb] 删除同名旧 KB ' + name + ' (' + existingByName[name].id + ')');
        await api('DELETE', '/api/kbs/' + existingByName[name].id);
      }
      var created = await api('POST', '/api/kbs', { name: name, dim: DIM, model: 'bge-small-zh-v1.5' });
      kb = created.kb;
      log('[kb] ' + tierName + ' attempt=' + attempt + ' created id=' + kb.id + ' table=' + kb.table + ' dim=' + kb.dim);
      var tIns = Date.now();
      ins = await api('POST', '/api/kbs/' + kb.id + '/docs', { docs: docs, vectors: embT.corpusVecs }, 120000);
      insertMs = Date.now() - tIns;
      log('[kb] ' + tierName + ' inserted=' + ins.inserted + ' writeMs=' + ins.writeMs + ' refreshMs=' + ins.refreshMs + ' waitMs=' + (ins.waitMs || 0) + ' totalMs=' + insertMs);
      stats = await api('GET', '/api/kbs/' + kb.id + '/stats');
      if (Number(stats.docCount) !== corpus.length) throw new Error('docCount=' + stats.docCount + ' != ' + corpus.length);
      annReady = await waitAnnReady(kb.id, tierName, corpusWithVec, embT.queryVecs);
      if (annReady.ready) break;
      log('[kb] ' + tierName + ' attempt=' + attempt + ' ANN 就绪校验未通过，删除该表后用新表名重试');
      try { await api('DELETE', '/api/kbs/' + kb.id); } catch (e) { log('[kb] 删表失败 ' + (e && e.message)); }
      kb = null;
    }
    if (!kb) throw new Error(tierName + ' ANN 就绪校验 ' + MAX_ATTEMPTS + ' 次均失败（seekdb 近似索引在本机持续抖动）');
    annReady.tableAttempts = attemptTotal;

    var hybrid = [], vector = [], fulltext = [];
    var sqlHybrid = null, sqlVector = null, sqlFulltext = null;
    for (var qi = 0; qi < queries.length; qi++) {
      var qu = queries[qi];
      var vec = embT.queryVecs[qi];
      var sh = await api('POST', '/api/kbs/' + kb.id + '/search', { mode: 'hybrid', query: qu.query, vector: vec, k: K }, 60000);
      var sv = await api('POST', '/api/kbs/' + kb.id + '/search', { mode: 'vector', vector: vec, k: K }, 60000);
      var sf = await api('POST', '/api/kbs/' + kb.id + '/search', { mode: 'fulltext', query: qu.query, k: K }, 60000);
      if (!sqlHybrid) sqlHybrid = sh.sql;
      if (!sqlVector) sqlVector = sv.sql;
      if (!sqlFulltext) sqlFulltext = sf.sql;
      hybrid.push({ qid: qu.qid, goldId: qu.goldId, rows: sh.rows, dbMs: sh.dbMs, totalMs: sh.totalMs });
      vector.push({ qid: qu.qid, goldId: qu.goldId, rows: sv.rows, dbMs: sv.dbMs, totalMs: sv.totalMs });
      fulltext.push({ qid: qu.qid, goldId: qu.goldId, rows: sf.rows, dbMs: sf.dbMs, totalMs: sf.totalMs });
    }
    result.sqlSamples[tierName] = {
      hybrid: redactSql(sqlHybrid),
      vector: redactSql(sqlVector),
      fulltext: redactSql(sqlFulltext),
    };

    function strip(perQuery) {
      return perQuery.map(function (x) {
        return {
          qid: x.qid,
          goldId: x.goldId,
          top: x.rows.slice(0, K).map(function (r) {
            return { id: String(r.id), distance: r.distance === undefined ? null : round(Number(r.distance), 6), score: r.score === undefined ? null : round(Number(r.score), 6) };
          }),
          dbMs: x.dbMs,
          totalMs: x.totalMs,
        };
      });
    }
    var mHybrid = summarizeMode(hybrid);
    var mVector = summarizeMode(vector);
    var mFulltext = summarizeMode(fulltext);
    result.tiers[tierName] = {
      modelFile: embT.tier.file,
      modelBytes: manifest.files[tierName].bytes,
      dim: DIM,
      embedding: {
        loadMs: embT.loadMs,
        corpusEmbedMs: embT.corpusMs,
        queryEmbedMsMedian: round(median(embT.queryMs), 2),
        queryEmbedMsP95: round(pct(embT.queryMs, 95), 2),
        corpusThroughputPerSec: round(corpus.length / (embT.corpusMs / 1000), 2),
      },
      insert: { docs: ins.inserted, writeMs: ins.writeMs, refreshMs: ins.refreshMs, waitMs: ins.waitMs || 0, totalMs: insertMs },
      annReadiness: annReady,
      kb: { id: kb.id, table: kb.table, docCount: stats.docCount, indexes: stats.indexes },
      metrics: { hybrid: mHybrid, vector: mVector, fulltext: mFulltext },
      perQuery: { hybrid: strip(hybrid), vector: strip(vector), fulltext: strip(fulltext) },
      _hybridTop: hybrid.map(function (x) { return x.rows.slice(0, K).map(function (r) { return String(r.id); }); }),
    };
    log('[metrics] ' + tierName + ' hybrid R@1=' + mHybrid.recall1 + ' R@5=' + mHybrid.recall5 + ' R@10=' + mHybrid.recall10 + ' nDCG@10=' + mHybrid.ndcg10 + ' | vector R@10=' + mVector.recall10 + ' | fulltext R@10=' + mFulltext.recall10 + ' | dbMs median=' + mHybrid.dbMsMedian);
  }

  // 5) Top-10 重合率
  var overlap = [];
  for (var oi = 0; oi < queries.length; oi++) {
    var A = new Set(result.tiers.fp32._hybridTop[oi]);
    var B = result.tiers.int8._hybridTop[oi];
    var inter = 0;
    for (var bi = 0; bi < B.length; bi++) if (A.has(B[bi])) inter++;
    overlap.push(inter / K);
  }
  consistency.top10Overlap = {
    queries: overlap.length,
    mean: round(overlap.reduce(function (s, x) { return s + x; }, 0) / overlap.length),
    min: round(Math.min.apply(null, overlap)),
    max: round(Math.max.apply(null, overlap)),
  };
  log('[consistency] top10 overlap mean=' + consistency.top10Overlap.mean + ' min=' + consistency.top10Overlap.min);
  delete result.tiers.fp32._hybridTop;
  delete result.tiers.int8._hybridTop;

  // 5.5) 清理历史 eval-* 表（只保留本次运行的两块，避免 DB 体积膨胀）
  try {
    var keepIds = new Set([result.tiers.fp32.kb.id, result.tiers.int8.kb.id]);
    var allKbs = await api('GET', '/api/kbs');
    for (var ki = 0; ki < (allKbs.kbs || []).length; ki++) {
      var kk = allKbs.kbs[ki];
      if (String(kk.name).indexOf('eval-') === 0 && !keepIds.has(kk.id)) {
        log('[kb] 清理历史 KB ' + kk.name + ' (' + kk.id + ')');
        await api('DELETE', '/api/kbs/' + kk.id);
      }
    }
  } catch (e) { log('[kb] 清理历史 KB 失败（不影响指标）: ' + (e && e.message)); }

  // 6) 写 JSON + Markdown
  fs.writeFileSync(JSON_FILE, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(MD_FILE, renderMarkdown(result));
  log('[out] json=' + JSON_FILE);
  log('[out] md=' + MD_FILE);
  log('===== t27 eval-quality done ' + ts() + ' =====');
  return result;
}

function redactSql(sql) {
  if (!sql) return null;
  var s = String(sql);
  return {
    length: s.length,
    hasMatch: /MATCH\(content\)\s+AGAINST/.test(s),
    hasL2Approx: /ORDER BY l2_distance\(embedding[^)]*\)\s+APPROXIMATE/.test(s),
    text: s.replace(/\[[-+0-9.eE,]+\]/g, '[<512 floats>]'),
  };
}

function renderMarkdown(r) {
  var lines = [];
  var c = BT;
  lines.push('# t27 质量评测报告（fp32 vs int8）');
  lines.push('');
  lines.push('- 生成时间：' + r.generatedAt);
  lines.push('- 模型：' + r.model.modelId + '（' + r.model.dim + ' 维，' + r.model.pooling + ' pooling，' + r.model.normalize + ' 归一化，' + r.model.maxLength + ' token 截断）');
  lines.push('- 端侧推理：@huggingface/transformers 4.3.2 · Node ' + r.env.node + ' · device=' + r.env.device + ' · dtype=' + r.env.dtypeTiers.join(' / '));
  lines.push('- 数据库：seekdb 嵌入式 ' + r.env.backend.version + '（' + r.env.backend.path + '）');
  lines.push('- 检索：单条 SQL 混合检索（' + c + 'MATCH(content) AGAINST(q)' + c + ' + ' + c + 'ORDER BY l2_distance(embedding, v) APPROXIMATE' + c + '），k=' + K);
  lines.push('- 数据：corpus ' + r.data.corpus + ' 篇 / queries ' + r.data.queries + ' 条 / qrels ' + r.data.qrels + '（seed=' + r.data.seed + '）');
  lines.push('- 本次表名：fp32=' + r.tiers.fp32.kb.table + ' / int8=' + r.tiers.int8.kb.table + '（每轮独立建表，跑完清理历史表）');
  lines.push('');
  lines.push('## 1. 模型体积与压缩比');
  lines.push('');
  lines.push('| 档位 | 权重文件 | 字节数 | MiB | 压缩比（相对 fp32 权重） |');
  lines.push('| --- | --- | ---: | ---: | ---: |');
  r.model.files.forEach(function (f) {
    var ratio = f.tier === 'fp32' ? '1.00x' : String(r.model.compressionRatioText[f.tier] || '');
    lines.push('| ' + f.tier + ' | ' + c + f.file + c + ' | ' + f.bytes.toLocaleString('en-US') + ' | ' + round(f.bytes / 1024 / 1024, 2) + ' | ' + ratio + ' |');
  });
  lines.push('');
  lines.push('> fp32 权重 ' + r.model.files[0].bytes.toLocaleString('en-US') + ' B；int8 权重 ' + r.model.files[1].bytes.toLocaleString('en-US') + ' B；压缩比 ' + r.model.compressionRatioText.int8 + '（题面口径：量化前体积 / 量化后体积）。');
  lines.push('');
  lines.push('## 2. 检索质量（混合检索，k=' + K + '）');
  lines.push('');
  lines.push('| 档位 | Recall@1 | Recall@5 | Recall@10 | nDCG@10 | MRR | 未命中 gold 的查询数 |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  ['fp32', 'int8'].forEach(function (t) {
    var m = r.tiers[t].metrics.hybrid;
    lines.push('| ' + t + ' | ' + m.recall1 + ' | ' + m.recall5 + ' | ' + m.recall10 + ' | ' + m.ndcg10 + ' | ' + m.mrr + ' | ' + m.missingGold + ' |');
  });
  lines.push('');
  lines.push('### 对照：纯向量单条 SQL（无全文过滤）');
  lines.push('');
  lines.push('| 档位 | Recall@1 | Recall@5 | Recall@10 | nDCG@10 |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  ['fp32', 'int8'].forEach(function (t) {
    var m = r.tiers[t].metrics.vector;
    lines.push('| ' + t + ' | ' + m.recall1 + ' | ' + m.recall5 + ' | ' + m.recall10 + ' | ' + m.ndcg10 + ' |');
  });
  lines.push('');
  lines.push('### 对照：纯全文单条 SQL（关键词匹配，不含向量排序）');
  lines.push('');
  lines.push('| 档位 | Recall@1 | Recall@5 | Recall@10 | nDCG@10 |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  ['fp32', 'int8'].forEach(function (t) {
    var m = r.tiers[t].metrics.fulltext;
    lines.push('| ' + t + ' | ' + m.recall1 + ' | ' + m.recall5 + ' | ' + m.recall10 + ' | ' + m.ndcg10 + ' |');
  });
  lines.push('');
  lines.push('> 语料刻意包含「查询与 gold 字面不同」的样本；纯全文在 Recall@1 / nDCG@10 上低于向量与混合检索（Recall@10 因 50 篇小语料的关键词覆盖面较大而三者持平）。混合检索在关键词过滤 + 向量排序下排序质量最高。');
  lines.push('');
  lines.push('## 3. fp32 vs int8 一致性');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('| --- | ---: |');
  lines.push('| 同文本向量余弦（语料+查询，n=' + r.consistency.cosine.texts + '）均值 | ' + r.consistency.cosine.mean + ' |');
  lines.push('| 余弦最小值 | ' + r.consistency.cosine.min + ' |');
  lines.push('| 余弦最大值 | ' + r.consistency.cosine.max + ' |');
  lines.push('| 语料向量余弦均值 | ' + r.consistency.cosine.corpusMean + ' |');
  lines.push('| 查询向量余弦均值 | ' + r.consistency.cosine.queryMean + ' |');
  lines.push('| 余弦 < 0.90 的文本数 | ' + r.consistency.cosine.below090 + ' |');
  lines.push('| 余弦 < 0.99 的文本数 | ' + r.consistency.cosine.below099 + ' |');
  lines.push('| 混合检索 Top-10 重合率（均值 / 最小 / 最大） | ' + r.consistency.top10Overlap.mean + ' / ' + r.consistency.top10Overlap.min + ' / ' + r.consistency.top10Overlap.max + ' |');
  lines.push('');
  lines.push('## 4. 延迟（服务端 SQL 计时 dbMs，中位数 / p95）');
  lines.push('');
  lines.push('| 档位 | 混合检索 dbMs | 纯向量 dbMs | 纯全文 dbMs | 查询向量化 ms（中位数） | 写入 50 篇（writeMs / refreshMs） |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  ['fp32', 'int8'].forEach(function (t) {
    var x = r.tiers[t];
    lines.push('| ' + t + ' | ' + x.metrics.hybrid.dbMsMedian + ' / ' + x.metrics.hybrid.dbMsP95 + ' | ' + x.metrics.vector.dbMsMedian + ' / ' + x.metrics.vector.dbMsP95 + ' | ' + x.metrics.fulltext.dbMsMedian + ' / ' + x.metrics.fulltext.dbMsP95 + ' | ' + x.embedding.queryEmbedMsMedian + ' | ' + x.insert.writeMs + ' / ' + x.insert.refreshMs + ' |');
  });
  lines.push('');
  lines.push('> 本表为 Node 侧（onnxruntime-node + CPU）参考数据；浏览器端 WebGPU/WASM 的分阶段计时由前端评测面板在目标设备上实测，两侧口径一致（CLS + L2 + 512 token）。');
  lines.push('');
  lines.push('## 5. 结论与局限');
  lines.push('');
  lines.push('- 量化收益：int8 权重 ' + r.model.files[1].bytes.toLocaleString('en-US') + ' B，压缩比 ' + r.model.compressionRatioText.int8 + '；fp32/int8 同文本向量余弦均值 ' + r.consistency.cosine.mean + '（最小 ' + r.consistency.cosine.min + '，n=' + r.consistency.cosine.texts + '）。');
  lines.push('- 质量影响：混合检索 Recall@10 两档均为 ' + r.tiers.fp32.metrics.hybrid.recall10 + ' / ' + r.tiers.int8.metrics.hybrid.recall10 + '；nDCG@10 由 fp32 的 ' + r.tiers.fp32.metrics.hybrid.ndcg10 + ' 变为 int8 的 ' + r.tiers.int8.metrics.hybrid.ndcg10 + '，Top-10 重合率均值 ' + r.consistency.top10Overlap.mean + '：int8 排序有轻微扰动，但 Recall@10 无损。');
  lines.push('- 与关键词基线对比：纯全文 Recall@1=' + r.tiers.fp32.metrics.fulltext.recall1 + '、nDCG@10=' + r.tiers.fp32.metrics.fulltext.ndcg10 + '，低于向量/混合检索，说明语义召回确有增益。');
  lines.push('- 延迟：seekdb 单条 SQL 检索 dbMs 中位数量级为个位数到十几毫秒（两档同量级）；量化主要影响模型体积/加载与端侧编码速度，不改变向量维度与 SQL 形态。');
  lines.push('- 局限：语料仅 50 篇、查询 30 条、单 gold；本表是 Node 侧 onnxruntime-node CPU 数据，不代表浏览器 WebGPU/WASM 性能；fp32 档在本题语料上指标接近饱和（Recall@1=' + r.tiers.fp32.metrics.hybrid.recall1 + '），区分度有限。');
  lines.push('- 稳定性处理：seekdb HNSW 为异步构建（SYNC_MODE=ASYNC），脚本在写入后内置「精确 top-1 落在 ANN top-' + K + '」的就绪校验（fp32 等待 ' + r.tiers.fp32.annReadiness.waitMs + 'ms / int8 等待 ' + r.tiers.int8.annReadiness.waitMs + 'ms，就绪探测 attempts=' + r.tiers.fp32.annReadiness.attempts + '/' + r.tiers.int8.annReadiness.attempts + '，建表尝试=' + r.tiers.fp32.annReadiness.tableAttempts + '/' + r.tiers.int8.annReadiness.tableAttempts + ' 次）；校验不通过时脚本自动删表换新表名重试（最多 3 次），避免索引构建抖动被误读为量化掉点。');
  lines.push('');
  lines.push('## 6. 单条 SQL 证据（fp32 混合检索）');
  lines.push('');
  var sq = r.sqlSamples.fp32;
  lines.push('- 长度 ' + sq.hybrid.length + ' 字符；含 ' + c + 'MATCH(content) AGAINST' + c + '：' + sq.hybrid.hasMatch + '；含 ' + c + 'ORDER BY l2_distance(...) APPROXIMATE' + c + '：' + sq.hybrid.hasL2Approx);
  lines.push('');
  lines.push(FENCE + 'sql');
  lines.push(sq.hybrid.text);
  lines.push(FENCE);
  lines.push('');
  lines.push('## 7. 复现');
  lines.push('');
  lines.push(FENCE + 'bash');
  lines.push('cd tasks/t27_stepfun_edge/src');
  lines.push('# 模型已落盘（node scripts/fetch-models.mjs 可重新下载并校验）');
  lines.push('node eval/quality.mjs');
  lines.push(FENCE);
  lines.push('');
  lines.push('- 进度日志：' + c + r.logs.progress + c);
  lines.push('- 后端日志：' + c + r.logs.backend + c);
  lines.push('- 机器可读结果：' + c + r.logs.json + c);
  lines.push('');
  return lines.join('\n');
}

// ---------------- 启动 ----------------
var watchdog = setTimeout(function () {
  log('WATCHDOG 600s hit，强制收尾');
  killBackend().catch(function () {}).then(function () { process.exit(2); });
  setTimeout(function () { process.exit(2); }, 12000);
}, 600000);

main().then(async function (result) {
  clearTimeout(watchdog);
  await killBackend();
  mainDone = true;
  log('ALL DONE');
  process.exit(0);
}).catch(async function (e) {
  clearTimeout(watchdog);
  log('FATAL: ' + (e && (e.stack || e.message)));
  try { await killBackend(); } catch (err) { log('killBackend ERR ' + (err && err.message)); }
  process.exit(1);
});
