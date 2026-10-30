import fs from "node:fs";
const LOG = "D:/oceanbase/_scratch/t27/probe/out20.log";
fs.writeFileSync(LOG, "");
const log = (...a) => fs.appendFileSync(LOG, a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
const t0 = Date.now();
process.env.SEEKDB_BINDINGS_CACHE_DIR = "D:/oceanbase/_scratch/t27/bindings";
process.env.SEEKDB_DEBUG = "1";
log("A: import express + db.mjs + kb.mjs");
try {
  const express = (await import("express")).default;
  log("express imported " + (Date.now() - t0));
  const { openDatabase } = await import("file:///D:/oceanbase/tasks/t27_stepfun_edge/src/server/db.mjs");
  log("db.mjs imported " + (Date.now() - t0));
  const kb = await import("file:///D:/oceanbase/tasks/t27_stepfun_edge/src/server/kb.mjs");
  log("kb.mjs imported " + (Date.now() - t0));
  process.env.SEEKDB_PATH = "D:/oceanbase/_scratch/t27/probe/db20";
  const h = await openDatabase({ log: (m) => log("[db]", m) });
  log("opened " + h.version + " " + h.openMs);
  await kb.initSchema(h);
  log("schema ok");
  await h.dispose();
  log("done " + (Date.now() - t0));
} catch (e) { log("ERR", e && (e.stack || e.message)); }
process.exit(0);
