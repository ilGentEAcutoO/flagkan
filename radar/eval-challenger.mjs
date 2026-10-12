// Challenger gate (label v2, Oct 12): validates a model change on REAL
// resolved data graded with outcomes.dead_v2. Pulls the exact retrain rowset
// (RETRAIN_SQL_V2) from remote D1 or ROWS_FILE, compiles the REAL
// src/ml/train.ts, runs timeSplitValidateV2 and applies the same
// shouldPromote bar the worker uses. Champion: gold-model.json when it is a
// label-v2 model with matching features (--vs-gold), else the all-red
// base-rate policy (what live serves with no v2 champion).
// Exit 0 = ship, 1 = kill.
// Usage: npm run gate   (from radar/)
//        npm run train  (same + saves gold-model.json for promote-gold.mjs)
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileTrain, pullRows } from "./lib-local.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ml = await compileTrain(HERE, "eval-challenger");
const rows = pullRows(HERE, ml);
console.log(`rows: ${rows.length} dims: ${ml.FEATURES.length} label: v${ml.LABEL_V}`);
let champ = null;
if (process.argv.includes("--vs-gold") && existsSync(path.join(HERE, "gold-model.json"))) {
	const g = JSON.parse(readFileSync(path.join(HERE, "gold-model.json"), "utf8"));
	if (g.labelV === ml.LABEL_V && Array.isArray(g.features) && g.features.join() === ml.FEATURES.join()) champ = { weights: g.weights, bias: g.bias, features: g.features };
}
const res = ml.timeSplitValidateV2(rows, champ);
const f = (x) => (x === null || x === undefined ? "n/a" : Number(x).toFixed(4));
console.log(`train=${res.nTrain} test=${res.nTest} base(dead_v2)=${f(res.base)} AUC=${f(res.auc)}`);
console.log(`baselines: all-red acc=${f(res.allRedAcc)} all-yellow acc=${f(res.allYellowAcc)}`);
console.log(`champ ${res.champIsBaseline ? "(all-red baseline)" : "(gold v2)"} acc=${f(res.champAcc)} redP=${f(res.champRedP)}`);
console.log(`chal  acc=${f(res.chalAcc)} redP=${f(res.chalRedP)}`);
if (res.tiers) console.log("tiers: " + Object.entries(res.tiers).map(([t, a]) => `${t} n=${a.n} dead=${a.n ? (a.dead / a.n).toFixed(3) : "n/a"}`).join(" | "));
const ranked = res.model.weights.map((w, i) => ({ n: ml.FEATURES[i] ?? `d${i}`, w }))
	.sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 8);
console.log("topWeights: " + ranked.map((r) => `${r.n}=${r.w.toFixed(3)}`).join(" "));
const pass = res.chalAcc != null && res.champAcc != null
	&& ml.shouldPromote({ acc: res.champAcc, redP: res.champRedP }, { acc: res.chalAcc, redP: res.chalRedP });
console.log(pass ? "GATE PASS — ship it" : "GATE FAIL — kill it");
if (process.argv.includes("--save")) {
	const gold = {
		savedAt: new Date().toISOString(),
		source: "local-train",
		labelV: ml.LABEL_V,
		modelV: ml.MODEL_V,
		hyper: { l2: ml.V2_L2, tRed: ml.T_RED, tSure: ml.T_SURE, tGreen: ml.T_GREEN },
		features: [...ml.FEATURES],
		weights: res.model.weights,
		bias: res.model.bias,
		metrics: {
			n: rows.length, nTrain: res.nTrain, nTest: res.nTest, base: res.base, auc: res.auc,
			allRedAcc: res.allRedAcc, allYellowAcc: res.allYellowAcc,
			champAcc: res.champAcc, chalAcc: res.chalAcc,
			champRedP: res.champRedP, chalRedP: res.chalRedP, champIsBaseline: res.champIsBaseline,
			tiers: res.tiers,
		},
		gate: pass ? "pass" : "fail",
	};
	writeFileSync(path.join(HERE, "gold-model.json"), JSON.stringify(gold));
	console.log(`saved gold-model.json (gate ${gold.gate}, label v${gold.labelV}, dims=${gold.features.length})`);
}
process.exit(pass ? 0 : 1);
