import fs from "node:fs";
const LOG = "D:/oceanbase/_scratch/t27/probe/out19b.log";
fs.writeFileSync(LOG, "");
const log = (...a) => fs.appendFileSync(LOG, a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
process.env.SEEKDB_BINDINGS_CACHE_DIR = "D:/oceanbase/_scratch/t27/bindings";
const t0 = Date.now();
try {
  log("import express first");
  const express = (await import("express")).default;
  log("express imported " + (Date.now() - t0));
  const { SeekdbAdminClient, SeekdbClient } = await import("seekdb");
  log("seekdb imported " + (Date.now() - t0));
  const admin = new SeekdbAdminClient({ path: "D:/oceanbase/_scratch/t27/probe/db19" });
  log("admin");
  await admin.createDatabase("t27_kb");
  log("created " + (Date.now() - t0));
  const client = new SeekdbClient({ path: "D:/oceanbase/_scratch/t27/probe/db19", database: "t27_kb" });
  log("client");
  log("version", JSON.stringify(await client.execute("SELECT VERSION() v")));
  log("done " + (Date.now() - t0));
} catch (e) { log("ERR", e && (e.stack || e.message)); }
process.exit(0);
