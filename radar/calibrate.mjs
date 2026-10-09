// Threshold calibration for memory recall + model-red on REAL resolved data.
// Fit thresholds on oldest 70%, evaluate on newest 30% (no peeking).
// Memory matching is time-honest: a row only sees rugs resolved BEFORE its
// own verdict (outcomes.resolved_at < verdict ts), exactly like live.
// Usage: npm run calibrate   (from radar/)
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, "node_modules", ".cache", "calibrate");
const TSC = path.join(HERE, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(TSC)) { console.error("FAIL typescript not installed"); process.exit(1); }
rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });
try {
	execSync(`"${process.execPath}" "${TSC}" src/ml/train.ts --outDir "${CACHE}" --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck --strict`, { cwd: HERE, stdio: "pipe" });
} catch (e) { console.error("FAIL tsc:", String(e.stdout ?? e.message).slice(0, 300)); process.exit(1); }
const ml = await import(pathToFileURL(path.join(CACHE, "train.js")).href);

const SQL_ROWS = `SELECT v.mint AS mint, v.ts AS ts, o.dead AS dead, r.source AS src,`
	+ ` (SELECT liquidity_usd FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS liq,`
	+ ` (SELECT fdv FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS fdv,`
	+ ` (SELECT txns_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS txns,`
	+ ` (SELECT buys_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS buys,`
	+ ` (SELECT sells_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS sells,`
	+ ` (SELECT price_chg_h1 FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS chgH1,`
	+ ` (SELECT vol_h1 FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS volH1,`
	+ ` (SELECT pair_age_min FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS pairAge,`
	+ ` g.top1_pct AS top1, g.top2_11_pct AS t211, g.early_buys AS early, g.mint_age_min AS age,`
	+ ` g.pool_suspect AS pool, g.mint_auth_live AS mintLive, g.freeze_auth_live AS freezeLive, g.simpson AS simpson,`
	+ ` v.choice AS choice, v.p_red AS pRed, v.f_whale AS fWhale, v.f_sell AS fSell, v.f_struct AS fStruct`
	+ ` FROM verdicts v JOIN outcomes o ON o.mint=v.mint LEFT JOIN signals g ON g.mint=v.mint LEFT JOIN rounds r ON r.mint=v.mint WHERE v.source='live'`;
const SQL_MEM = `SELECT m.mint AS mint, m.vec AS vec, o.resolved_at AS res FROM rug_vectors m JOIN outcomes o ON o.mint = m.mint`;
const SQL_MODEL = `SELECT weights, bias FROM models WHERE promoted = 1 ORDER BY version DESC LIMIT 1`;

