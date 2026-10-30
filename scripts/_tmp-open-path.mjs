import fs from "node:fs";
process.env.SEEKDB_BINDINGS_CACHE_DIR = "D:/oceanbase/_scratch/t27/bindings";
const DB = process.argv[2];
const LOG = process.argv[3];
const log = (...a) => fs.appendFileSync(LOG, a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
const t0 = Date.now();
log("open " + DB);
try {
  const { SeekdbAdminClient } = await import("seekdb");
  const admin = new SeekdbAdminClient({ path: DB });
  log("admin " + (Date.now() - t0));
  await admin.createDatabase("t27_kb");
  log("created " + (Date.now() - t0));
  process.exit(0);
} catch (e) { log("ERR " + (e && e.message)); process.exit(2); }
