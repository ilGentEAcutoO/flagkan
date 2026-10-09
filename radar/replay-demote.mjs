// Idea A replay: demote illiquid-alone REDs to YELLOW (+ upgrade re-catch).
// Offline, read-only, first-seen state only (no leakage). Fit oldest 70% / eval newest 30%.
// Usage: node replay-demote.mjs (from radar/)
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, "node_modules", ".cache", "replay-demote");
const TSC = path.join(HERE, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(TSC)) { console.error("FAIL typescript not installed"); process.exit(1); }
rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });
try {
	execSync(`"${process.execPath}" "${TSC}" src/ml/train.ts src/ml/upgrade.ts --outDir "${CACHE}" --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck --strict`, { cwd: HERE, stdio: "pipe" });
} catch (e) { console.error("FAIL tsc:", String(e.stdout ?? e.message).slice(0, 300)); process.exit(1); }
const ml = await import(pathToFileURL(path.join(CACHE, "train.js")).href);
const up = await import(pathToFileURL(path.join(CACHE, "upgrade.js")).href);

const SQL = `SELECT v.mint AS mint, v.ts AS ts, v.choice AS choice, v.v_rule AS vrule, v.red_source AS rsrc, v.upgraded_from AS upfrom, v.upgrade_why AS upwhy, o.dead AS dead,`
	+ ` (SELECT liquidity_usd FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS liq1,`
	+ ` (SELECT price_usd FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS p1,`
	+ ` (SELECT txns_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS tx1,`
	+ ` (SELECT buys_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS b1,`
	+ ` (SELECT sells_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS s1,`
	+ ` (SELECT feed FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS feed1,`
	+ ` (SELECT ts FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS t1,`
	+ ` (SELECT price_chg_h1 FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS chg1,`
	+ ` (SELECT vol_h1 FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS vol1,`
	+ ` (SELECT pair_age_min FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS pairAge,`
	+ ` (SELECT fdv FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS fdv1,`
	+ ` (SELECT liquidity_usd FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1 OFFSET 1) AS liq2,`
	+ ` (SELECT price_usd FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1 OFFSET 1) AS p2,`
	+ ` (SELECT feed FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1 OFFSET 1) AS feed2,`
	+ ` (SELECT ts FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1 OFFSET 1) AS t2,`
	+ ` g.top1_pct AS top1, g.top2_11_pct AS t211, g.early_buys AS early, g.mint_age_min AS age, g.pool_suspect AS pool, g.mint_auth_live AS mauth, g.freeze_auth_live AS fauth, g.simpson AS simpson,`
	+ ` v.f_whale AS fWhale, v.f_sell AS fSell, v.f_struct AS fStruct,`
	+ ` r.source AS src, r.first_seen AS seen`
	+ ` FROM verdicts v JOIN outcomes o ON o.mint=v.mint LEFT JOIN signals g ON g.mint=v.mint JOIN rounds r ON r.mint=v.mint WHERE v.source='live'`;
