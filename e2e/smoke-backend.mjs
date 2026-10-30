// e2e/smoke-backend.mjs — 后端/seekdb 冒烟自检（不涉及浏览器，验证 e2e/lib/backend.mjs 与 server API）
// 用独立 seekdb 目录（e2e/out/_runtime/seekdb），不影响 Lead/dev 实例。
// 用法：node e2e/smoke-backend.mjs [--port 18270]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, waitForHealth, stopBackend } from './lib/backend.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const argv = process.argv.slice(2);
function argOf(name, def) { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; }
// 默认 18278：避开 dev 用的 18270（web-ui 可能起 MOCK/Vite 在 18270/18271），任务端口段 18270-18279
const port = Number(argOf('port', 18278));
const freshDb = argv.includes('--fresh-db');
const dbPath = path.resolve(argOf('db-path', path.join(OUT_DIR, '_runtime', 'seekdb')));
if (freshDb) { try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch (e) { console.log('wipe db failed: ' + e.message); } }
const logDir = path.join(OUT_DIR, 'smoke-backend-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(logDir, { recursive: true });
const log = (...p) => { const line = p.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(line); };

const summary = { startedAt: new Date().toISOString(), steps: [] };
function step(name, ok, detail) { summary.steps.push({ name, ok: !!ok, detail: detail === undefined ? null : detail }); log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 800) : '')); return ok; }

function norm384(seed) {
  const v = new Array(384).fill(0).map((_, i) => Math.sin((i + 1) * (seed + 1) * 0.017) + 0.1);
  let s = 0; for (const x of v) s += x * x;
  s = Math.sqrt(s);
  return v.map((x) => Number((x / s).toFixed(6)));
}

async function req(base, method, p, body) {
  const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, ok: r.ok, json, text: text.slice(0, 800) };
}

let handle = null;
const startedMs = Date.now();
(async () => {
  try {
    handle = startBackend({
      cwd: SRC_ROOT,
      port,
      logDir,
      env: {
        SEEKDB_BINDINGS_CACHE_DIR: process.env.SEEKDB_BINDINGS_CACHE_DIR || 'D:\\oceanbase\\_scratch\\t27\\bindings',
        SEEKDB_PATH: dbPath,
      },
    });
    const health = await waitForHealth(handle, { timeoutMs: Number(argOf('health-timeout-ms', 180000)), onTick: (() => { let last = 0; return (now) => { if (now - last > 15000) { last = now; log('[wait] 后端 /api/health 尚未就绪，已等待 ' + Math.round((now - startedMs) / 1000) + 's'); } }; })() });
    summary.health = health;
    const isMock = /mock/i.test(String(health.dbMode || '') + ' ' + String(health.dbVersion || ''));
    step('后端是真实 seekdb（非 MOCK 联调后端）', !isMock, { dbMode: health.dbMode, dbVersion: health.dbVersion, port });
    step('后端启动 + /api/health', true, { dbMode: health.dbMode, dbVersion: health.dbVersion, openMs: health.openMs, database: health.database, port });

    const kbs0 = await req(handle.baseUrl, 'GET', '/api/kbs');
    step('GET /api/kbs', kbs0.ok && Array.isArray(kbs0.json && kbs0.json.kbs), { status: kbs0.status, count: kbs0.json && kbs0.json.kbs && kbs0.json.kbs.length });

    const created = await req(handle.baseUrl, 'POST', '/api/kbs', { name: 'e2e-smoke', dim: 384 });
    const kb = created.json && (created.json.kb || created.json);
    step('POST /api/kbs（同名复用）', created.ok && !!(kb && kb.id), { status: created.status, kb: kb && { id: kb.id, name: kb.name, dim: kb.dim } });
    const kbId = kb && kb.id;

    if (kbId) {
      const docs = [
        { id: 'smoke-1', text: 'seekdb 是面向 AI 应用的数据库，支持向量与全文混合检索。', category: 'db' },
        { id: 'smoke-2', text: '浏览器端使用 ONNX Runtime Web 在本地完成向量化推理。', category: 'infer' },
        { id: 'smoke-3', text: '混合检索在单条 SQL 中同时使用 MATCH AGAINST 与 l2_distance。', category: 'search' },
      ];
      const vectors = [norm384(1), norm384(2), norm384(3)];
      const ins = await req(handle.baseUrl, 'POST', '/api/kbs/' + kbId + '/docs', { docs, vectors });
      step('POST /docs 写入 3 篇（含向量）', ins.ok && ins.json && ins.json.inserted === 3, { status: ins.status, inserted: ins.json && ins.json.inserted, writeMs: ins.json && ins.json.writeMs, refreshMs: ins.json && ins.json.refreshMs });

      const refresh = await req(handle.baseUrl, 'POST', '/api/kbs/' + kbId + '/refresh');
      step('POST /refresh', refresh.ok && refresh.json && refresh.json.ok, { status: refresh.status, docCount: refresh.json && refresh.json.docCount, refreshMs: refresh.json && refresh.json.refreshMs });

      const search = await req(handle.baseUrl, 'POST', '/api/kbs/' + kbId + '/search', { mode: 'hybrid', query: '数据库 混合检索', vector: norm384(1), k: 3 });
      const rows = (search.json && search.json.rows) || [];
      step('POST /search hybrid（单条 SQL 库内混合检索）', search.ok && rows.length > 0, { status: search.status, rows: rows.length, dbMs: search.json && search.json.dbMs, sql: search.json && String(search.json.sql || '').slice(0, 400) });

      const stats = await req(handle.baseUrl, 'GET', '/api/kbs/' + kbId + '/stats');
      step('GET /stats（DDL/索引证据）', stats.ok && stats.json, { status: stats.status, createTableSql: stats.json && String(stats.json.createTableSql || '').slice(0, 500), indexes: stats.json && stats.json.indexes });

      const dbInfo = await req(handle.baseUrl, 'GET', '/api/db/info');
      step('GET /api/db/info', dbInfo.ok && dbInfo.json, { status: dbInfo.status, mode: dbInfo.json && dbInfo.json.mode, version: dbInfo.json && dbInfo.json.version });
    }
    summary.exitCode = summary.steps.every((s) => s.ok) ? 0 : 1;
  } catch (e) {
    summary.error = String(e && e.message || e);
    log('[ERROR] ' + summary.error);
    summary.exitCode = 21;
  } finally {
    try { if (handle) await stopBackend(handle); } catch { /* ignore */ }
    summary.finishedAt = new Date().toISOString();
    const file = path.join(logDir, 'smoke-summary.json');
    fs.writeFileSync(file, JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'smoke-backend-latest.json'), JSON.stringify(summary, null, 2));
    log('summary: ' + file + ' exit=' + summary.exitCode);
    setTimeout(() => process.exit(summary.exitCode), 100).unref();
  }
})();
