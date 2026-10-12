// Promotes a local gold-model.json to prod D1 (remote).
// Same write semantics as the worker's retrain(): demote old champion,
// insert the candidate as promoted=1. Refuses to write unless the gold
// FEATURES match the current src/ml/train.ts exactly (order + length) —
// prod builds features by position, so a dim mismatch would silently corrupt.
// Dry run by default; pass --yes to actually write.
// Usage: npm run promote          (from radar/, dry run)
//        npm run promote -- --yes (writes to prod, then verifies via /api/diag)
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, "node_modules", ".cache", "promote-gold");
const TSC = path.join(HERE, "node_modules", "typescript", "bin", "tsc");
const GOLD = path.join(HERE, "gold-model.json");
const DIAG = "https://flag.sornkan.com/api/diag";

if (!existsSync(GOLD)) { console.error("FAIL no gold-model.json (run: npm run train)"); process.exit(1); }
const gold = JSON.parse(readFileSync(GOLD, "utf8"));
if (!Array.isArray(gold.weights) || !Number.isFinite(gold.bias) || !Array.isArray(gold.features)) {
	console.error("FAIL gold-model.json missing weights/bias/features");
	process.exit(1);
}
if (gold.weights.length !== gold.features.length) {
	console.error(`FAIL gold dims mismatch: weights=${gold.weights.length} features=${gold.features.length}`);
	process.exit(1);
}

// Compile the REAL train.ts and require exact FEATURES match.
if (!existsSync(TSC)) { console.error("FAIL typescript not installed (run npm install)"); process.exit(1); }
rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });
try {
	execSync(`"${process.execPath}" "${TSC}" src/ml/train.ts --outDir "${CACHE}" --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck --strict`,
		{ cwd: HERE, stdio: "pipe" });
} catch (e) {
	console.error("FAIL tsc compile:", String(e.stdout ?? e.message).slice(0, 400));
	process.exit(1);
}
const ml = await import(pathToFileURL(path.join(CACHE, "train.js")).href);
const live = [...ml.FEATURES];
const same = live.length === gold.features.length && live.every((f, i) => f === gold.features[i]);
if (!same) {
	console.error(`FAIL FEATURES drift: gold=[${gold.features.join(",")}] live=[${live.join(",")}]`);
	console.error("Retrain from current source (npm run train) before promoting.");
	process.exit(1);
}
// Sweep gold carries its winning hyper params — the code defaults must match
// (worker retrain + live bar use the defaults), else validation != live.
if (gold.hyper) {
	const dh = { posWeight: ml.DEFAULT_POS_WEIGHT, redBar: ml.DEFAULT_RED_BAR, l2: ml.DEFAULT_L2 };
	if (gold.hyper.posWeight !== dh.posWeight || gold.hyper.redBar !== dh.redBar || gold.hyper.l2 !== dh.l2) {
		console.error(`FAIL hyper drift: gold=${JSON.stringify(gold.hyper)} code=${JSON.stringify(dh)}`);
		console.error("Set train.ts defaults to the winning hyper (and deploy) before promoting.");
		process.exit(1);
	}
	console.log(`hyper ok: ${JSON.stringify(gold.hyper)}`);
}

const m = gold.metrics ?? {};
const f = (x) => (x === null || x === undefined ? "n/a" : Number(x).toFixed(4));
console.log(`gold: savedAt=${gold.savedAt} gate=${gold.gate} dims=${gold.features.length} bias=${Number(gold.bias).toFixed(4)}`);
console.log(`gold metrics: nTrain=${m.nTrain} chalAcc=${f(m.chalAcc)} chalRedP=${f(m.chalRedP)} silentReds=${m.chalRedSilent} (champ acc=${f(m.champAcc)} redP=${f(m.champRedP)})`);

let prod = null;
try {
	const r = await fetch(DIAG);
	prod = (await r.json()).model ?? null;
} catch { /* diag unreachable — still allow explicit promote */ }
if (prod) console.log(`prod now: v${prod.version} testAcc=${f(prod.testAcc)} nTrain=${prod.nTrain}`);
else console.log("prod now: (diag unreachable)");

if (!process.argv.includes("--yes")) {
	console.log("DRY RUN — pass --yes to write this gold to prod D1");
	process.exit(0);
}

// Weights/features JSON contain no single quotes (numbers + double-quoted
// names), so single-quoted SQL literals are safe. Write via temp --file.
const q = (v) => (v === null || v === undefined ? "NULL" : String(Number(v)));
const sql = `UPDATE models SET promoted = 0 WHERE promoted = 1;\n`
	+ `INSERT INTO models (created_at, weights, bias, features, n_train, test_acc, test_n, champ_acc, promoted) VALUES (`
	+ `${Date.now()}, '${JSON.stringify(gold.weights)}', ${q(gold.bias)}, '${JSON.stringify(gold.features)}', `
	+ `${q(m.nTrain)}, ${q(m.chalAcc)}, ${q(m.nTest)}, ${q(m.champAcc)}, 1);`;
const tmp = path.join(os.tmpdir(), `promote-gold-${Date.now()}.sql`);
writeFileSync(tmp, sql);
try {
	execSync(`npx wrangler d1 execute radar-d1-main --remote --file "${tmp}"`, { cwd: HERE, stdio: "pipe" });
} catch (e) {
	console.error("FAIL wrangler write:", String(e.stdout ?? e.message).slice(0, 500));
	process.exit(1);
} finally {
	rmSync(tmp, { force: true });
}
console.log("write ok — verifying via /api/diag...");
try {
	const r = await fetch(DIAG);
	const now = (await r.json()).model ?? null;
	if (now) console.log(`prod now: v${now.version} testAcc=${f(now.testAcc)} nTrain=${now.nTrain} (was v${prod?.version ?? "?"})`);
	else console.log("verify: diag returned no model — check manually");
} catch {
	console.log("verify: diag unreachable — check manually");
}
