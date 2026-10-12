// Shared local harness: compiles the REAL src/ml/train.ts with the repo's
// own typescript, and pulls the EXACT retrain rowset from remote D1
// (mirrors retrain() in src/index.ts — RETRAIN_SQL_V2, newest 8000). Used by
// eval-challenger.mjs (gate) and sweep-reward.mjs (hyper search).
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function compileTrain(HERE, tag) {
	const CACHE = path.join(HERE, "node_modules", ".cache", tag);
	const TSC = path.join(HERE, "node_modules", "typescript", "bin", "tsc");
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
	return import(pathToFileURL(path.join(CACHE, "train.js")).href);
}

// Label v2 (Oct 12): the SQL and the row mapping come from the REAL
// train.ts (RETRAIN_SQL_V2 + rowFromDb), so offline == worker retrain.
// Pass the compiled module from compileTrain().
export function pullRows(HERE, ml) {
	if (!ml || !ml.RETRAIN_SQL_V2 || !ml.rowFromDb) { console.error("FAIL pullRows(HERE, ml): pass the compiled train.ts module (label v2)"); process.exit(1); }
	// Offline mode: ROWS_FILE=sweep-rows.json skips D1 (see dump-rows.mjs).
	// Same rowset for every parallel experimenter — results comparable.
	const fromFile = process.env.ROWS_FILE;
	if (fromFile) {
		const p = path.isAbsolute(fromFile) ? fromFile : path.join(HERE, fromFile);
		const doc = JSON.parse(readFileSync(p, "utf8"));
		if (doc.label !== "v2") { console.error(`FAIL ${fromFile} is not a label-v2 dump (label=${doc.label}); re-run dump-rows.mjs`); process.exit(1); }
		console.log(`rows from file: ${fromFile} (dumpedAt=${doc.dumpedAt} n=${doc.rows.length})`);
		return doc.rows;
	}
	const raw = execSync(`npx wrangler d1 execute radar-d1-main --remote --json --command "${ml.RETRAIN_SQL_V2.replace(/"/g, "'")}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: HERE });
	const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
	const results = JSON.parse(json)[0].results;
	return results.map((r) => ml.rowFromDb(r));
}
