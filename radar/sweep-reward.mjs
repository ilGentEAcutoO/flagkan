// Reward shaping sweep: grid-searches (posWeight x redBar x l2) on the REAL
// resolved rowset, scored by the same shouldPromote bar the worker uses.
// Prints every cell; saves the winner (if any) to gold-model.json with its
// hyper params for promote-gold.mjs. Exit 0 = winner found, 1 = none.
// Usage: npm run sweep (from radar/)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileTrain, pullRows } from "./lib-local.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ml = await compileTrain(HERE, "sweep-reward");
const rows = pullRows(HERE);
console.log(`rows: ${rows.length} dims: ${ml.FEATURES.length}`);

const base = ml.timeSplitValidate(rows);
const champ = { acc: base.champAcc, redP: base.champRedP };
const f = (x) => (x === null || x === undefined ? "n/a" : Number(x).toFixed(4));
console.log(`champ acc=${f(champ.acc)} redP=${f(champ.redP)} (nTrain=${base.nTrain} nTest=${base.nTest} silentTest=${base.nSilentTest})`);

let best = null;
for (const posWeight of [1, 2, 3, 5, 8, 12]) {
	for (const redBar of [0.5, 0.6, 0.7, 0.8, 0.85]) {
		for (const l2 of [0.03, 0.01]) {
			const r = ml.timeSplitValidate(rows, { posWeight, redBar, l2 });
			const chal = { acc: r.chalAcc, redP: r.chalRedP };
			const win = r.chalAcc != null && champ.acc != null && ml.shouldPromote(champ, chal);
			console.log(`pw=${posWeight} bar=${redBar} l2=${l2} acc=${f(r.chalAcc)} redP=${f(r.chalRedP)} silentAcc=${f(r.chalAccSilent)} silentRedP=${f(r.chalRedPSilent)} silentReds=${r.chalRedSilent} ${win ? "WIN" : "lose"}`);
			// Tie-break: acc, redP, then HIGHER bar (fewer live reds under drift
			// = degrades toward champ, the safe direction), then lower pw.
			const better = !best || chal.acc > best.chal.acc
				|| (chal.acc === best.chal.acc && (chal.redP ?? 0) > (best.chal.redP ?? 0))
				|| (chal.acc === best.chal.acc && (chal.redP ?? 0) === (best.chal.redP ?? 0) && redBar > best.redBar)
				|| (chal.acc === best.chal.acc && (chal.redP ?? 0) === (best.chal.redP ?? 0) && redBar === best.redBar && posWeight < best.posWeight);
			if (win && better) {
				best = { posWeight, redBar, l2, chal, res: r };
			}
		}
	}
}
if (!best) { console.log("SWEEP: no winner — kill it"); process.exit(1); }
const r = best.res;
const gold = {
	savedAt: new Date().toISOString(),
	source: "sweep-reward",
	hyper: { posWeight: best.posWeight, redBar: best.redBar, l2: best.l2 },
	features: [...ml.FEATURES],
	weights: r.model.weights,
	bias: r.model.bias,
	metrics: {
		n: rows.length, nTrain: r.nTrain, nTest: r.nTest,
		champAcc: champ.acc, chalAcc: best.chal.acc,
		champRedP: champ.redP, chalRedP: best.chal.redP,
		chalAccSilent: r.chalAccSilent, chalRedPSilent: r.chalRedPSilent,
		chalRedSilent: r.chalRedSilent, nZombieDropped: r.nZombieDropped,
	},
	gate: "pass",
};
writeFileSync(path.join(HERE, "gold-model.json"), JSON.stringify(gold));
console.log(`SWEEP WINNER pw=${best.posWeight} bar=${best.redBar} l2=${best.l2} acc=${f(best.chal.acc)} redP=${f(best.chal.redP)} silentReds=${r.chalRedSilent} — saved gold-model.json`);
