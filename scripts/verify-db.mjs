#!/usr/bin/env node
// t27 数据层验收脚本：启动后端（嵌入式 seekdb）→ 建库 → 写入 → 单条 SQL 混合检索 → 刷新 → 索引证据
// 用法: node scripts/verify-db.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 18270);
const BASE = 'http://127.0.0.1:' + PORT;
const OUT_DIR = path.join(ROOT, '..', 'outputs', 'logs');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_FILE = path.join(OUT_DIR, stamp + '_db-verify.log');
const REPORT_FILE = path.join(OUT_DIR, stamp + '_db-verify.json');

fs.mkdirSync(OUT_DIR, { recursive: true });
const lines = [];
function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  lines.push(line);
  console.log(line);
}
function writeLog() {
  fs.writeFileSync(LOG_FILE, lines.join('\n') + '\n');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method: method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  if (!res.ok) throw new Error(method + ' ' + urlPath + ' -> ' + res.status + ' ' + text.slice(0, 500));
  return json;
}

function pseudoVector(seed, dim) {
  // 确定性伪随机单位向量（模拟浏览器 embedding 的输出形态，仅用于数据层验证）
  const out = new Array(dim);
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    const h = crypto.createHash('sha1').update(seed + ':' + i).digest();
    const v = (h[0] / 255 - 0.5) * 2;
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < dim; i++) out[i] = Number((out[i] / norm).toFixed(6));
  return out;
}

function buildCorpus() {
  const topics = [
    ['向量数据库', '向量数据库把文本编码成高维向量，通过近似最近邻检索快速找到语义相近的内容。'],
    ['相似度检索', '相似度检索关注两段文本在语义空间中的距离，常用于问答与推荐系统。'],
    ['混合检索', '混合检索同时利用全文关键词匹配与向量语义召回，再把两路结果融合排序。'],
    ['倒排索引', '倒排索引把词项映射到包含它的文档列表，是全文检索的基础结构。'],
    ['HNSW 图索引', 'HNSW 通过分层可导航小世界图实现高效的近似最近邻查询。'],
    ['分块策略', '把长文档切成适合模型输入长度的小块，可以提升检索的命中率。'],
    ['中文分词', '中文分词器把连续汉字切成词项，ik 分词器支持细粒度与智能切分。'],
    ['端侧推理', '端侧推理让模型在用户设备本地运行，数据不出本机，隐私更好。'],
    ['模型量化', '量化把浮点权重压缩成更低位宽，显著减小模型体积并加速推理。'],
    ['WebGPU', 'WebGPU 让浏览器直接调用显卡并行计算能力，适合加速矩阵运算。'],
  ];
  const docs = [];
  for (let i = 0; i < 60; i++) {
    const t = topics[i % topics.length];
    const extra = i >= topics.length ? '（补充说明 ' + i + '：' + t[0] + '在实际系统里需要考虑缓存、批量与一致性。）' : '';
    docs.push({
      id: 'doc-' + String(i).padStart(3, '0'),
      text: '第 ' + (i + 1) + ' 篇：' + t[0] + '——' + t[1] + extra,
      category: i % 3 === 0 ? 'docs' : (i % 3 === 1 ? 'guide' : 'faq'),
      meta: { topic: t[0], idx: i },
    });
  }
  return docs;
}

