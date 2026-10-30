// 临时探针：验证 seekdb-js embedded + 内部句柄关闭 + 单条混合 SQL（验证后删除）
process.env.SEEKDB_BINDINGS_CACHE_DIR = 'D:/oceanbase/_scratch/t27/bindings';
const DB_DIR = 'D:/oceanbase/tasks/t27_stepfun_edge/src/_runtime/eval-probe';
import { SeekdbClient } from 'seekdb';

const log = (...a) => console.log(...a);

async function closeClient(client) {
  const internal = client._internal;
  try { if (internal._addon && internal._connection) internal._addon.disconnect(internal._connection); } catch (e) { log('disconnect err', e.message); }
  try { if (internal._addon && internal._db) internal._addon.close_sync(internal._db); } catch (e) { log('close_sync err', e.message); }
}

const t0 = Date.now();
const c0 = new SeekdbClient({ path: DB_DIR, database: 'test' });
log('c0 isConnected(before)=' + c0.isConnected());
const r1 = await c0.execute('SELECT 1 AS one');
log('SELECT 1 =>', JSON.stringify(r1));
const r2 = await c0.execute('CREATE DATABASE IF NOT EXISTS t27_eval');
log('CREATE DB =>', JSON.stringify(r2));
log('c0 internal keys:', Object.keys(c0._internal || {}));
await closeClient(c0);
log('c0 closed');

const c1 = new SeekdbClient({ path: DB_DIR, database: 't27_eval' });
await c1.execute('DROP TABLE IF EXISTS docs_probe');
const ddl = 'CREATE TABLE docs_probe (id VARCHAR(32) PRIMARY KEY, title VARCHAR(128), content TEXT NOT NULL, category VARCHAR(32), embedding VECTOR(4), FULLTEXT INDEX ft(content) WITH PARSER ik, VECTOR INDEX vec(embedding) WITH (distance=l2, type=hnsw, lib=vsag)) ORGANIZATION = HEAP';
log('DDL =>', JSON.stringify(await c1.execute(ddl)));
const rows = [
  ['d01', '向量数据库', '向量数据库把文本编码成向量并按距离排序', '向量检索', '[1,0,0,0]'],
  ['d02', '全文检索', '全文检索按关键词匹配文档并打分', '全文检索', '[0.9,0.1,0,0]'],
  ['d03', '模型量化', '模型量化把权重压成八位整数减少体积', '模型量化', '[0,1,0,0]'],
];
for (const r of rows) await c1.execute('INSERT INTO docs_probe (id, title, content, category, embedding) VALUES (?, ?, ?, ?, ?)', r);
log('count =>', JSON.stringify(await c1.execute('SELECT COUNT(*) AS c FROM docs_probe')));

// 1) 参数绑定形式：MATCH AGAINST(?) + l2_distance(?, ?) 
try {
  const q = '向量 数据库';
  const v = '[1,0,0,0]';
  const rs = await c1.execute('SELECT id, MATCH(content) AGAINST(?) AS score, l2_distance(embedding, ?) AS distance FROM docs_probe WHERE MATCH(content) AGAINST(?) ORDER BY l2_distance(embedding, ?) APPROXIMATE LIMIT 3', [q, v, q, v]);
  log('PARAM hybrid =>', JSON.stringify(rs));
} catch (e) { log('PARAM hybrid ERR:', e.message); }

// 2) 纯向量单条 SQL（无 MATCH 过滤）
try {
  const v = '[1,0,0,0]';
  const rs = await c1.execute('SELECT id, l2_distance(embedding, ?) AS distance FROM docs_probe ORDER BY l2_distance(embedding, ?) APPROXIMATE LIMIT 3', [v, v]);
  log('PARAM vector-only =>', JSON.stringify(rs));
} catch (e) { log('PARAM vector-only ERR:', e.message); }

// 3) 字面量形式（对照）
try {
  const rs = await c1.execute("SELECT id, MATCH(content) AGAINST('向量 数据库') AS score, l2_distance(embedding,'[1,0,0,0]') AS distance FROM docs_probe WHERE MATCH(content) AGAINST('向量 数据库') ORDER BY l2_distance(embedding,'[1,0,0,0]') APPROXIMATE LIMIT 3");
  log('LITERAL hybrid =>', JSON.stringify(rs));
} catch (e) { log('LITERAL hybrid ERR:', e.message); }

// 4) 无 MATCH 命中时（查询词不在任何文档）混合检索返回什么
try {
  const rs = await c1.execute("SELECT id FROM docs_probe WHERE MATCH(content) AGAINST('量子计算 光合作用') ORDER BY l2_distance(embedding,'[1,0,0,0]') APPROXIMATE LIMIT 3");
  log('HYBRID no-keyword-hit =>', JSON.stringify(rs));
} catch (e) { log('HYBRID no-keyword-hit ERR:', e.message); }

// 5) SHOW CREATE TABLE / SHOW INDEX
log('SHOW INDEX =>', JSON.stringify(await c1.execute('SHOW INDEX FROM docs_probe')));

await closeClient(c1);
log('c1 closed; total ms=' + (Date.now() - t0));
process.exit(0);
