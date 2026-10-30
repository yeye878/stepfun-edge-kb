// t27 StepKB 后端：Express 薄后端（只做 SQL 转发与结果整形，不含任何推理依赖）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { openDatabase } from './db.mjs';
import {
  HttpError, initSchema, listKbs, createKb, deleteKb, getKb, upsertDocs, refreshKb, searchKb, kbStats, dbInfo,
} from './kb.mjs';

const PORT = Number(process.env.PORT || 18270);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const MANIFEST_CANDIDATES = [
  path.join(ROOT, 'web', 'public', 'models', 'bge-small-zh-v1.5', 'manifest.json'),
  path.join(DIST_DIR, 'models', 'bge-small-zh-v1.5', 'manifest.json'),
];
// seekdb 原生插件在 open() 时会接管/关闭进程的 stdout/stderr（见 DEV-ENV.md），
// 之后任何 console.log 都会 EBADF 崩溃。因此打开数据库前改用文件日志。
const LOG_FILE = process.env.BACKEND_LOG_FILE || path.join(ROOT, '_runtime', 'backend.log');
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (e) { /* ignore */ }

const startedAt = Date.now();
let dbHandle = null;
let shuttingDown = false;
let consoleSafe = true;

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore */ }
  if (consoleSafe) {
    try { process.stdout.write(line + '\n'); } catch (e) { consoleSafe = false; }
  }
}

// 任何第三方代码的 console.* 也走文件，避免打开 DB 后被 stdout 失效拖崩
console.log = (...args) => log(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
console.error = (...args) => log('ERROR ' + args.map((a) => (typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a))).join(' '));
console.warn = (...args) => log('WARN ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));

function loadManifest() {
  for (const file of MANIFEST_CANDIDATES) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { log('manifest read failed: ' + file + ' :: ' + (e && e.message)); }
  }
  return null;
}

function armExitWatchdog(ms) {
  // seekdb 原生插件在进程退出时可能阻塞（close_sync 卡死），用独立看门狗强杀兜底
  try {
    const seconds = Math.max(2, Math.ceil(ms / 1000));
    if (process.platform === 'win32') {
      const cmd = 'ping -n ' + (seconds + 1) + ' 127.0.0.1 >nul & taskkill /F /PID ' + process.pid + ' >nul 2>&1';
      spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawn('sh', ['-c', 'sleep ' + seconds + '; kill -9 ' + process.pid], { detached: true, stdio: 'ignore' }).unref();
    }
    log('exit watchdog armed (' + ms + 'ms)');
  } catch (e) {
    log('exit watchdog failed: ' + (e && e.message));
  }
}

function securityHeaders(req, res, next) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function parseId(req) {
  const id = String(req.params.id || '');
  if (!/^k[a-z0-9]{8,16}$/.test(id)) throw new HttpError(400, 'bad_kb_id', 'invalid kb id');
  return id;
}