async function main() {
  log('=== t27 数据层验收开始 ===');
  log('node ' + process.version + ' / ' + process.platform + '-' + process.arch);
  log('log file: ' + LOG_FILE);

  const serverOut = fs.openSync(path.join(OUT_DIR, stamp + '_db-verify-server.log'), 'a');
  const env = Object.assign({}, process.env, { PORT: String(PORT) });
  if (!env.SEEKDB_BINDINGS_CACHE_DIR && fs.existsSync('D:/oceanbase/_scratch/t27/bindings')) {
    env.SEEKDB_BINDINGS_CACHE_DIR = 'D:/oceanbase/_scratch/t27/bindings';
    log('SEEKDB_BINDINGS_CACHE_DIR=' + env.SEEKDB_BINDINGS_CACHE_DIR);
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    env: env,
    stdio: ['ignore', serverOut, serverOut],
    windowsHide: true,
  });
  log('server pid=' + child.pid);

  let health = null;
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    try {
      health = await api('GET', '/api/health');
      break;
    } catch (e) {
      await sleep(500);
    }
  }
  if (!health) {
    const serverLogPath = path.join(OUT_DIR, stamp + '_db-verify-server.log');
    let serverLog = '';
    try { serverLog = fs.readFileSync(serverLogPath, 'utf8').split('\n').slice(-20).join('\n'); } catch (e) { serverLog = '(no server log)'; }
    throw new Error('backend did not become healthy in 60s (exitCode=' + child.exitCode + ')\n--- server log tail ---\n' + serverLog);
  }
  log('health ok after ' + (Date.now() - t0) + 'ms: ' + JSON.stringify(health));

  const report = { startedAt: new Date().toISOString(), health: health, steps: {}, artifacts: {} };

  const kbName = '验收知识库';
  const created = await api('POST', '/api/kbs', { name: kbName, dim: 512, model: 'bge-small-zh-v1.5' });
  const kb = created.kb;
  log('kb created: ' + JSON.stringify(kb));
  if (kb.dim !== 512) throw new Error('kb dim mismatch: ' + kb.dim);
  report.kb = kb;

  const docs = buildCorpus();
  const vectors = docs.map((d) => pseudoVector(d.text, 512));
  const batches = [];
  const tWrite0 = Date.now();
  for (let i = 0; i < docs.length; i += 20) {
    const part = docs.slice(i, i + 20);
    const partVec = vectors.slice(i, i + 20);
    const r = await api('POST', '/api/kbs/' + kb.id + '/docs', { docs: part, vectors: partVec, batchId: 'batch-' + i });
    batches.push(r);
    log('batch ' + (i / 20) + ' inserted=' + r.inserted + ' writeMs=' + r.writeMs + ' refreshMs=' + r.refreshMs);
  }
  const writeTotalMs = Date.now() - tWrite0;
  report.steps.write = { batches: batches.length, docs: docs.length, totalMs: writeTotalMs };

  const refresh = await api('POST', '/api/kbs/' + kb.id + '/refresh');
  log('refresh: ' + JSON.stringify(refresh));
  report.steps.refresh = refresh;

  const stats = await api('GET', '/api/kbs/' + kb.id + '/stats');
  log('stats: docCount=' + stats.docCount + ' indexes=' + JSON.stringify(stats.indexes));
  report.steps.stats = stats;
  const hasFts = stats.indexes.some((x) => x.type === 'FULLTEXT');
  const hasVec = stats.indexes.some((x) => x.type === 'VECTOR');
  if (!hasFts || !hasVec) throw new Error('missing FULLTEXT/VECTOR index: ' + JSON.stringify(stats.indexes));

  const q = '向量数据库';
  const qvec = pseudoVector('向量数据库 的 语义 检索', 512);
  const search = await api('POST', '/api/kbs/' + kb.id + '/search', { mode: 'hybrid', query: q, vector: qvec, k: 5 });
  log('hybrid rows=' + search.rows.length + ' dbMs=' + search.dbMs + ' sql=' + search.sql.slice(0, 260));
  report.steps.hybridSearch = { mode: search.mode, rows: search.rows.length, dbMs: search.dbMs, totalMs: search.totalMs, sql: search.sql, top: search.rows.slice(0, 3) };
  if (!search.rows.length) throw new Error('hybrid search returned no rows');
  if (!/MATCH\(content\) AGAINST/.test(search.sql) || !/l2_distance\(embedding/.test(search.sql) || !/APPROXIMATE/.test(search.sql)) {
    throw new Error('hybrid SQL does not contain MATCH + l2_distance + APPROXIMATE');
  }

  const vectorOnly = await api('POST', '/api/kbs/' + kb.id + '/search', { mode: 'vector', vector: qvec, k: 5 });
  const fulltextOnly = await api('POST', '/api/kbs/' + kb.id + '/search', { mode: 'fulltext', query: q, k: 5 });
  log('vector rows=' + vectorOnly.rows.length + ' dbMs=' + vectorOnly.dbMs + ' | fulltext rows=' + fulltextOnly.rows.length + ' dbMs=' + fulltextOnly.dbMs);
  report.steps.vectorSearch = { rows: vectorOnly.rows.length, dbMs: vectorOnly.dbMs, sql: vectorOnly.sql };
  report.steps.fulltextSearch = { rows: fulltextOnly.rows.length, dbMs: fulltextOnly.dbMs, sql: fulltextOnly.sql };

  const dbinfo = await api('GET', '/api/db/info');
  log('db info: ' + JSON.stringify(dbinfo));
  report.steps.dbInfo = dbinfo;

  report.artifacts = { log: LOG_FILE, serverLog: path.join(OUT_DIR, stamp + '_db-verify-server.log'), report: REPORT_FILE };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  log('report: ' + REPORT_FILE);

  // 关闭：SIGTERM → 观察是否退出（嵌入式原生插件清理可能阻塞，服务端有看门狗兜底）
  const kill0 = Date.now();
  child.kill('SIGTERM');
  let exited = false;
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) { exited = true; break; }
    await sleep(250);
  }
  log('server exited=' + exited + ' after ' + (Date.now() - kill0) + 'ms code=' + child.exitCode);
  if (!exited) {
    try { spawn('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }); } catch (e) { /* ignore */ }
    log('force killed server (watchdog fallback)');
  }
  report.steps.shutdown = { exited: exited, ms: Date.now() - kill0 };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  writeLog();
  log('=== 验收通过 ===');
}

main().then(() => { writeLog(); process.exit(0); }).catch((e) => {
  log('FATAL: ' + (e && (e.stack || e.message)));
  writeLog();
  process.exit(1);
});
