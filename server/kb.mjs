// t27 知识库数据层：注册表 + 每库一表（FULLTEXT ik + VECTOR l2/hnsw）+ 单条 SQL 混合检索
import crypto from 'node:crypto';

// bge-small-zh-v1.5 输出 512 维（config.json hidden_size=512；384 维是英文 bge-small-en-v1.5）
const DEFAULT_DIM = 512;
const DEFAULT_MODEL = 'bge-small-zh-v1.5';
const TABLE_PREFIX = 'kb_';
const MAX_TEXT = 4000;
const MAX_QUERY = 200;
const MAX_VECTOR_DIM = 2048;
const VECTOR_INDEX_CLAUSE = 'WITH (distance=l2, type=hnsw, lib=vsag, m=16, ef_construction=200, ef_search=100)';

const REGISTRY_DDL = 'CREATE TABLE IF NOT EXISTS kb_registry (' +
  'id VARCHAR(64) PRIMARY KEY, ' +
  'name VARCHAR(128) NOT NULL, ' +
  'table_name VARCHAR(64) NOT NULL, ' +
  'model VARCHAR(128) NOT NULL, ' +
  'dim INT NOT NULL, ' +
  'created_at VARCHAR(32) NOT NULL' +
  ') ORGANIZATION = HEAP';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function nowIso() { return new Date().toISOString(); }

function registryId(name, model, dim) {
  const h = crypto.createHash('sha1').update(name + '|' + model + '|' + dim).digest('hex').slice(0, 10);
  return 'k' + h;
}

export function tableName(kbId) {
  if (!/^k[a-z0-9]{8,16}$/.test(String(kbId))) throw new HttpError(400, 'bad_kb_id', 'invalid kb id: ' + kbId);
  return TABLE_PREFIX + kbId;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// 用于 MATCH ... AGAINST('...') 的字面量：去控制字符、长度上限、转义反斜杠与单引号
export function escapeMatchLiteral(text) {
  let s = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!s) throw new HttpError(400, 'empty_query', 'query is empty');
  if (s.length > MAX_QUERY) s = s.slice(0, MAX_QUERY);
  s = s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return s;
}

// 向量字面量：只允许有限数字
export function vectorLiteral(vec, dim) {
  if (!Array.isArray(vec) || vec.length === 0) throw new HttpError(400, 'bad_vector', 'vector is required');
  if (vec.length !== dim) throw new HttpError(400, 'bad_vector_dim', 'vector dim ' + vec.length + ' != kb dim ' + dim);
  if (vec.length > MAX_VECTOR_DIM) throw new HttpError(400, 'bad_vector_dim', 'vector too long');
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const n = Number(vec[i]);
    if (!Number.isFinite(n)) throw new HttpError(400, 'bad_vector', 'vector has non-finite value at ' + i);
    out[i] = n;
  }
  return '[' + out.join(',') + ']';
}

function rowToKb(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    table: row.table_name,
    model: row.model,
    dim: Number(row.dim),
    createdAt: row.created_at,
  };
}

async function countRows(db, table) {
  const rows = await db.execute('SELECT COUNT(*) AS c FROM ' + table);
  const row = Array.isArray(rows) && rows[0];
  if (!row) return 0;
  const v = row.c !== undefined ? row.c : Object.values(row)[0];
  return Number(v) || 0;
}

export async function initSchema(db) {
  await db.execute(REGISTRY_DDL);
  await db.execute('CREATE TABLE IF NOT EXISTS kb_meta (k VARCHAR(64) PRIMARY KEY, v VARCHAR(255) NOT NULL) ORGANIZATION = HEAP');
}

