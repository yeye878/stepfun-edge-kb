/**
 * 开发联调用的 MOCK 后端（内存实现）——不是 seekdb，不能用于验收。
 *
 * 用途：Lead 的 server/（真实 seekdb 单条 SQL 混合检索）就绪前，让前端 UI/接口先跑通。
 * 启动：node web/dev/mock-server.mjs    （监听 127.0.0.1:18270，与契约一致）
 * 前端：npm run dev:web -> http://127.0.0.1:18271
 *
 * 真实后端就绪后必须改用 npm run dev:server / npm start；接口字段与 APP-CONTRACT 3 节一致，
 * 但数据库行为（向量检索/全文检索/SQL 耗时）全部是内存模拟，SQL 文本带 MOCK 注释，避免误导。
 */

import express from 'express';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT ?? 18270);
const HOST = process.env.MOCK_HOST ?? '127.0.0.1';
const DIM_DEFAULT = 512; // 注意：bge-small-zh-v1.5 实际输出 512 维（config.json hidden_size=512）
const createdAt = new Date().toISOString();

const app = express();
app.use(express.json({ limit: '64mb' }));

/** @type {Map<string, any>} */
const kbs = new Map();

function slugId(name) {
  const hash = crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 8);
  return 'kb_' + hash;
}

function tableName(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'kb';
  return 'kb_' + slug + '_' + crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 4);
}

function createTableSql(kb) {
  return [
    'CREATE TABLE ' + kb.table + ' (',
    '  id VARCHAR(128) PRIMARY KEY,',
    '  content TEXT NOT NULL,',
    '  category VARCHAR(64) DEFAULT NULL,',
    '  meta JSON DEFAULT NULL,',
    '  embedding VECTOR(' + kb.dim + ') NOT NULL,',
    '  FULLTEXT INDEX ft_content (content) WITH PARSER ik,',
    '  VECTOR INDEX vec_embedding (embedding)',
    '    WITH (distance=l2, type=hnsw, lib=vsag, m=16, ef_construction=200, ef_search=100)',
    ') ORGANIZATION = HEAP;',
  ].join('\n');
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function ensureKb(body) {
  const name = String((body && body.name) || '').trim();
  if (!name) throw httpError(400, 'BAD_REQUEST', 'name 不能为空');
  const id = slugId(name);
  let kb = kbs.get(id);
  if (kb) return kb;
  kb = {
    id,
    name,
    table: tableName(name),
    dim: Number((body && body.dim) || DIM_DEFAULT),
    model: String((body && body.model) || 'bge-small-zh-v1.5'),
    createdAt,
    docs: new Map(),
  };
  kbs.set(id, kb);
  return kb;
}

function kbView(kb) {
  return {
    id: kb.id,
    name: kb.name,
    table: kb.table,
    dim: kb.dim,
    model: kb.model,
    docCount: kb.docs.size,
    createdAt: kb.createdAt,
  };
}

function escapeSqlString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\u0000-\u001f]/g, ' ');
}

function sqlVector(vec) {
  return '[' + vec.map((v) => (Number.isFinite(v) ? Number(v).toFixed(6) : '0')).join(',') + ']';
}

function toVector(raw) {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return Array.isArray(raw) ? raw : null;
}

function getKbOr404(id) {
  const kb = kbs.get(id);
  if (!kb) throw httpError(404, 'KB_NOT_FOUND', '知识库不存在：' + id);
  return kb;
}

function l2Distance(a, b) {
  // 输入为已 L2 归一化向量：L2 平方 = 2 - 2cos
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.sqrt(Math.max(0, 2 - 2 * dot));
}

