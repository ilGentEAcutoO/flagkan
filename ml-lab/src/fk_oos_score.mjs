// Score the OOS / parity rowsets (fk_oos_pull.py) with the REAL radar code:
// rowFromDb -> buildFeatures -> predict (LR champion from D1, v8 gold) and scoreGbm (gbm-model.json).
// Usage (from repo root): tsc radar/src/ml/train.ts radar/src/ml/gbm.ts --outDir <dir> ... ; node ml-lab/src/fk_oos_score.mjs <dir>
// Writes ml-lab/data/flagkan/oos/scored.json (git-ignored).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const D = path.join(ROOT, "ml-lab", "data", "flagkan", "oos");
const dir = path.resolve(process.argv[2]);
const ml = await import(pathToFileURL(path.join(dir, "train.js")).href);
const gb = await import(pathToFileURL(path.join(dir, "gbm.js")).href);
const gbm = JSON.parse(readFileSync(path.join(ROOT, "radar", "src", "ml", "gbm-model.json"), "utf8"));
const gold = JSON.parse(readFileSync(path.join(ROOT, "radar", "gold-model.json"), "utf8"));
const champRow = JSON.parse(readFileSync(path.join(D, "models.json"), "utf8"))[0];
const champ = { weights: JSON.parse(champRow.weights), bias: champRow.bias };
const cf = JSON.parse(champRow.features);
if (cf.join() !== ml.FEATURES.join() || gold.features.join() !== ml.FEATURES.join() || gbm.features.join() !== ml.FEATURES.join())
	throw new Error("feature list mismatch");
const goldM = { weights: gold.weights, bias: gold.bias };
const ruleOf = (r) => ml.hardRed({ liquidity_usd: r.liq, top1_pct: r.top1, early_buys: r.early, mint_age_min: r.age, txns_5m: r.txns });

function score(rows) {
	return rows.map((d) => {
		const r = ml.rowFromDb(d);
		const x = ml.buildFeatures(r);
		const pLr = ml.predict(champ, x), pGold = ml.predict(goldM, x), pGbm = gb.scoreGbm(gbm, x);
		const rule = ruleOf(r);
		return {
			mint: d.mint, seen: d.seen, dead: d.dead, choice: d.choice, tier: d.tier, vRule: d.vRule, upTs: d.upTs,
			storedLr: d.pLr, storedGbm: d.pGbm, rule,
			pLr, pGold, pGbm,
			polLr: ml.policyV2(pLr, rule, null).choice, polGbm: ml.policyV2(pGbm, rule, null).choice,
		};
	});
}
const A = JSON.parse(readFileSync(path.join(D, "oos_rows.json"), "utf8"));
const B = JSON.parse(readFileSync(path.join(D, "parity_rows.json"), "utf8"));
writeFileSync(path.join(D, "scored.json"), JSON.stringify({
	cutoff: A.cutoff, champ: { version: champRow.version, n_train: champRow.n_train, created_at: champRow.created_at },
	gold: { modelV: gold.modelV, savedAt: gold.savedAt }, gbm_v: gbm.meta.gbm_v, oos: score(A.rows), parity: score(B.rows),
}));
console.log("scored oos", A.rows.length, "parity", B.rows.length);
