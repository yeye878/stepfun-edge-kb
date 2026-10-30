import fs from 'node:fs';
import { createRequire } from 'node:module';
const LOG = 'D:/oceanbase/tasks/t27_stepfun_edge/outputs/logs/2026-10-31_probe4.log';
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const log = (...a) => { fs.appendFileSync(LOG, '[' + ((Date.now() - t0) / 1000).toFixed(2) + 's] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); };
process.env.SEEKDB_BINDINGS_CACHE_DIR = 'D:/oceanbase/_scratch/t27/bindings';
const require = createRequire(import.meta.url);
const DB_DIR = 'D:/oceanbase/tasks/t27_stepfun_edge/src/_runtime/eval-probe2';
const watchdog = setTimeout(() => { log('WATCHDOG 25s -> exit(3)'); process.exit(3); }, 25000);
const bindings = require('@seekdb/js-bindings');
const addon = typeof bindings.open === 'function' ? bindings : await bindings.getNativeBindingAsync();
log('addon loaded; opening same dir again (previous process exited after disconnect w/o close_sync)');
try {
  const db = addon.open(DB_DIR);
  log('REOPEN OK');
  const conn = addon.connect(db, 'test', true);
  const r = await addon.execute(conn, 'SELECT COUNT(*) AS c FROM information_schema.TABLES', undefined);
  log('execute ok ' + JSON.stringify(r).slice(0, 200));
  addon.disconnect(conn);
  log('disconnect ok');
} catch (e) { log('REOPEN ERROR ' + (e && e.message ? e.message : e)); }
clearTimeout(watchdog);
process.exit(0);