function dq(sql) {
	const raw = execSync(`npx wrangler d1 execute radar-d1-main --remote --command "${sql.replace(/"/g, "'")}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: HERE });
	const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
	return JSON.parse(json)[0].results;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rows = dq(SQL_ROWS).map((r) => ({
	mint: r.mint, ts: Number(r.ts), dead: Number(r.dead) === 1 ? 1 : 0,
	choice: String(r.choice ?? "yellow"),
	rule: ml.hardRed({ liquidity_usd: num(r.liq) ?? 0, top1_pct: num(r.top1) ?? 0, mint_age_min: num(r.age) ?? 999, txns_5m: num(r.txns) ?? 0 }) !== null,
	x: ml.buildFeatures({
		ts: Number(r.ts), dead: 0, choice: String(r.choice ?? "yellow"),
		liq: num(r.liq), top1: num(r.top1), t211: num(r.t211), fdv: num(r.fdv),
		early: num(r.early), age: num(r.age), txns: num(r.txns), buys: num(r.buys), sells: num(r.sells),
		pool: num(r.pool), pRed: num(r.pRed), mintLive: num(r.mintLive), freezeLive: num(r.freezeLive),
		chgH1: num(r.chgH1), volH1: num(r.volH1), pairAge: num(r.pairAge), simpson: num(r.simpson),
		fWhale: num(r.fWhale), fSell: num(r.fSell), fStruct: num(r.fStruct),
		src: typeof r.src === "string" ? r.src : null,
	}),
}));
const mem = dq(SQL_MEM).map((r) => {
	let v = [];
	try { v = JSON.parse(r.vec).map(Number); } catch { v = []; }
	while (v.length < ml.FEATURES.length) v.push(0.5);
	return { mint: r.mint, res: Number(r.res), v: v.slice(0, ml.FEATURES.length) };
}).filter((m) => m.v.length === ml.FEATURES.length);
const champ = dq(SQL_MODEL)[0];
const model = champ ? { weights: JSON.parse(champ.weights), bias: Number(champ.bias) } : null;
console.log(`rows=${rows.length} mem=${mem.length} model=${model ? "v-loaded" : "NONE"}`);

// Score every row (time-honest memory: only rugs resolved before its verdict).
for (const r of rows) {
	const known = mem.filter((m) => m.res < r.ts && m.mint !== r.mint);
	let best = 0;
	for (const m of known) { const c = ml.cosine(r.x, m.v); if (c > best) best = c; }
	r.cos = best;
	r.p = model ? ml.predict(model, r.x) : null;
}
rows.sort((a, b) => a.ts - b.ts);
const k = Math.floor(rows.length * 0.7);
const fit = rows.slice(0, k), eva = rows.slice(k);
console.log(`fit=${fit.length} eval=${eva.length}`);

function sweep(name, get, thresholds) {
	console.log(`--- ${name} (fit) ---`);
	let pick = null;
	for (const t of thresholds) {
		const f = fit.filter((r) => get(r) !== null && get(r) >= t);
		const prec = f.length ? f.filter((r) => r.dead === 1).length / f.length : null;
		console.log(`  >=${t}: n=${f.length} prec=${prec === null ? "n/a" : (prec * 100).toFixed(1) + "%"}`);
		if (prec !== null && prec >= 0.75 && f.length >= 8 && pick === null) pick = t;
	}
	if (pick === null) { console.log(`${name}: SKIP (no threshold holds 75% on fit)`); return; }
	const e = eva.filter((r) => get(r) !== null && get(r) >= pick);
	const eprec = e.length ? e.filter((r) => r.dead === 1).length / e.length : null;
	const ship = eprec !== null && eprec >= 0.7 && e.length >= 5;
	console.log(`${name}: pick>=${pick} eval n=${e.length} prec=${eprec === null ? "n/a" : (eprec * 100).toFixed(1) + "%"} -> ${ship ? "CANDIDATE (marginal decides)" : "SKIP"}`);
}
sweep("memory-cos", (r) => r.cos, [0.8, 0.85, 0.88, 0.9, 0.92, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99]);
if (model) sweep("model-p", (r) => r.p, [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]);
else console.log("model-p: SKIP (no champion)");

// Marginal impact: stored choice first (as live), model-red only where the
// stored verdict is silent. THIS is the honest ship criterion — isolated
// precision lies when the model merely agrees with rules.
if (model) {
	console.log("--- marginal model-red on EVAL (stored-first) ---");
	let mship = null;
	for (const t of [0.5, 0.6, 0.65, 0.7]) {
		let ok0 = 0, ok1 = 0, reds0 = 0, reds1 = 0, rd0 = 0, rd1 = 0, added = 0;
		for (const r of eva) {
			const c0 = r.choice;
			const c1 = r.choice === "red" ? "red" : (r.p !== null && r.p >= t ? "red" : r.choice);
			if (c1 === "red" && c0 !== "red") added++;
			const good = (c) => (c === "red" && r.dead === 1) || (c !== "red" && r.dead === 0);
			if (good(c0)) ok0++;
			if (good(c1)) ok1++;
			if (c0 === "red") { reds0++; if (r.dead === 1) rd0++; }
			if (c1 === "red") { reds1++; if (r.dead === 1) rd1++; }
		}
		const acc1 = ok1 / eva.length, redP1 = rd1 / Math.max(1, reds1);
		const acc0 = ok0 / eva.length, redP0 = rd0 / Math.max(1, reds0);
		console.log(`  >=${t}: added=${added} acc ${(acc0 * 100).toFixed(1)}->${(acc1 * 100).toFixed(1)} redP ${(redP0 * 100).toFixed(1)}->${(redP1 * 100).toFixed(1)}`);
		if (added >= 5 && redP1 >= redP0 && acc1 >= acc0 && mship === null) mship = t;
	}
	console.log(mship === null ? "MARGINAL VERDICT: SKIP (no threshold adds measured value)" : `MARGINAL VERDICT: SHIP model-red >=${mship}`);
}
