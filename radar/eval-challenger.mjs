// Challenger gate: validates a buildFeatures change on REAL resolved data.
// Pulls the exact retrain rowset from remote D1, compiles the REAL
// src/ml/train.ts with the repo's own typescript, runs timeSplitValidate,
// and applies the same shouldPromote bar the worker uses (strict acc win,
// ties break on redP). Exit 0 = ship, 1 = kill.
// Usage: npm run gate   (from radar/)
//        npm run train  (same + saves gold-model.json for promote-gold.mjs)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileTrain, pullRows } from "./lib-local.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ml = await compileTrain(HERE, "eval-challenger");
const rows = pullRows(HERE);
console.log(`rows: ${rows.length} dims: ${ml.FEATURES.length}`);
const res = ml.timeSplitValidate(rows);
const f = (x) => (x === null || x === undefined ? "n/a" : Number(x).toFixed(4));
console.log(`train=${res.nTrain} test=${res.nTest} silentTest=${res.nSilentTest} zombiesDropped=${res.nZombieDropped}`);
console.log(`champ acc=${f(res.champAcc)} redP=${f(res.champRedP)}`);
console.log(`chal  acc=${f(res.chalAcc)} redP=${f(res.chalRedP)} silentAcc=${f(res.chalAccSilent)} silentRedP=${f(res.chalRedPSilent)} silentReds=${res.chalRedSilent}`);
const ranked = res.model.weights.map((w, i) => ({ n: ml.FEATURES[i] ?? `d${i}`, w }))
	.sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 8);
console.log("topWeights: " + ranked.map((r) => `${r.n}=${r.w.toFixed(3)}`).join(" "));
if (ml.FEATURES.length > 21) {
	const newDims = res.model.weights.slice(21).map((w, i) => `${ml.FEATURES[21 + i]}=${w.toFixed(3)}`);
	console.log("newDims: " + newDims.join(" "));
}
const pass = res.chalAcc != null && res.champAcc != null
	&& ml.shouldPromote({ acc: res.champAcc, redP: res.champRedP }, { acc: res.chalAcc, redP: res.chalRedP });
console.log(pass ? "GATE PASS — ship it" : "GATE FAIL — kill it");
if (process.argv.includes("--save")) {
	const gold = {
		savedAt: new Date().toISOString(),
		source: "local-train",
		hyper: { posWeight: ml.DEFAULT_POS_WEIGHT, redBar: ml.DEFAULT_RED_BAR, l2: ml.DEFAULT_L2 },
		features: [...ml.FEATURES],
		weights: res.model.weights,
		bias: res.model.bias,
		metrics: {
			n: rows.length, nTrain: res.nTrain, nTest: res.nTest,
			champAcc: res.champAcc, chalAcc: res.chalAcc,
			champRedP: res.champRedP, chalRedP: res.chalRedP,
			chalAccSilent: res.chalAccSilent, chalRedPSilent: res.chalRedPSilent,
			chalRedSilent: res.chalRedSilent, nZombieDropped: res.nZombieDropped,
		},
		gate: pass ? "pass" : "fail",
	};
	writeFileSync(path.join(HERE, "gold-model.json"), JSON.stringify(gold));
	console.log(`saved gold-model.json (gate ${gold.gate}, dims=${gold.features.length})`);
}
process.exit(pass ? 0 : 1);