async function findRegistryRow(db, id) {
  const rows = await db.execute('SELECT * FROM kb_registry WHERE id = ?', [id]);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function getKb(db, id) {
  const row = await findRegistryRow(db, id);
  if (!row) throw new HttpError(404, 'kb_not_found', 'knowledge base not found: ' + id);
  const kb = rowToKb(row);
  kb.docCount = await countRows(db, kb.table);
  return kb;
}

export async function listKbs(db) {
  const rows = await db.execute('SELECT * FROM kb_registry ORDER BY created_at ASC');
  const list = (rows || []).map(rowToKb);
  const out = [];
  for (const kb of list) {
    try { kb.docCount = await countRows(db, kb.table); } catch (e) { kb.docCount = 0; }
    out.push(kb);
  }
  return out;
}

function createTableSql(table, dim) {
  return 'CREATE TABLE IF NOT EXISTS ' + table + ' (' +
    'id VARCHAR(128) PRIMARY KEY, ' +
    'content TEXT NOT NULL, ' +
    'category VARCHAR(64) DEFAULT NULL, ' +
    'meta JSON DEFAULT NULL, ' +
    'embedding VECTOR(' + dim + ') NOT NULL, ' +
    'created_at VARCHAR(32) NOT NULL, ' +
    'FULLTEXT INDEX ft_content (content) WITH PARSER ik, ' +
    'VECTOR INDEX vec_embedding (embedding) ' + VECTOR_INDEX_CLAUSE +
    ') ORGANIZATION = HEAP';
}

export async function createKb(db, options) {
  const name = String((options && options.name) || '').trim();
  if (!name) throw new HttpError(400, 'bad_name', 'name is required');
  if (name.length > 64) throw new HttpError(400, 'bad_name', 'name too long (<=64)');
  const dim = clampInt(options && options.dim, 32, MAX_VECTOR_DIM, DEFAULT_DIM);
  const model = String((options && options.model) || DEFAULT_MODEL).slice(0, 100);
  const id = registryId(name, model, dim);
  const table = tableName(id);
  const existing = await findRegistryRow(db, id);
  if (existing) {
    const kb = rowToKb(existing);
    kb.docCount = await countRows(db, kb.table);
    return { kb: kb, created: false };
  }
  await db.execute('INSERT INTO kb_registry (id, name, table_name, model, dim, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, name, table, model, dim, nowIso()]);
  await db.execute(createTableSql(table, dim));
  const kb = { id: id, name: name, table: table, model: model, dim: dim, createdAt: nowIso(), docCount: 0 };
  return { kb: kb, created: true };
}

export async function deleteKb(db, id) {
  const kb = await getKb(db, id);
  await db.execute('DROP TABLE IF EXISTS ' + kb.table);
  await db.execute('DELETE FROM kb_registry WHERE id = ?', [id]);
  return kb;
}

function normalizeDoc(doc, index) {
  const text = String((doc && doc.text) || '').trim();
  if (!text) throw new HttpError(400, 'bad_doc', 'doc[' + index + '].text is required');
  if (text.length > MAX_TEXT) throw new HttpError(400, 'bad_doc', 'doc[' + index + '].text too long (>' + MAX_TEXT + ')');
  let id = doc && doc.id ? String(doc.id) : '';
  if (!id) id = 'd' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
  if (!/^[\w\-:.@]{1,120}$/.test(id)) throw new HttpError(400, 'bad_doc_id', 'doc[' + index + '].id invalid');
  const category = doc && doc.category != null ? String(doc.category).slice(0, 64) : null;
  let meta = null;
  if (doc && doc.meta != null) {
    try { meta = JSON.stringify(doc.meta); } catch (e) { throw new HttpError(400, 'bad_meta', 'doc[' + index + '].meta not serializable'); }
    if (meta && meta.length > 2000) throw new HttpError(400, 'bad_meta', 'doc[' + index + '].meta too large');
  }
  return { id: id, text: text, category: category, meta: meta };
}

export async function upsertDocs(db, kb, docs, vectors) {
  if (!Array.isArray(docs) || docs.length === 0) throw new HttpError(400, 'bad_docs', 'docs is required');
  if (!Array.isArray(vectors) || vectors.length !== docs.length) throw new HttpError(400, 'bad_vectors', 'vectors length must equal docs length');
  if (docs.length > 200) throw new HttpError(400, 'bad_docs', 'at most 200 docs per request');
  const norm = docs.map((d, i) => normalizeDoc(d, i));
  const vecs = vectors.map((v) => vectorLiteral(v, kb.dim));
  const table = kb.table;
  const chunkSize = 20;
  const writeStart = Date.now();
  let inserted = 0;
  for (let start = 0; start < norm.length; start += chunkSize) {
    const chunk = norm.slice(start, start + chunkSize);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const sql = 'INSERT INTO ' + table + ' (id, content, category, meta, embedding, created_at) VALUES ' + values +
      ' ON DUPLICATE KEY UPDATE content=VALUES(content), category=VALUES(category), meta=VALUES(meta), embedding=VALUES(embedding), created_at=VALUES(created_at)';
    const params = [];
    for (let j = 0; j < chunk.length; j++) {
      const d = chunk[j];
      params.push(d.id, d.text, d.category, d.meta, vecs[start + j], nowIso());
    }
    await db.execute(sql, params);
    inserted += chunk.length;
  }
  const writeMs = Date.now() - writeStart;
  const refresh = await refreshKb(db, kb, { timeoutMs: 1200 });
  return { inserted: inserted, total: norm.length, ids: norm.map((d) => d.id), writeMs: writeMs, refreshMs: refresh.refreshMs, waitMs: refresh.waitMs, refresh: refresh };
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait: keep it simple and synchronous */ }
}

// 刷新 = 显式就绪确认：统计 + 对最新一条文档轮询 FTS / 向量可见性（seekdb HNSW delta 索引异步构建）
export async function refreshKb(db, kb, options) {
  const timeoutMs = clampInt(options && options.timeoutMs, 100, 15000, 3000);
  const t0 = Date.now();
  const count = await countRows(db, kb.table);
  let probe = null;
  let waitMs = 0;
  let attempts = 0;
  try {
    const latest = await db.execute('SELECT id, content, embedding FROM ' + kb.table + ' ORDER BY created_at DESC LIMIT 1');
    const row = Array.isArray(latest) && latest.length ? latest[0] : null;
    if (row) {
      const id = String(row.id);
      const content = String(row.content || '');
      let ftsHit = false;
      const token = content.slice(0, 6);
      if (token) {
        try {
          const hits = await db.execute('SELECT id FROM ' + kb.table + " WHERE MATCH(content) AGAINST('" + escapeMatchLiteral(token) + "') LIMIT 200");
          ftsHit = Array.isArray(hits) && hits.some((h) => String(h.id) === String(id));
        } catch (e) { ftsHit = false; }
      }
      let vectorHit = false;
      let lit = null;
      try {
        let vstr = row.embedding;
        if (vstr != null) {
          if (typeof vstr !== 'string') vstr = JSON.stringify(vstr);
          const parsed = JSON.parse(vstr);
          lit = vectorLiteral(parsed, kb.dim);
        }
      } catch (e) { lit = null; }
      const limit = Math.max(10, Math.min(50, count));
      const deadline = t0 + timeoutMs;
      while (lit) {
        attempts++;
        try {
          const hits = await db.execute('SELECT id FROM ' + kb.table + " ORDER BY l2_distance(embedding, '" + lit + "') APPROXIMATE LIMIT " + limit);
          vectorHit = Array.isArray(hits) && hits.some((h) => String(h.id) === String(id));
        } catch (e) { vectorHit = false; }
        if (vectorHit || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      waitMs = Date.now() - t0;
      probe = { docId: id, ftsHit: ftsHit, vectorHit: vectorHit, annLimit: limit };
    }
  } catch (e) {
    probe = { error: String((e && e.message) || e) };
  }
  return { ok: true, docCount: count, refreshMs: Date.now() - t0, waitMs: waitMs, attempts: attempts, probe: probe, at: nowIso() };
}

function parseMeta(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (e) { return String(value); }
}

function shapeRows(rows, mode) {
  return (rows || []).map((row) => {
    const out = {
      id: row.id,
      text: row.content,
      category: row.category == null ? null : row.category,
      meta: parseMeta(row.meta),
      score: row.score == null ? null : Number(row.score),
      distance: row.distance == null ? null : Number(row.distance),
    };
    return out;
  });
}

export function buildSearchSql(kb, options) {
  const mode = ['hybrid', 'vector', 'fulltext'].includes(options && options.mode) ? options.mode : 'hybrid';
  const k = clampInt(options && options.k, 1, 50, 10);
  const table = kb.table;
  const cols = 'id, content, category, meta';
  if (mode === 'fulltext') {
    const q = escapeMatchLiteral(options && options.query);
    return {
      mode: mode,
      k: k,
      sql: 'SELECT ' + cols + ", MATCH(content) AGAINST('" + q + "') AS score FROM " + table +
        " WHERE MATCH(content) AGAINST('" + q + "') ORDER BY score DESC LIMIT " + k,
    };
  }
  const v = vectorLiteral(options && options.vector, kb.dim);
  if (mode === 'vector') {
    return {
      mode: mode,
      k: k,
      sql: 'SELECT ' + cols + ", l2_distance(embedding, '" + v + "') AS distance FROM " + table +
        " ORDER BY l2_distance(embedding, '" + v + "') APPROXIMATE LIMIT " + k,
    };
  }
  const q = escapeMatchLiteral(options && options.query);
  return {
    mode: 'hybrid',
    k: k,
    sql: 'SELECT ' + cols + ", MATCH(content) AGAINST('" + q + "') AS score, l2_distance(embedding, '" + v + "') AS distance FROM " + table +
      " WHERE MATCH(content) AGAINST('" + q + "') ORDER BY l2_distance(embedding, '" + v + "') APPROXIMATE LIMIT " + k,
  };
}

export async function searchKb(db, kb, options) {
  const built = buildSearchSql(kb, options);
  const t0 = Date.now();
  const rows = await db.execute(built.sql);
  const dbMs = Date.now() - t0;
  return { mode: built.mode, k: built.k, sql: built.sql, rows: shapeRows(rows, built.mode), dbMs: dbMs };
}

function prettySql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

export async function kbStats(db, kb) {
  const docCount = await countRows(db, kb.table);
  let createTableSql = null;
  try {
    const rows = await db.execute('SHOW CREATE TABLE ' + kb.table);
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (row) createTableSql = row['Create Table'] || row['Create View'] || Object.values(row)[1] || null;
  } catch (e) { createTableSql = null; }
  let indexes = [];
  try {
    const rows = await db.execute('SHOW INDEX FROM ' + kb.table);
    indexes = (rows || []).map((r) => ({ name: r.Key_name, type: r.Index_type, column: r.Column_name }));
  } catch (e) { indexes = []; }
  const sample = buildSearchSql(kb, { mode: 'hybrid', query: '示例查询词', vector: new Array(kb.dim).fill(0), k: 10 }).sql;
  return {
    kb: kb,
    docCount: docCount,
    createTableSql: createTableSql,
    indexes: indexes,
    sampleHybridSql: prettySql(sample.replace(/'\[[^\]]*\]'/g, "'[v1,v2,...]'")),
  };
}

export async function dbInfo(db) {
  const out = { mode: db.mode, version: db.version, detail: db.detail, database: db.database, openMs: db.openMs };
  try {
    const rows = await db.execute('SELECT VERSION() AS version, DATABASE() AS db');
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (row) { out.version = row.version || out.version; out.database = row.db || out.database; }
  } catch (e) { /* ignore */ }
  return out;
}