function cjkTokens(text) {
  const str = String(text);
  const set = new Set();
  const latin = str.toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
  for (const word of latin) set.add(word);
  const clean = str.replace(/[\s\p{P}\p{S}]/gu, '');
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function fulltextScore(query, content) {
  const q = cjkTokens(query);
  if (q.size === 0) return 0;
  const c = cjkTokens(content);
  let hit = 0;
  for (const token of q) if (c.has(token)) hit += 1;
  return hit / q.size;
}

function sendError(res, err) {
  const status = (err && err.status) || 500;
  res.status(status).json({ error: { code: (err && err.code) || 'INTERNAL', message: (err && err.message) || String(err) } });
}

const MOCK_NOTE = '/* MOCK 后端（内存模拟，非 seekdb 执行） */';

/* ------------------------------- routes -------------------------------- */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, dbMode: 'embedded', dbVersion: 'MOCK-dev（非 seekdb，仅联调）', uptimeMs: Math.round(performance.now()) });
});

app.get('/api/kbs', (_req, res) => {
  res.json({ kbs: [...kbs.values()].map(kbView) });
});

app.post('/api/kbs', (req, res) => {
  try {
    const kb = ensureKb(req.body);
    res.json({ kb: kbView(kb) });
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/kbs/:id', (req, res) => {
  const kb = kbs.get(req.params.id);
  if (!kb) return res.status(404).json({ error: { code: 'KB_NOT_FOUND', message: '知识库不存在' } });
  kbs.delete(kb.id);
  res.json({ ok: true });
});

app.post('/api/kbs/:id/docs', (req, res) => {
  try {
    const kb = getKbOr404(req.params.id);
    const docs = Array.isArray(req.body && req.body.docs) ? req.body.docs : [];
    const vectors = Array.isArray(req.body && req.body.vectors) ? req.body.vectors : [];
    if (docs.length !== vectors.length) throw httpError(400, 'BAD_REQUEST', 'docs 与 vectors 长度不一致');
    const t0 = performance.now();
    let inserted = 0;
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const vec = toVector(vectors[i]);
      if (!doc || typeof doc.text !== 'string' || !doc.text.trim()) {
        throw httpError(400, 'BAD_REQUEST', '第 ' + i + ' 篇文档缺少 text');
      }
      if (!vec || vec.length !== kb.dim || vec.some((v) => !Number.isFinite(v))) {
        throw httpError(400, 'BAD_REQUEST', '第 ' + i + ' 个向量维度/数值非法（期望 ' + kb.dim + ' 维）');
      }
      const id = typeof doc.id === 'string' && doc.id
        ? doc.id
        : 'd_' + crypto.createHash('sha1').update(doc.text).digest('hex').slice(0, 16);
      kb.docs.set(id, { id, text: doc.text, category: doc.category || null, meta: doc.meta || null, embedding: vec });
      inserted += 1;
    }
    const writeMs = performance.now() - t0;
    const refreshStart = performance.now();
    const docCount = kb.docs.size;
    const refreshMs = performance.now() - refreshStart;
    res.json({ inserted, total: docCount, writeMs, refreshMs });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/kbs/:id/refresh', (req, res) => {
  try {
    const kb = getKbOr404(req.params.id);
    const t0 = performance.now();
    const docCount = kb.docs.size;
    const refreshMs = performance.now() - t0 + 0.4;
    res.json({ ok: true, docCount, refreshMs });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/kbs/:id/search', (req, res) => {
  try {
    const kb = getKbOr404(req.params.id);
    const mode = String((req.body && req.body.mode) || 'hybrid');
    if (!['hybrid', 'vector', 'fulltext'].includes(mode)) {
      throw httpError(400, 'BAD_REQUEST', 'mode 必须是 hybrid | vector | fulltext');
    }
    const query = String((req.body && req.body.query) || '');
    if (!query.trim()) throw httpError(400, 'BAD_REQUEST', 'query 不能为空');
    const k = Math.min(100, Math.max(1, Number((req.body && req.body.k) || 10)));
    const vector = toVector(req.body && req.body.vector);
    if (mode !== 'fulltext' && (!vector || vector.length !== kb.dim)) {
      throw httpError(400, 'BAD_REQUEST', 'vector 缺失或维度不符（期望 ' + kb.dim + ' 维）');
    }
    const t0 = performance.now();
    const rows = [];
    for (const doc of kb.docs.values()) {
      const score = mode === 'vector' ? null : fulltextScore(query, doc.text);
      if (mode !== 'vector' && score === 0) continue;
      const distance = mode === 'fulltext' ? null : l2Distance(vector, doc.embedding);
      rows.push({ ...doc, score, distance });
    }
    rows.sort((a, b) => {
      if (mode === 'fulltext') return (b.score || 0) - (a.score || 0);
      return (a.distance || 0) - (b.distance || 0);
    });
    const top = rows.slice(0, k);
    const dbMs = performance.now() - t0;
    let sql;
    if (mode === 'hybrid') {
      sql = MOCK_NOTE + '\n' +
        'SELECT id, content, category, meta,\n' +
        "       MATCH(content) AGAINST('" + escapeSqlString(query) + "') AS score,\n" +
        "       l2_distance(embedding, '" + sqlVector(vector) + "') AS distance\n" +
        'FROM ' + kb.table + '\n' +
        "WHERE MATCH(content) AGAINST('" + escapeSqlString(query) + "')\n" +
        "ORDER BY l2_distance(embedding, '" + sqlVector(vector) + "') APPROXIMATE\n" +
        'LIMIT ' + k + ';';
    } else if (mode === 'vector') {
      sql = MOCK_NOTE + '\n' +
        'SELECT id, content, category, meta,\n' +
        "       l2_distance(embedding, '" + sqlVector(vector) + "') AS distance\n" +
        'FROM ' + kb.table + '\n' +
        "ORDER BY l2_distance(embedding, '" + sqlVector(vector) + "') APPROXIMATE\n" +
        'LIMIT ' + k + ';';
    } else {
      sql = MOCK_NOTE + '\n' +
        "SELECT id, content, category, meta, MATCH(content) AGAINST('" + escapeSqlString(query) + "') AS score\n" +
        'FROM ' + kb.table + '\n' +
        "WHERE MATCH(content) AGAINST('" + escapeSqlString(query) + "')\n" +
        'ORDER BY score DESC\nLIMIT ' + k + ';';
    }
    res.json({
      mode,
      k,
      rows: top.map((row) => ({
        id: row.id,
        text: row.text,
        category: row.category,
        meta: row.meta,
        distance: row.distance,
        score: row.score,
      })),
      sql,
      dbMs,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/kbs/:id/stats', (req, res) => {
  try {
    const kb = getKbOr404(req.params.id);
    const sample = [...kb.docs.values()][0];
    const sampleVec = sample ? sample.embedding : new Array(kb.dim).fill(0);
    res.json({
      docCount: kb.docs.size,
      createTableSql: createTableSql(kb),
      indexes: [
        { name: 'PRIMARY', type: 'BTREE', columns: 'id' },
        { name: 'ft_content', type: 'FULLTEXT (ik)', columns: 'content' },
        { name: 'vec_embedding', type: 'VECTOR (hnsw, vsag, l2)', columns: 'embedding' },
      ],
      sampleHybridSql: MOCK_NOTE + '\n' +
        "SELECT id, content, MATCH(content) AGAINST('示例查询') AS score,\n" +
        "       l2_distance(embedding, '" + sqlVector(sampleVec) + "') AS distance\n" +
        'FROM ' + kb.table + " WHERE MATCH(content) AGAINST('示例查询')\n" +
        "ORDER BY l2_distance(embedding, '" + sqlVector(sampleVec) + "') APPROXIMATE LIMIT 3;",
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/db/info', (_req, res) => {
  res.json({
    mode: 'mock-dev',
    version: 'MOCK-dev（非 seekdb；真实库请启动 server/index.mjs）',
    bindings: 'n/a',
    path: 'in-memory',
    showCreateTable: null,
    showIndex: null,
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'mock 后端只实现 APP-CONTRACT 3 节的 /api 路由' } });
});

const server = app.listen(PORT, HOST, () => {
  console.log('[mock] 开发联调 MOCK 后端已启动：http://' + HOST + ':' + PORT);
  console.log('[mock] 这是内存模拟，不是 seekdb；验收必须使用 server/index.mjs。');
  console.log('[mock] API: GET /api/health /api/kbs /api/db/info; POST /api/kbs /api/kbs/:id/{docs,refresh,search}; GET /api/kbs/:id/stats');
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
