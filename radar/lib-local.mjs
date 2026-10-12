// Shared local harness: compiles the REAL src/ml/train.ts with the repo's
// own typescript, and pulls the EXACT retrain rowset from remote D1
// (mirrors retrain() in src/index.ts — newest 5000). Used by
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

export function pullRows(HERE) {
	// Offline mode: ROWS_FILE=sweep-rows.json skips D1 (see dump-rows.mjs).
	// Same rowset for every parallel experimenter — results comparable.
	const fromFile = process.env.ROWS_FILE;
	if (fromFile) {
		const p = path.isAbsolute(fromFile) ? fromFile : path.join(HERE, fromFile);
		const doc = JSON.parse(readFileSync(p, "utf8"));
		console.log(`rows from file: ${fromFile} (dumpedAt=${doc.dumpedAt} n=${doc.rows.length})`);
		return doc.rows;
	}
	const SQL = `SELECT v.ts AS ts, o.dead AS dead, v.choice AS choice, `
		+ `(SELECT liquidity_usd FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS liq, `
		+ `(SELECT fdv FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS fdv, `
		+ `(SELECT txns_5m FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS txns, `
		+ `(SELECT txns_5m FROM snapshots s WHERE s.mint = v.mint ORDER BY ts DESC LIMIT 1) AS txnsLast, o.mult AS mult, `
		+ `(SELECT buys_5m FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS buys, `
		+ `(SELECT sells_5m FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS sells, `
		+ `(SELECT price_chg_h1 FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS chgH1, `
		+ `(SELECT vol_h1 FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS volH1, `
		+ `(SELECT pair_age_min FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS pairAge, `
		+ `g.top1_pct AS top1, g.top2_11_pct AS t211, g.early_buys AS early, g.mint_age_min AS age, `
		+ `g.pool_suspect AS pool, g.mint_auth_live AS mintLive, g.freeze_auth_live AS freezeLive, `
		+ `g.simpson AS simpson, v.p_red AS pRed, `
		+ `v.f_whale AS fWhale, v.f_sell AS fSell, v.f_struct AS fStruct, r.source AS src FROM verdicts v `
		+ `JOIN outcomes o ON o.mint = v.mint LEFT JOIN signals g ON g.mint = v.mint LEFT JOIN rounds r ON r.mint = v.mint `
		+ `ORDER BY v.ts DESC LIMIT 5000`;
	const raw = execSync(`npx wrangler d1 execute radar-d1-main --remote --command "${SQL.replace(/"/g, "'")}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: HERE });
	const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
	const results = JSON.parse(json)[0].results;
	const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	return results.map((r) => ({
		ts: Number(r.ts), dead: Number(r.dead) === 1 ? 1 : 0, choice: String(r.choice ?? "yellow"),
		liq: numOrNull(r.liq), top1: numOrNull(r.top1), t211: numOrNull(r.t211), fdv: numOrNull(r.fdv),
		early: numOrNull(r.early), age: numOrNull(r.age), txns: numOrNull(r.txns),
		buys: numOrNull(r.buys), sells: numOrNull(r.sells), pool: numOrNull(r.pool), pRed: numOrNull(r.pRed),
		mintLive: numOrNull(r.mintLive), freezeLive: numOrNull(r.freezeLive),
		chgH1: numOrNull(r.chgH1), volH1: numOrNull(r.volH1), pairAge: numOrNull(r.pairAge),
		simpson: numOrNull(r.simpson),
		fWhale: numOrNull(r.fWhale), fSell: numOrNull(r.fSell), fStruct: numOrNull(r.fStruct),
		src: typeof r.src === "string" ? r.src : null,
		zombie: Number(r.mult) === 1 && Number(r.txns) === 0 && Number(r.txnsLast) === 0
			&& r.txns != null && r.txnsLast != null && r.mult != null,
	}));
}