const SQL_MODEL = `SELECT weights, bias, version FROM models WHERE promoted = 1 ORDER BY version DESC LIMIT 1`;
function dq(sql) {
	const raw = execSync(`npx wrangler d1 execute radar-d1-main --remote --command "${sql.replace(/"/g, "'")}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: HERE });
	const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
	return JSON.parse(json)[0].results;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const correct = (choice, dead) => (choice === "red" && dead === 1) || (choice !== "red" && dead === 0);

const rows = dq(SQL);
const champRow = dq(SQL_MODEL)[0];
const champ = champRow ? { weights: JSON.parse(champRow.weights), bias: Number(champRow.bias) } : null;
console.log(`rows=${rows.length} model=${champ ? "v" + champRow.version : "NONE"}`);

// Enrich: replay first-seen state + second reasons (all pre-verdict).
for (const r of rows) {
	r.dead = Number(r.dead) === 1 ? 1 : 0;
	r.ts = Number(r.ts);
	const liq1 = num(r.liq1), top1 = num(r.top1), age = num(r.age), tx1 = num(r.tx1);
	// Fidelity: recompute hardRed from first-seen state vs stored v_rule.
	r.ruleReplay = ml.hardRed({ liquidity_usd: liq1 ?? NaN, top1_pct: top1 ?? NaN, mint_age_min: age ?? NaN, txns_5m: tx1 ?? NaN });
	const b1 = num(r.b1), s1 = num(r.s1);
	r.sellRatio = (b1 === null || s1 === null || b1 + s1 <= 0) ? null : s1 / (b1 + s1);
	const fW = num(r.fWhale), fS = num(r.fSell), fT = num(r.fStruct);
	r.fMax = Math.max(fW ?? -1, fS ?? -1, fT ?? -1);
	r.fMax = r.fMax < 0 ? null : r.fMax;
	r.authLive = num(r.mauth) === 1 || num(r.fauth) === 1;
	// LR reason: neutral pRed 0.5 (stored p_red is post-override for rule reds — using it would leak).
	r.lrP = null;
	if (champ) {
		try {
			r.lrP = ml.predict(champ, ml.buildFeatures({
				ts: r.ts, dead: 0, choice: "yellow",
				liq: liq1, top1, t211: num(r.t211), fdv: num(r.fdv1),
				early: num(r.early), age, txns: tx1, buys: b1, sells: s1,
				pool: num(r.pool), pRed: 0.5, mintLive: num(r.mauth), freezeLive: num(r.fauth),
				chgH1: num(r.chg1), volH1: num(r.vol1), pairAge: num(r.pairAge), simpson: num(r.simpson),
				fWhale: fW, fSell: fS, fStruct: fT,
				src: typeof r.src === "string" ? r.src : null,
			}));
		} catch { r.lrP = null; }
	}
	const sim = num(r.simpson);
	// Second-reason set (pre-verdict, first-seen): auth / tape / Jev-factors / LR.
	r.confirm = (r.authLive ? 1 : 0) + ((r.sellRatio !== null && r.sellRatio > 0.7) || (sim !== null && sim < 0.3) ? 1 : 0)
		+ ((r.fMax !== null && r.fMax >= 0.7) ? 1 : 0) + ((r.lrP !== null && r.lrP >= 0.85) ? 1 : 0);
	// Upgrade re-catch on 2nd snapshot (feed-correct, gap>5m, in-window) — mirrors live maybeUpgrade.
	r.recatch = null;
	const t1 = num(r.t1), t2 = num(r.t2), seen = num(r.seen);
	if (t1 !== null && t2 !== null && seen !== null && (t2 - t1) >= 5 * 60000 && t2 <= seen + 21600000) {
		const liq2 = num(r.liq2), p2 = num(r.p2), p1 = num(r.p1);
		try {
			if (up.liqCrash(r.feed2 ?? null, r.src ?? null, liq1, liq2)) r.recatch = "liq_crash";
			else if (up.lateIlliquid(r.feed2 ?? null, r.src ?? null, liq1, liq2)) r.recatch = "late_illiquid";
			else if (up.priceCrash(p1, p2)) r.recatch = "price_crash";
		} catch { r.recatch = null; }
	}
}

// Fidelity: stored v_rule vs replayed hardRed (first-seen).
let agree = 0, vnull = 0;
for (const r of rows) {
	const stored = typeof r.vrule === "string" ? r.vrule : null;
	if (stored === null) vnull++;
	if ((stored ?? null) === (r.ruleReplay ?? null)) agree++;
}
console.log(`fidelity: ruleReplay==v_rule ${agree}/${rows.length} (stored-null=${vnull})`);

// RED MIX: who calls red?
const reds = rows.filter((r) => r.choice === "red");
const mix = {};
for (const r of reds) {
	const k = `vrule=${r.vrule ?? "-"} rsrc=${r.rsrc ?? "-"} up=${r.upfrom ? "Y:" + (r.upwhy ?? "?") : "-"}`;
	mix[k] = mix[k] ?? { n: 0, dead: 0 };
	mix[k].n++; if (r.dead === 1) mix[k].dead++;
}
console.log(`--- RED MIX (reds=${reds.length}/${rows.length}) ---`);
for (const [k, v] of Object.entries(mix).sort((a, b) => b[1].n - a[1].n))
	console.log(`  ${k} n=${v.n} prec=${(v.dead / v.n * 100).toFixed(1)}%`);

// f_* distribution (reds) to sanity-check the 0.7 bar.
const fvals = reds.map((r) => r.fMax).filter((v) => v !== null).sort((a, b) => a - b);
const pct = (p) => fvals.length ? fvals[Math.min(fvals.length - 1, Math.floor(p * fvals.length))] : null;
console.log(`fMax(reds): n=${fvals.length} p50=${pct(0.5)} p90=${pct(0.9)} max=${fvals[fvals.length - 1]}`);

// Time split: fit oldest 70% / eval newest 30%.
const sorted = [...rows].sort((a, b) => a.ts - b.ts);
const k = Math.floor(sorted.length * 0.7);
const evalSet = new Set(sorted.slice(k).map((r) => r.mint));
console.log(`fit=${k} eval=${sorted.length - k}`);

function sim(name, demoteFn, recatchFn) {
	let ok0 = 0, ok1 = 0, rd0 = 0, rd1 = 0, nR0 = 0, nR1 = 0;
	let eOk0 = 0, eOk1 = 0, eRd0 = 0, eRd1 = 0, eNR0 = 0, eNR1 = 0;
	let dem = 0, demDead = 0, rec = 0, recDead = 0;
	for (const r of rows) {
		const c0 = r.choice;
		let c1 = c0;
		if (demoteFn(r)) { c1 = "yellow"; dem++; if (r.dead === 1) demDead++; }
		if (c1 === "yellow" && c0 === "red" && recatchFn && recatchFn(r)) { c1 = "red"; rec++; if (r.dead === 1) recDead++; }
		if (correct(c0, r.dead)) ok0++;
		if (correct(c1, r.dead)) ok1++;
		if (c0 === "red") { nR0++; if (r.dead === 1) rd0++; }
		if (c1 === "red") { nR1++; if (r.dead === 1) rd1++; }
		if (evalSet.has(r.mint)) {
			if (correct(c0, r.dead)) eOk0++;
			if (correct(c1, r.dead)) eOk1++;
			if (c0 === "red") { eNR0++; if (r.dead === 1) eRd0++; }
			if (c1 === "red") { eNR1++; if (r.dead === 1) eRd1++; }
		}
	}
	const eN = sorted.length - k;
	const d = (x) => (x * 100).toFixed(1) + "%";
	console.log(`${name}: demote=${dem} (dead=${demDead} recall-loss) recatch=${rec} (dead=${recDead})`);
	console.log(`  ALL  acc ${d(ok0 / rows.length)}→${d(ok1 / rows.length)} redP ${d(rd0 / Math.max(1, nR0))}→${d(rd1 / Math.max(1, nR1))} (reds ${nR0}→${nR1})`);
	console.log(`  EVAL acc ${d(eOk0 / eN)}→${d(eOk1 / eN)} redP ${d(eRd0 / Math.max(1, eNR0))}→${d(eRd1 / Math.max(1, eNR1))} (reds ${eNR0}→${eNR1})`);
	return { dem, demDead, rec, acc0: ok0 / rows.length, acc1: ok1 / rows.length, redP0: rd0 / Math.max(1, nR0), redP1: rd1 / Math.max(1, nR1), eAcc0: eOk0 / eN, eAcc1: eOk1 / eN, eRedP0: eRd0 / Math.max(1, eNR0), eRedP1: eRd1 / Math.max(1, eNR1) };
}

const isIlliqRed = (r) => r.choice === "red" && r.vrule === "illiquid" && !r.upfrom;
const noConfirm = (r) => r.confirm === 0;
// V1: demote illiquid-alone reds with zero confirming reasons.
const v1 = sim("V1 demote-illiquid-alone", (r) => isIlliqRed(r) && noConfirm(r), null);
// V1U: V1 + upgrade re-catch on measured 2nd-snapshot crashes (A+C6 combo).
const v1u = sim("V1U demote+recatch", (r) => isIlliqRed(r) && noConfirm(r), (r) => r.recatch !== null);
// V2: demote ALL non-upgraded reds with <2 reasons (channel + >=1 confirm).
const v2 = sim("V2 demote-all-lonely", (r) => {
	if (r.choice !== "red" || r.upfrom) return false;
	if (r.vrule === "illiquid") return noConfirm(r);
	if (r.vrule === "bot_frenzy") return noConfirm(r); // R2 also needs a confirm
	return noConfirm(r); // jev/model/memory-alone reds need a confirm too
}, null);

const lift = v1u.eRedP1 - v1u.eRedP0;
console.log(`GATE-V1 (V1U eval redP lift): +${(lift * 100).toFixed(1)}pp (need >=+10pp) acc ${v1u.eAcc1 >= v1u.eAcc0 ? "ok" : "DOWN — veto"} -> ${lift >= 0.10 && v1u.eAcc1 >= v1u.eAcc0 ? "SHIP" : "KILL"}`);

// ============ PHASE 2: memory autopsy + calibrated KEEP reasons ============
const fitSet = new Set(sorted.slice(0, k).map((r) => r.mint));
const hasSig = (r) => num(r.top1) !== null || num(r.mauth) !== null || num(r.simpson) !== null || num(r.t211) !== null;

console.log(`--- CHANNEL AUTOPSY (by signals-row presence) ---`);
for (const [name, sel] of [["memory-reds", (r) => r.choice === "red" && r.rsrc === "memory" && !r.upfrom],
	["illiquid-reds", (r) => r.choice === "red" && r.vrule === "illiquid" && !r.upfrom]]) {
	const set = rows.filter(sel);
	const w = set.filter(hasSig), wo = set.filter((r) => !hasSig(r));
	const p = (a) => a.length ? (a.filter((r) => r.dead === 1).length / a.length * 100).toFixed(1) + "%" : "n/a";
	console.log(`  ${name}: n=${set.length} prec=${p(set)} | with-signals n=${w.length} prec=${p(w)} | missing-signals n=${wo.length} prec=${p(wo)}`);
}

// KEEP sweep among illiquid+memory reds: pick on FIT, verify on EVAL.
const pool = rows.filter((r) => r.choice === "red" && !r.upfrom && (r.rsrc === "memory" || r.vrule === "illiquid"));
const cand = {
	"authLive": (r) => r.authLive,
	"sellRatio>0.7": (r) => r.sellRatio !== null && r.sellRatio > 0.7,
	"sellRatio>0.8": (r) => r.sellRatio !== null && r.sellRatio > 0.8,
	"simpson<0.3": (r) => { const s = num(r.simpson); return s !== null && s < 0.3; },
	"simpson<0.2": (r) => { const s = num(r.simpson); return s !== null && s < 0.2; },
	"lrP>=0.85": (r) => r.lrP !== null && r.lrP >= 0.85,
	"lrP>=0.75": (r) => r.lrP !== null && r.lrP >= 0.75,
	"fMax>=0.9": (r) => r.fMax !== null && r.fMax >= 0.9,
	"liq1==0": (r) => num(r.liq1) === 0,
	"top1>30": (r) => { const t = num(r.top1); return t !== null && t > 30; },
	"chgH1<0": (r) => { const c = num(r.chg1); return c !== null && c < 0; },
	"src=dex": (r) => r.src === "dex",
};
console.log(`--- KEEP SWEEP (pool=${pool.length} illiquid+memory reds) ---`);
const picked = [];
for (const [name, fn] of Object.entries(cand)) {
	const f = pool.filter((r) => fitSet.has(r.mint) && fn(r));
	const e = pool.filter((r) => evalSet.has(r.mint) && fn(r));
	const fp = f.length ? f.filter((r) => r.dead === 1).length / f.length : null;
	const ep = e.length ? e.filter((r) => r.dead === 1).length / e.length : null;
	const d = (x) => x === null ? "n/a" : (x * 100).toFixed(1) + "%";
	const win = fp !== null && fp >= 0.65 && f.length >= 10;
	if (win) picked.push(name);
	console.log(`  ${name}: fit n=${f.length} prec=${d(fp)} | eval n=${e.length} prec=${d(ep)} ${win ? "KEEP-CANDIDATE" : ""}`);
}
console.log(`picked KEEP reasons: ${picked.length ? picked.join(", ") : "(none — fall back to full demote)"}`);
const keepFn = (r) => picked.some((name) => cand[name](r));
const isTarget = (r) => r.choice === "red" && !r.upfrom && (r.rsrc === "memory" || r.vrule === "illiquid");

// V3: demote ALL memory reds. V4: demote ALL memory+illiquid reds. V5: demote except calibrated-keep (+recatch).
sim("V3 demote-all-memory", (r) => r.choice === "red" && r.rsrc === "memory" && !r.upfrom, null);
sim("V4 demote-all-mem+illiq", (r) => isTarget(r), null);
const v5 = sim("V5 demote-except-keep", (r) => isTarget(r) && !keepFn(r), null);
const v5u = sim("V5U demote-except-keep+recatch", (r) => isTarget(r) && !keepFn(r), (r) => r.recatch !== null);
const lift5 = v5u.eRedP1 - v5u.eRedP0;
console.log(`GATE-V5 (V5U eval redP lift): +${(lift5 * 100).toFixed(1)}pp (need >=+10pp) acc ${v5u.eAcc1 >= v5u.eAcc0 ? "ok" : "DOWN — veto"} -> ${lift5 >= 0.10 && v5u.eAcc1 >= v5u.eAcc0 ? "SHIP" : "KILL"}`);
