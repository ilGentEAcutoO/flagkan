// JS parity for out/flagkan-gbm*.json: replays the embedded 200 LightGBM predictions with the
// zero-dependency evaluator (out/predict-live.mjs). Pass = max |err| <= 1e-6.
//   node ml-lab/src/fk_parity.mjs ml-lab/out/flagkan-gbm.json
import { readFileSync } from "node:fs";
import { predictCompact } from "../out/predict-live.mjs";
const m = JSON.parse(readFileSync(process.argv[2], "utf8"));
let worst = 0;
for (const c of m.parity) worst = Math.max(worst, Math.abs(predictCompact(m, c.x) - c.p));
console.log(`trees=${m.n_trees} parity_n=${m.parity.length} max_abs_err=${worst.toExponential(2)} ${worst <= 1e-6 ? "OK" : "FAIL"}`);
process.exit(worst <= 1e-6 ? 0 : 1);
