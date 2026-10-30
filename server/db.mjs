// t27 seekdb 连接管理
// 默认 embedded：本机 seekdb 嵌入式（npm seekdb + @seekdb/js-bindings 原生插件）
// 可选 server：外部 seekdb / OceanBase（SEEKDB_MODE=server + SEEKDB_HOST/PORT）
import fs from 'node:fs';
import path from 'node:path';
import { SeekdbClient, SeekdbAdminClient } from 'seekdb';

const DEFAULT_DATABASE = 't27_kb';

export function readDbConfig(env) {
  env = env || process.env;
  const mode = String(env.SEEKDB_MODE || 'embedded').toLowerCase() === 'server' ? 'server' : 'embedded';
  const cfg = { mode: mode, database: env.SEEKDB_DATABASE || DEFAULT_DATABASE };
  if (mode === 'server') {
    cfg.host = env.SEEKDB_HOST || '127.0.0.1';
    cfg.port = Number(env.SEEKDB_PORT || 2881);
    cfg.user = env.SEEKDB_USER || 'root';
    cfg.password = env.SEEKDB_PASSWORD || '';
  } else {
    cfg.path = path.resolve(env.SEEKDB_PATH || path.join(process.cwd(), '_runtime', 'seekdb'));
  }
  return cfg;
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

// seekdb 嵌入式用 <db>/run/seekdb.pid 做单实例锁；进程被强杀后可能留下已死 pid 的锁。
export function recoverStaleLock(dbPath, log) {
  const pidFile = path.join(dbPath, 'run', 'seekdb.pid');
  if (!fs.existsSync(pidFile)) return false;
  let pid = NaN;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch (e) { pid = NaN; }
  if (pidAlive(pid)) return false;
  try {
    fs.unlinkSync(pidFile);
    log('removed stale seekdb pid lock (pid=' + pid + ')');
    return true;
  } catch (e) {
    return false;
  }
}

async function ensureDatabase(admin, name, log) {
  if (process.env.SEEKDB_DEBUG) log('debug: createDatabase start ' + name);
  try {
    await admin.createDatabase(name);
    log('database created: ' + name);
    if (process.env.SEEKDB_DEBUG) log('debug: createDatabase done');
  } catch (e) {
    if (process.env.SEEKDB_DEBUG) log('debug: createDatabase threw: ' + (e && e.message));
    const dbs = await admin.listDatabases().catch(() => []);
    const found = Array.isArray(dbs) && dbs.some((d) => d && d.name === name);
    if (!found) throw e;
    if (process.env.SEEKDB_DEBUG) log('debug: database already exists');
  }
}

function firstValue(rows, key) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (!row) return null;
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  return Object.values(row)[0];
}

const DEBUG = !!process.env.SEEKDB_DEBUG;

export async function openDatabase(options) {
  options = options || {};
  const log = options.log || ((m) => console.log('[seekdb] ' + m));
  const debug = (m) => { if (DEBUG) log('debug: ' + m + ' (+' + (Date.now() - t0) + 'ms)'); };
  const cfg = readDbConfig(options.env);
  const t0 = Date.now();
  debug('openDatabase start mode=' + cfg.mode + ' path=' + (cfg.path || cfg.host + ':' + cfg.port));
  if (cfg.mode === 'server') {
    const admin = new SeekdbAdminClient({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
    await ensureDatabase(admin, cfg.database, log);
    const client = new SeekdbClient({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database });
    const versionRows = await client.execute('SELECT VERSION() AS version');
    return new DatabaseHandle('server', client, cfg, firstValue(versionRows, 'version'), Date.now() - t0, log);
  }
  fs.mkdirSync(cfg.path, { recursive: true });
  recoverStaleLock(cfg.path, log);
  debug('mkdir/recover done');
  const openAdmin = async () => {
    const admin = new SeekdbAdminClient({ path: cfg.path });
    debug('admin client constructed');
    await ensureDatabase(admin, cfg.database, log);
    debug('ensureDatabase done');
    return admin;
  };
  try {
    await openAdmin();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/already opened|pid file locked|locked/i.test(msg) && recoverStaleLock(cfg.path, log)) {
      await openAdmin();
    } else {
      throw e;
    }
  }
  const client = new SeekdbClient({ path: cfg.path, database: cfg.database });
  debug('seekdb client constructed');
  const versionRows = await client.execute('SELECT VERSION() AS version');
  debug('version query done');
  return new DatabaseHandle('embedded', client, cfg, firstValue(versionRows, 'version'), Date.now() - t0, log);
}

export class DatabaseHandle {
  constructor(mode, client, cfg, version, openMs, log) {
    this.mode = mode;
    this.client = client;
    this.cfg = cfg;
    this.version = version || 'unknown';
    this.openMs = openMs;
    this.log = log;
    this.database = cfg.database;
    this.detail = mode === 'server' ? cfg.host + ':' + cfg.port : cfg.path;
  }
  async execute(sql, params) {
    return this.client.execute(sql, params);
  }
  // 尽力释放：seekdb-js 1.4.0 的 embedded close() 是空实现，原生 close_sync 会阻塞，
  // 因此这里只断开原生连接；进程退出由 index.mjs 的看门狗兜底。
  async dispose() {
    const internal = this.client && this.client._internal;
    if (internal && internal._addon && internal._connection) {
      try { internal._addon.disconnect(internal._connection); this.log('native connection closed'); } catch (e) { this.log('disconnect failed: ' + (e && e.message)); }
    }
    try { await this.client.close(); } catch (e) { /* embedded close is a no-op */ }
  }
}
