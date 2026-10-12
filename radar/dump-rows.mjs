// Dumps the exact retrain rowset from remote D1 to a local JSON file once,
// so parallel/offline experiments train without network.
// Usage: node dump-rows.mjs (from radar/) — writes sweep-rows.json
//        ROWS_OUT=other.json node dump-rows.mjs — custom name
// Offline use: ROWS_FILE=sweep-rows.json node sweep-reward.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pullRows } from "./lib-local.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.ROWS_OUT || "sweep-rows.json";
const rows = pullRows(HERE);
const doc = { dumpedAt: new Date().toISOString(), source: "radar-d1-main", n: rows.length, rows };
writeFileSync(path.join(HERE, out), JSON.stringify(doc));
console.log(`dumped ${rows.length} rows -> ${out}`);