function requireKb(id) {
  return getKb(dbHandle, id);
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '64mb' }));

  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api/')) log(req.method + ' ' + req.path + ' ' + res.statusCode + ' ' + (Date.now() - t0) + 'ms');
    });
    next();
  });

  app.get('/api/health', asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      dbMode: dbHandle.mode,
      dbVersion: dbHandle.version,
      dbDetail: dbHandle.detail,
      database: dbHandle.database,
      openMs: dbHandle.openMs,
      uptimeMs: Date.now() - startedAt,
      serverTime: new Date().toISOString(),
      modelManifest: loadManifest(),
    });
  }));

  app.get('/api/db/info', asyncRoute(async (req, res) => {
    res.json(await dbInfo(dbHandle));
  }));

  app.get('/api/kbs', asyncRoute(async (req, res) => {
    res.json({ kbs: await listKbs(dbHandle) });
  }));

  app.post('/api/kbs', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const result = await createKb(dbHandle, { name: body.name, dim: body.dim, model: body.model });
    res.status(result.created ? 201 : 200).json(result);
  }));

  app.get('/api/kbs/:id', asyncRoute(async (req, res) => {
    res.json({ kb: await requireKb(parseId(req)) });
  }));

  app.delete('/api/kbs/:id', asyncRoute(async (req, res) => {
    const kb = await deleteKb(dbHandle, parseId(req));
    res.json({ ok: true, deleted: kb });
  }));

  app.post('/api/kbs/:id/docs', asyncRoute(async (req, res) => {
    const kb = await requireKb(parseId(req));
    if (kb.dim !== 512) log('warning: kb dim ' + kb.dim + ' != model dim 512');
    const body = req.body || {};
    const result = await upsertDocs(dbHandle, kb, body.docs, body.vectors);
    res.json(result);
  }));

  app.post('/api/kbs/:id/refresh', asyncRoute(async (req, res) => {
    const kb = await requireKb(parseId(req));
    const body = req.body || {};
    res.json(await refreshKb(dbHandle, kb, { timeoutMs: body.timeoutMs }));
  }));

  app.post('/api/kbs/:id/search', asyncRoute(async (req, res) => {
    const kb = await requireKb(parseId(req));
    const body = req.body || {};
    const mode = body.mode || 'hybrid';
    if (mode === 'hybrid' && (!body.query || !Array.isArray(body.vector))) {
      throw new HttpError(400, 'bad_search', 'hybrid search requires query and vector');
    }
    if (mode === 'fulltext' && !body.query) throw new HttpError(400, 'bad_search', 'fulltext search requires query');
    if (mode === 'vector' && !Array.isArray(body.vector)) throw new HttpError(400, 'bad_search', 'vector search requires vector');
    const t0 = Date.now();
    const result = await searchKb(dbHandle, kb, body);
    res.json(Object.assign({ totalMs: Date.now() - t0 }, result));
  }));

  app.get('/api/kbs/:id/stats', asyncRoute(async (req, res) => {
    const kb = await requireKb(parseId(req));
    res.json(await kbStats(dbHandle, kb));
  }));

  // 静态前端（构建产物）：web/* 由 Vite 构建到 dist/
  if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        if (/[.](onnx|wasm|bin)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else if (/[.](json|txt)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    app.get(/^\/.*$/, (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res.type('text/plain; charset=utf-8').send(
        'StepKB 后端已启动，但前端尚未构建。\n\n请先:\n  npm run build\n再重新访问。\n\n（开发模式可用 npm run dev:web 走 Vite 18271 端口代理）'
      );
    });
  }

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next(new HttpError(404, 'not_found', 'no such api: ' + req.path));
    next(new HttpError(404, 'not_found', 'not found'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err && err.status ? err.status : 500;
    const code = err && err.code ? err.code : 'internal_error';
    if (status >= 500) log('ERROR ' + req.method + ' ' + req.path + ' :: ' + (err && (err.stack || err.message)));
    res.status(status).json({ error: { code: code, message: String((err && err.message) || err) } });
  });

  return app;
}

async function main() {
  log('StepKB backend starting (node ' + process.version + ', ' + process.platform + '-' + process.arch + ')');
  log('log file: ' + LOG_FILE);
  consoleSafe = false; // 从这里开始不再碰 process.stdout：seekdb 原生插件会关闭它
  dbHandle = await openDatabase({ log: log });
  log('seekdb ready: mode=' + dbHandle.mode + ' version=' + dbHandle.version + ' detail=' + dbHandle.detail + ' openMs=' + dbHandle.openMs);
  await initSchema(dbHandle);
  log('schema ready');
  const app = buildApp();
  const server = app.listen(PORT, HOST, () => {
    log('listening on http://' + HOST + ':' + PORT);
  });
  server.on('error', (e) => { log('server error: ' + (e && e.message)); process.exit(1); });

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('received ' + signal + ', shutting down');
    try { server.close(); } catch (e) { /* ignore */ }
    try { await dbHandle.dispose(); log('db disposed'); } catch (e) { log('db dispose failed: ' + (e && e.message)); }
    log('bye');
    // seekdb 原生插件在正常退出清理时会阻塞，直接 SIGKILL 强制终止（等价 kill -9，数据库靠 redo 恢复）
    try {
      process.kill(process.pid, 'SIGKILL');
    } catch (e) {
      armExitWatchdog(1500);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('uncaughtException', (e) => {
    log('uncaughtException: ' + (e && (e.stack || e.message)));
    armExitWatchdog(1500);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => { log('unhandledRejection: ' + (e && (e.stack || e.message))); });
}

main().catch((e) => {
  log('FATAL: ' + (e && (e.stack || e.message)));
  armExitWatchdog(1500);
  process.exit(1);
});
