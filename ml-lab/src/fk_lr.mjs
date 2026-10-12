// v8 LR baseline with the REAL radar code (buildFeatures + trainLRNewton from radar/src/ml/train.ts).
// Usage: node node_modules/typescript/bin/tsc src/ml/train.ts --outDir <dir> --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck   (from radar/)
//        node ml-lab/src/fk_lr.mjs <dir>/train.js
// Reads ml-lab/data/flagkan/trainrows.json, writes ml-lab/data/flagkan/lr_preds.json:
//   X27 (buildFeatures for every row, in time order) + LR test predictions for each split.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(HERE, "..", "data", "flagkan");
const ml = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const doc = JSON.parse(readFileSync(path.join(D, "trainrows.json"), "utf8"));
const rows = doc.rows; // already in time order (fk_build.py); splits index this order
const X = rows.map((r) => ml.buildFeatures(r));
const splits = JSON.parse(readFileSync(path.join(D, "splits.json"), "utf8")); // {name: {train:[idx], test:[idx]}}
const out = { features: [...ml.FEATURES], mints: rows.map((r) => r.mint), X27: X, preds: {}, models: {} };
for (const [name, sp] of Object.entries(splits)) {
	const m = ml.trainLRNewton(sp.train.map((i) => ({ x: X[i], y: rows[i].dead })), { l2: ml.V2_L2 });
	out.preds[name] = sp.test.map((i) => ml.predict(m, X[i]));
	out.models[name] = m;
	const auc = ml.aucOf(out.preds[name], sp.test.map((i) => rows[i].dead));
	console.log(`${name}: train=${sp.train.length} test=${sp.test.length} AUC=${auc?.toFixed(4)}`);
}
// sanity: the exact worker validator on the newest 8000 (what RETRAIN_SQL_V2 pulls)
const r8k = rows.slice(-8000).map((r) => ({ ...r }));
const v = ml.timeSplitValidateV2(r8k, null);
console.log(`timeSplitValidateV2 newest-8000: test=${v.nTest} AUC=${v.auc?.toFixed(4)} chalAcc=${v.chalAcc?.toFixed(4)} allRed=${v.allRedAcc?.toFixed(4)}`);
const v2 = ml.timeSplitValidateV2(rows, null);
console.log(`timeSplitValidateV2 all rows:   test=${v2.nTest} AUC=${v2.auc?.toFixed(4)} chalAcc=${v2.chalAcc?.toFixed(4)} allRed=${v2.allRedAcc?.toFixed(4)}`);
out.validator = { n8000: { auc: v.auc, chalAcc: v.chalAcc, allRed: v.allRedAcc, nTest: v.nTest }, all: { auc: v2.auc, chalAcc: v2.chalAcc, allRed: v2.allRedAcc, nTest: v2.nTest } };
writeFileSync(path.join(D, "lr_preds.json"), JSON.stringify(out));
