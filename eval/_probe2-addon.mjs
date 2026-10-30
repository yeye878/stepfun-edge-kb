import fs from 'node:fs';
import { createRequire } from 'node:module';
const LOG = 'D:/oceanbase/tasks/t27_stepfun_edge/outputs/logs/2026-10-31_probe2.log';
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const log = (...a) => { const line = '[' + ((Date.now() - t0) / 1000).toFixed(2) + 's] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); fs.appendFileSync(LOG, line + '\n'); };
process.env.SEEKDB_BINDINGS_CACHE_DIR = 'D:/oceanbase/_scratch/t27/bindings';
const require = createRequire(import.meta.url);
const DB_DIR = 'D:/oceanbase/tasks/t27_stepfun_edge/src/_runtime/eval-probe2';
const watchdog = setTimeout(() => { log('WATCHDOG 60s hit -> exit(2)'); process.exit(2); }, 60000);

try {
  log('step1: require @seekdb/js-bindings');
  const bindings = require('@seekdb/js-bindings');
  log('step1 ok; keys=' + Object.keys(bindings).join(','));
  log('step2: getNativeBindingAsync');
  const addon = typeof bindings.open === 'function' ? bindings : await bindings.getNativeBindingAsync();
  log('step2 ok; addon keys=' + Object.keys(addon).slice(0, 20).join(','));
  log('step3: open db');
  const db = addon.open(DB_DIR);
  log('step3 ok; db type=' + typeof db);
  log('step4: connect test');
  const conn = addon.connect(db, 'test', true);
  log('step4 ok; conn type=' + typeof conn);
  log('step5: execute SELECT 1');
  const r = await addon.execute(conn, 'SELECT 1 AS one', undefined);
  log('step5 ok: ' + JSON.stringify(r).slice(0, 300));
  log('step6: create database');
  const r2 = await addon.execute(conn, 'CREATE DATABASE IF NOT EXISTS t27_eval', undefined);
  log('step6 ok: ' + JSON.stringify(r2).slice(0, 300));
  log('step7: disconnect');
  addon.disconnect(conn);
  log('step7 ok');
  log('step8: connect t27_eval');
  const conn2 = addon.connect(db, 't27_eval', true);
  log('step8 ok');
  log('step9: select count from information_schema?');
  const r3 = await addon.execute(conn2, 'SELECT 1 AS two', undefined);
  log('step9 ok: ' + JSON.stringify(r3).slice(0, 200));
  log('step10: disconnect + close_sync');
  addon.disconnect(conn2);
  addon.close_sync(db);
  log('step10 ok');
} catch (e) {
  log('ERROR: ' + (e && e.stack ? e.stack : e));
} finally {
  clearTimeout(watchdog);
  log('done, exit(0)');
  process.exit(0);
}
