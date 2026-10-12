// ML accuracy v2 checks: exercises the REAL src/ml/train.ts (compiled with the
// repo's own typescript into node_modules/.cache, never by hand).
// Usage: npm run mltest   (from radar/)
// Fails (exit 1) on any unexpected value.
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, "node_modules", ".cache", "ml-check");
const TSC = path.join(HERE, "node_modules", "typescript", "bin", "tsc");

let failures = 0;
let passes = 0;
function check(name, cond, detail = "") {
	if (cond) { passes++; console.log(`PASS ${name}`); }
	else { failures++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// --- compile the real module ---
if (!existsSync(TSC)) { console.error("FAIL typescript not installed (run npm install)"); process.exit(1); }
rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });
try {
	execSync(`"${process.execPath}" "${TSC}" src/ml/train.ts src/ml/upgrade.ts --outDir "${CACHE}" --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck --strict`,
		{ cwd: HERE, stdio: "pipe" });
} catch (e) {
	console.error("FAIL tsc compile:", String(e.stdout ?? e.message).slice(0, 400));
	process.exit(1);
}
const ml = await import(pathToFileURL(path.join(CACHE, "train.js")).href);
const up = await import(pathToFileURL(path.join(CACHE, "upgrade.js")).href);

// --- b64ToBytes ---
{
	const raw = Buffer.from([0, 1, 2, 250, 255, 16, 32, 64, 99]);
	const b64 = raw.toString("base64");
	const back = ml.b64ToBytes(b64);
	check("b64 round-trip", back !== null && Buffer.from(back).equals(raw));
	check("b64 rejects bad chars", ml.b64ToBytes("!!!=") === null);
	check("b64 rejects bad length", ml.b64ToBytes("abc") === null);
	check("b64 rejects empty", ml.b64ToBytes("") === null);
}

// --- parseMintAuthorities: 82-byte Solana Mint layout ---
function mintB64(mintTag, freezeTag, len = 82) {
	const b = Buffer.alloc(len);
	if (len >= 4) b.writeUInt32LE(mintTag, 0);
	if (len >= 50) b.writeUInt32LE(freezeTag, 46);
	return b.toString("base64");
}
{
	const rr = ml.parseMintAuthorities(mintB64(0, 0));
	check("auth renounced/renounced", rr !== null && rr.mintLive === 0 && rr.freezeLive === 0, JSON.stringify(rr));
	const lr = ml.parseMintAuthorities(mintB64(1, 0));
	check("auth live/renounced", lr !== null && lr.mintLive === 1 && lr.freezeLive === 0, JSON.stringify(lr));
	const ll = ml.parseMintAuthorities(mintB64(1, 1));
	check("auth live/live", ll !== null && ll.mintLive === 1 && ll.freezeLive === 1, JSON.stringify(ll));
	check("auth rejects short buffer", ml.parseMintAuthorities(mintB64(0, 0, 40)) === null);
	check("auth rejects garbage", ml.parseMintAuthorities("not-base64!!") === null);
	check("auth rejects non-string", ml.parseMintAuthorities(null) === null && ml.parseMintAuthorities(123) === null);
}

// --- buildFeatures: v8 27-dim leak-free layout + null defaults ---
{
	check("FEATURES has 27 entries", ml.FEATURES.length === 27, String(ml.FEATURES.length));
	// Leak guard (label v2 / model v8): no dim may read verdicts.p_red
	// (overwritten by upgrades after a price crash = post-outcome info).
	check("leak guard: no pRed-derived feature names", !ml.FEATURES.some((n) => /pred/i.test(n)), ml.FEATURES.join(","));
	const I = (n) => ml.FEATURES.indexOf(n);
	const nullRow = { ts: 1, dead: 0, choice: "yellow", liq: null, top1: null, t211: null, fdv: null, early: null, age: null, txns: null, buys: null, sells: null, pool: null, pRed: null, mintLive: null, freezeLive: null, chgH1: null, volH1: null, pairAge: null, simpson: null, fWhale: null, fSell: null, fStruct: null, src: null };
	const f = ml.buildFeatures(nullRow);
	check("features length 27", f.length === 27, String(f.length));
	const a = ml.buildFeatures({ ...nullRow, pRed: 0.01 });
	const b = ml.buildFeatures({ ...nullRow, pRed: 0.99 });
	check("leak guard: feature vector invariant to p_red", a.every((x, i) => x === b[i]), `${a.join(",")} vs ${b.join(",")}`);
	check("null auth -> 0.5 neutral", f[I("mintLive")] === 0.5 && f[I("freezeLive")] === 0.5);
	check("null momentum -> 0", f[I("momH1")] === 0 && f[I("volLiqH1")] === 0);
	check("null pairAge -> 0.5", f[I("pairAge")] === 0.5, String(f[I("pairAge")]));
	check("null lysis -> 0.3 placeholder", f[I("lysis")] === 0.3, String(f[I("lysis")]));
	check("null simpson -> 0.5 neutral", f[I("simpson")] === 0.5, String(f[I("simpson")]));
	const lys = ml.buildFeatures({ ...nullRow, t211: 20, fdv: 1000000, liq: 10000 });
	check("lysis log-scaled", approx(lys[I("lysis")], Math.log10(21) / 3), String(lys[I("lysis")]));
	const sim = ml.buildFeatures({ ...nullRow, simpson: 0.2 });
	check("simpson passthrough", sim[I("simpson")] === 0.2, String(sim[I("simpson")]));
	check("null factors -> 0.5 uncertain", f[I("fWhale")] === 0.5 && f[I("fSell")] === 0.5 && f[I("fStruct")] === 0.5);
	const fac = ml.buildFeatures({ ...nullRow, fWhale: 0.9, fSell: 0.1, fStruct: 1.7 });
	check("factors passthrough+clamp", fac[I("fWhale")] === 0.9 && fac[I("fSell")] === 0.1 && fac[I("fStruct")] === 1);
	check("null src -> 0.5 neutral", f[I("isGecko")] === 0.5, String(f[I("isGecko")]));
	check("gecko -> 1, dex -> 0", ml.buildFeatures({ ...nullRow, src: "gecko" })[I("isGecko")] === 1 && ml.buildFeatures({ ...nullRow, src: "dex" })[I("isGecko")] === 0);
	check("null row all-missing flags", f[I("missSig")] === 1 && f[I("missChg")] === 1 && f[I("missVol")] === 1 && f[I("missCount")] === 1);
	check("null row gap 0, sigChg 1", f[I("chgVolGap")] === 0 && f[I("missSigChg")] === 1);
	check("null row fSpread 0", f[I("fSpread")] === 0);
	const full = ml.buildFeatures({ ...nullRow, top1: 5, t211: 10, mintLive: 0, freezeLive: 0, simpson: 0.8, chgH1: 5, volH1: 5000, fWhale: 0.1, fSell: 0.1, fStruct: 0.7 });
	check("full row missing 0", full[I("missSig")] === 0 && full[I("missChg")] === 0 && full[I("missVol")] === 0 && full[I("missCount")] === 0 && full[I("missSigChg")] === 0);
	check("fSpread = max-min of factors", approx(full[I("fSpread")], 0.6), String(full[I("fSpread")]));
	const gap = ml.buildFeatures({ ...nullRow, top1: 5, t211: 10, mintLive: 0, freezeLive: 0, simpson: 0.8, volH1: 5000 });
	check("tape gap fires", gap[I("chgVolGap")] === 1 && gap[I("missSig")] === 0 && gap[I("missChg")] === 1);
	const live = ml.buildFeatures({ ...nullRow, mintLive: 1, freezeLive: 0, chgH1: -50, volH1: 10000, liq: 10000, pairAge: 720 });
	check("live auth -> 1/0", live[I("mintLive")] === 1 && live[I("freezeLive")] === 0);
	check("dump momentum negative", approx(live[I("momH1")], Math.tanh(-0.5)), String(live[I("momH1")]));
	check("volume depth positive", live[I("volLiqH1")] > 0);
	check("pairAge scaled", approx(live[I("pairAge")], 0.5), String(live[I("pairAge")]));
}

// --- shouldPromote (E4-4) ---
{
	const P = ml.shouldPromote;
	check("promote on acc win", P({ acc: 0.7, redP: 0.5 }, { acc: 0.8, redP: 0.5 }) === true);
	check("no promote on acc loss", P({ acc: 0.8, redP: 0.5 }, { acc: 0.7, redP: 0.9 }) === false);
	check("tie breaks on redP", P({ acc: 0.7, redP: 0.5 }, { acc: 0.7, redP: 0.6 }) === true);
	check("tie holds on worse redP", P({ acc: 0.7, redP: 0.6 }, { acc: 0.7, redP: 0.5 }) === false);
	check("full tie keeps incumbent", P({ acc: 0.7, redP: 0.6 }, { acc: 0.7, redP: 0.6 }) === false);
	check("null redP loses to value", P({ acc: 0.7, redP: null }, { acc: 0.7, redP: 0.1 }) === true);
}

// --- shadowGreen (E4-7) ---
{
	const good = { top1_pct: 10, top2_11_pct: 30, liquidity_usd: 50000, mint_age_min: 30, sell_ratio_5m: 0.4, mint_auth_live: 0, freeze_auth_live: 0 };
	check("shadowGreen passes relaxed", ml.shadowGreen(good) === true);
	check("shadowGreen rejects whale", ml.shadowGreen({ ...good, top1_pct: 50 }) === false);
	check("shadowGreen rejects live auth", ml.shadowGreen({ ...good, mint_auth_live: 1 }) === false);
	check("shadowGreen allows unknown auth", ml.shadowGreen({ ...good, mint_auth_live: null, freeze_auth_live: null }) === true);
	check("shadowGreen fails closed on missing", ml.shadowGreen({}) === false);
}

// --- cosine + memoryHit (E3-4) ---
{
	check("cosine identical", approx(ml.cosine([1, 2, 3], [1, 2, 3]), 1));
	check("cosine orthogonal", approx(ml.cosine([1, 0], [0, 1]), 0));
	check("cosine zero-vector", ml.cosine([0, 0], [1, 1]) === 0);
	const mem = [{ mint: "aaa", v: [1, 0, 0] }, { mint: "bbb", v: [0.9, 0.1, 0] }];
	const hit = ml.memoryHit([1, 0, 0], mem, "qqq", 0.98);
	check("memoryHit finds near-dupe", hit !== null && hit.mint === "aaa" && approx(hit.cos, 1), JSON.stringify(hit));
	check("memoryHit skips self", ml.memoryHit([1, 0, 0], mem, "aaa", 0.5) !== null && ml.memoryHit([1, 0, 0], [{ mint: "aaa", v: [1, 0, 0] }], "aaa", 0.5) === null);
	check("memoryHit respects threshold", ml.memoryHit([0, 1, 0], mem, "qqq", 0.98) === null);
	check("memoryHit skips corrupt", ml.memoryHit([1, 0], [{ mint: "x", v: [] }], "qqq", 0.1) === null);
}

// --- hardRed still intact ---
{
	check("hardRed illiquid", ml.hardRed({ liquidity_usd: 500, top1_pct: 50 }) === "illiquid");
	check("hardRed bot_frenzy", ml.hardRed({ liquidity_usd: 50000, mint_age_min: 5, txns_5m: 600 }) === "bot_frenzy");
	check("hardRed thin frenzy demoted", ml.hardRed({ liquidity_usd: 5000, mint_age_min: 5, txns_5m: 600 }) === null);
	check("hardRed fat cutoff 20k", ml.hardRed({ liquidity_usd: 20000, mint_age_min: 5, txns_5m: 600 }) === "bot_frenzy"
		&& ml.hardRed({ liquidity_usd: 19999, mint_age_min: 5, txns_5m: 600 }) === null);
	check("hardRed clean", ml.hardRed({ liquidity_usd: 50000, top1_pct: 5, mint_age_min: 60, txns_5m: 100 }) === null);
}

// --- demoteOneShot (V4: illiquid/memory one-shot reds become yellows) ---
{
	check("demote illiquid rule red", ml.demoteOneShot("rule:illiquid", "illiquid") === "demoted:illiquid");
	check("demote illiquid marker edge", ml.demoteOneShot("rule:illiquid", null) === "demoted:illiquid");
	check("demote memory red", ml.demoteOneShot("memory", null) === "demoted:memory");
	check("keep bot_frenzy", ml.demoteOneShot("rule:bot_frenzy", "bot_frenzy") === null);
	check("keep model/upgrade/jev", ml.demoteOneShot("model", null) === null && ml.demoteOneShot("upgrade", null) === null && ml.demoteOneShot("rule", null) === null && ml.demoteOneShot(null, null) === null);
	check("demote p_red calibrated", ml.DEMOTE_P_RED["demoted:illiquid"] === 0.17 && ml.DEMOTE_P_RED["demoted:memory"] === 0.14);
}

// --- trainLR learns a separable signal; challenger beats always-yellow ---
{
	const rows = [];
	for (let i = 0; i < 40; i++) {
		const dead = i % 2; // alternate: champ (always yellow) scores ~0.5
		rows.push({
			ts: 1000 + i, dead, choice: "yellow",
			liq: 50000, top1: dead ? 80 : 5, t211: 10, fdv: 1000000,
			early: 10, age: 60, txns: 100, buys: 50, sells: 50, pool: 0, pRed: 0.1,
			mintLive: dead ? 1 : 0, freezeLive: 0, chgH1: dead ? -60 : 5, volH1: 5000, pairAge: 60, simpson: dead ? 0.2 : 0.8,
			fWhale: dead ? 0.9 : 0.1, fSell: dead ? 0.9 : 0.1, fStruct: dead ? 0.9 : 0.1, src: "gecko",
		});
	}
	const res = ml.timeSplitValidate(rows);
	check("split 40 -> 28/12", res.n === 40 && res.nTrain === 28 && res.nTest === 12, `${res.n}/${res.nTrain}/${res.nTest}`);
	check("challenger reds separable signal", res.chalAcc === 1, String(res.chalAcc));
	check("challenger beats champ", res.chalAcc !== null && res.champAcc !== null && res.chalAcc > res.champAcc,
		`chal=${res.chalAcc} champ=${res.champAcc}`);
}

// --- ruleSilent + residual-only training (E4-3) ---
{
	const silent = { liq: 50000, top1: 5, t211: 10, fdv: 1000000, early: 10, age: 60, txns: 100, buys: 50, sells: 50 };
	check("ruleSilent clean row", ml.ruleSilent(silent) === true);
	check("ruleSilent illiquid fires", ml.ruleSilent({ ...silent, liq: 500, top1: 50 }) === false);
	check("ruleSilent frenzy fires", ml.ruleSilent({ ...silent, age: 5, txns: 600 }) === false);
	check("ruleSilent missing-top1 fires", ml.ruleSilent({ ...silent, liq: 500, top1: undefined }) === false);
	// Number(null)=0 quirk: null/null stays silent — pinned to mirror live exactly.
	check("ruleSilent null/null silent (quirk pin)", ml.ruleSilent({ ...silent, liq: null, top1: null }) === true);
	// 40 silent (old) + 10 rule-fired (new): train slice must exclude fired rows
	const rows = [];
	for (let i = 0; i < 40; i++) {
		rows.push({ ts: 1000 + i, dead: i % 2, choice: "yellow", liq: 50000, top1: 5, t211: 10, fdv: 1000000, early: 10, age: 60, txns: 100, buys: 50, sells: 50, pool: 0, pRed: 0.1, mintLive: 0, freezeLive: 0, chgH1: 5, volH1: 5000, pairAge: 60, simpson: 0.8, fWhale: 0.1, fSell: 0.1, fStruct: 0.1, src: "gecko" });
	}
	for (let i = 0; i < 10; i++) {
		rows.push({ ts: 2000 + i, dead: 1, choice: "red", liq: 500, top1: 50, t211: 10, fdv: 1000000, early: 10, age: 60, txns: 100, buys: 50, sells: 50, pool: 0, pRed: 0.9, mintLive: 1, freezeLive: 0, chgH1: -60, volH1: 5000, pairAge: 60, simpson: 0.2, fWhale: 0.9, fSell: 0.9, fStruct: 0.9, src: "gecko" });
	}
	const r2 = ml.timeSplitValidate(rows);
	check("residual train excludes fired (35/50)", r2.nTrain === 35 && r2.nSilentTrain === 35, `${r2.nTrain}/${r2.n}`);
	check("silent test slice counted (5)", r2.nSilentTest === 5, String(r2.nSilentTest));
	check("silent metrics present", typeof r2.chalRedSilent === "number" && (r2.chalRedPSilent === null || typeof r2.chalRedPSilent === "number"));
}

// --- zombie drop from TRAIN only (E2-2) ---
{
	const rows = [];
	for (let i = 0; i < 30; i++) {
		rows.push({ ts: 1000 + i, dead: i % 2, choice: "yellow", liq: 50000, top1: 5, t211: 10, fdv: 1000000, early: 10, age: 60, txns: 100, buys: 50, sells: 50, pool: 0, pRed: 0.1, mintLive: 0, freezeLive: 0, chgH1: 5, volH1: 5000, pairAge: 60, simpson: 0.8, fWhale: 0.1, fSell: 0.1, fStruct: 0.1, src: "gecko", zombie: i < 5 || i === 25 });
	}
	const r = ml.timeSplitValidate(rows);
	check("zombies dropped from train (16/21)", r.nTrain === 16 && r.nZombieDropped === 5, `${r.nTrain}/${r.nZombieDropped}`);
	check("test slice keeps all (9)", r.nTest === 9, String(r.nTest));
}

// --- feed-aware upgrade triggers (E5-1) ---
{
	check("sameFeed dex/dex", up.sameFeed("dex", "dex") === true);
	check("sameFeed case-insensitive", up.sameFeed("Gecko", "gecko") === true);
	check("sameFeed rejects cross-feed", up.sameFeed("dex", "gecko") === false);
	check("sameFeed fails closed on null", up.sameFeed(null, "dex") === false && up.sameFeed("dex", null) === false);
	check("liqCrash same-feed fires", up.liqCrash("gecko", "gecko", 5000, 2000) === true);
	check("liqCrash holds above half", up.liqCrash("gecko", "gecko", 5000, 3000) === false);
	check("liqCrash cross-feed NEVER fires (dex structural 0)", up.liqCrash("dex", "gecko", 5000, 0) === false);
	check("liqCrash zero-first never fires", up.liqCrash("dex", "dex", 0, 0) === false);
	check("lateIlliquid same-feed fires", up.lateIlliquid("dex", "dex", 5000, 500) === true);
	check("lateIlliquid cross-feed never fires", up.lateIlliquid("dex", "gecko", 5000, 0) === false);
	check("lateIlliquid dust-first never fires", up.lateIlliquid("dex", "dex", 500, 100) === false);
	check("priceCrash fires any feed", up.priceCrash(0.01, 0.002) === true);
	check("priceCrash holds above -70%", up.priceCrash(0.01, 0.005) === false);
	const d1 = up.resolveDead(0.05, 50000, "dex", "dex", 100, 50);
	check("resolveDead mult<=0.1", d1.dead === 1, JSON.stringify(d1));
	const d2 = up.resolveDead(0.9, 500, "gecko", "gecko", 100, 50);
	check("resolveDead same-feed liq clause", d2.dead === 1, JSON.stringify(d2));
	const d3 = up.resolveDead(0.9, 0, "dex", "gecko", 100, 50);
	check("resolveDead cross-feed liq SKIPPED (healthy pump survives)", d3.dead === 0, JSON.stringify(d3));
	const d4 = up.resolveDead(1, 50000, "dex", "dex", 0, 0);
	check("resolveDead zombie", d4.dead === 1 && d4.zombie === true, JSON.stringify(d4));
	const d5 = up.resolveDead(1, 50000, "dex", "dex", 100, 50);
	check("resolveDead frozen-but-traded survives", d5.dead === 0, JSON.stringify(d5));
	const d6 = up.resolveDead(0.9, null, "gecko", "gecko", 100, 50);
	check("resolveDead null liq counts dead (old ?? 0 semantics)", d6.dead === 1, JSON.stringify(d6));
	check("ruleConfidence R1 keeps 0.95", up.ruleConfidence("illiquid") === 0.95);
	check("ruleConfidence R2-fat restamped 0.60", up.ruleConfidence("bot_frenzy") === 0.6);
	check("ruleConfidence null defaults 0.95", up.ruleConfidence(null) === 0.95);
}

// --- reward shaping (Oct 11 wave-1 winner: 30-dim pw=5 bar=0.7 l2=0.01) ---
{
	check("tuned defaults pinned", ml.DEFAULT_POS_WEIGHT === 5 && ml.DEFAULT_RED_BAR === 0.7 && ml.DEFAULT_L2 === 0.01,
		`${ml.DEFAULT_POS_WEIGHT}/${ml.DEFAULT_RED_BAR}/${ml.DEFAULT_L2}`);
	const mk = (dead, top1) => ({ ts: 1, dead, choice: "yellow", liq: 50000, top1, t211: 10, fdv: 1000000, early: 10, age: 60, txns: 100, buys: 50, sells: 50, pool: 0, pRed: 0.1, mintLive: 0, freezeLive: 0, chgH1: 5, volH1: 5000, pairAge: 60, simpson: 0.8, fWhale: 0.1, fSell: 0.1, fStruct: 0.1, src: "gecko" });
	const data = [];
	for (let i = 0; i < 20; i++) data.push(mk(0, 5));
	for (let i = 0; i < 4; i++) data.push(mk(1, 80));
	const plain = ml.trainLR(data.map((r) => ({ x: ml.buildFeatures(r), y: r.dead })));
	const heavy = ml.trainLR(data.map((r) => ({ x: ml.buildFeatures(r), y: r.dead, w: r.dead === 1 ? 12 : 1 })));
	const probe = ml.buildFeatures(mk(1, 80));
	const pp = ml.predict(plain, probe);
	const ph = ml.predict(heavy, probe);
	check("posWeight raises dead-row p", ph > pp, `${pp.toFixed(3)} -> ${ph.toFixed(3)}`);
	const srows = [];
	for (let i = 0; i < 40; i++) {
		const dead = i % 2;
		srows.push({ ...mk(dead, dead ? 80 : 5), ts: 1000 + i });
	}
	const sres = ml.timeSplitValidate(srows, { posWeight: 5, redBar: 0.7, l2: 0.01 });
	check("winner hyper separable still 1", sres.chalAcc === 1, String(sres.chalAcc));
}


// --- label v2: resolveDeadV2 (Oct 12) ---
{
	const H = 3600e3, T0 = 1_000_000_000;
	const S = (o) => ({ ts: T0, price: 1, liq: 5000, feed: "gecko", tx5: 10, volH1: 100, ...o });
	const first = S({});
	const R = T0 + 6 * H + 60e3; // resolution 6h01m after first sight
	const L = (o) => S({ ts: T0 + 6 * H, ...o });
	const v = (last, prior = null, ff = "gecko", f0 = first) => up.resolveDeadV2(f0, last, prior, ff, R);
	check("v2 price -90% dead", v(L({ price: 0.1, feed: "dex", volH1: 50 })).dead_v2 === 1);
	check("v2 price -89% not dead by price", v(L({ price: 0.11, feed: "dex", volH1: 50 })).dead_v2 === 0);
	check("v2 same-feed liq<1000 dead", v(L({ liq: 999, volH1: null, tx5: 5 })).dead_v2 === 1);
	check("v2 cross-feed liq 0 ignored (dex structural 0)", v(L({ liq: 0, feed: "dex", volH1: 50, tx5: 0 })).dead_v2 === 0);
	const idle = v(L({ feed: "dex", liq: 0, volH1: 0, tx5: 0 }));
	check("v2 idle: dex vol_h1=0 & tx5=0 -> dead", idle.dead_v2 === 1 && idle.idle === 1, JSON.stringify(idle));
	const traded = v(L({ feed: "dex", liq: 0, volH1: 12.5, tx5: 0 }));
	check("v2 h1 volume > 0 -> alive, idle 0", traded.dead_v2 === 0 && traded.idle === 0, JSON.stringify(traded));
	check("v2 vol 0 but tx5 > 0 -> not idle", v(L({ feed: "dex", volH1: 0, tx5: 3 })).idle === 0);
	const stale = up.resolveDeadV2(first, L({ ts: T0 + 3 * H, feed: "dex", volH1: 0, tx5: 0 }), null, "gecko", R);
	check("v2 stale last (>90 min) -> idle unknown, alive", stale.idle === null && stale.dead_v2 === 0, JSON.stringify(stale));
	const nos = up.resolveDeadV2(first, first, null, "gecko", R);
	check("v2 no follow-up sample -> ungradeable NULL", nos.dead_v2 === null && nos.idle === null);
	check("v2 no first price -> NULL", up.resolveDeadV2(S({ price: 0 }), L({}), null, "gecko", R).dead_v2 === null);
	// gecko-feed last (no h1 volume): frozen-price proof via a prior sample
	const gl = L({ feed: "gecko", volH1: null, tx5: 0, price: 0.5 });
	check("v2 gecko frozen price 60 min + tx5 0 -> idle", v(gl, S({ ts: gl.ts - 60 * 60e3, price: 0.5 })).idle === 1);
	check("v2 gecko price moved -> not idle", v(gl, S({ ts: gl.ts - 60 * 60e3, price: 0.6 })).idle === 0);
	check("v2 gecko prior too recent (<55 min) -> unknown", v(gl, S({ ts: gl.ts - 30 * 60e3, price: 0.5 })).idle === null);
	check("v2 gecko no prior but tx5>0 -> not idle", v(L({ feed: "gecko", volH1: null, tx5: 4 })).idle === 0);
	// resolveDead carries both labels; v1 semantics unchanged
	const both = up.resolveDead(0.9, 0, "dex", "gecko", 100, 0, { first, last: L({ feed: "dex", liq: 0, volH1: 0, tx5: 0 }), prior: null, resolvedAt: R });
	check("resolveDead v1 alive / v2 dead on idle dust (the bug v2 fixes)", both.dead === 0 && both.dead_v2 === 1 && both.idle === 1, JSON.stringify(both));
	const legacy = up.resolveDead(0.9, 0, "dex", "gecko", 100, 0);
	check("resolveDead without v2 arg = legacy shape", legacy.dead === 0 && legacy.dead_v2 === undefined);
	check("LABEL_V2 contract constants", up.LABEL_V2.horizonH === 6 && up.LABEL_V2.priceDrop === 0.9 && up.LABEL_V2.liqUsd === 1000 && up.LABEL_V2.idleWindowH === 1);
}

// --- policy v2 tiers ---
{
	const P = ml.policyV2;
	check("tier red_sure at p>=T_SURE", P(0.995, null, "yellow").tier === "red_sure" && P(ml.T_SURE, null, "green").choice === "red");
	check("tier red at p>0.5", P(0.6, null, "green").tier === "red" && P(0.6, null, "green").choice === "red");
	check("p exactly 0.5 is not red", P(0.5, null, "yellow").choice === "yellow");
	check("hard rule forces red over alive model", P(0.1, "illiquid", "green").choice === "red" && P(0.1, "illiquid", "green").tier === "red");
	check("tier green at p<=T_GREEN", P(0.2, null, "yellow").tier === "green" && P(ml.T_GREEN, null, "yellow").choice === "green");
	check("tier yellow in (T_GREEN, 0.5]", P(0.4, null, "yellow").tier === "yellow");
	check("Jev green lifts unsure-alive to green", P(0.4, null, "green").tier === "green");
	check("no model -> all-red base-rate fallback", P(null, null, "green").choice === "red" && P(null, null, "green").tier === "red");
	check("thresholds pinned", ml.T_RED === 0.5 && ml.T_SURE === 0.99 && ml.T_GREEN === 0.3 && ml.LABEL_V === 2 && ml.POLICY_V === 2 && ml.MODEL_V === 8);
}

// --- Newton LR + label-switch validation ---
{
	const mk = (i, dead) => ({ ts: 1000 + i, dead, choice: "yellow", liq: 50000, top1: dead ? 80 : 5, t211: 10, fdv: 1000000, early: 10, age: 60, txns: 100, buys: 50, sells: 50, pool: 0, mintLive: dead ? 1 : 0, freezeLive: 0, chgH1: dead ? -60 : 5, volH1: 5000, pairAge: 60, simpson: dead ? 0.2 : 0.8, fWhale: dead ? 0.9 : 0.1, fSell: 0.5, fStruct: 0.5, src: "gecko" });
	const rows = [];
	for (let i = 0; i < 60; i++) rows.push(mk(i, i % 3 === 0 ? 0 : 1)); // 2/3 dead
	const m = ml.trainLRNewton(rows.map((r) => ({ x: ml.buildFeatures(r), y: r.dead })));
	check("newton dims == FEATURES", m.weights.length === ml.FEATURES.length);
	check("newton separates signal", ml.predict(m, ml.buildFeatures(mk(0, 1))) > 0.9 && ml.predict(m, ml.buildFeatures(mk(0, 0))) < 0.1);
	const res = ml.timeSplitValidateV2(rows, null);
	check("v2 split 60 -> 42/18", res.nTrain === 42 && res.nTest === 18, `${res.nTrain}/${res.nTest}`);
	check("no v2 champion -> all-red baseline bar", res.champIsBaseline === true && approx(res.champAcc, res.allRedAcc));
	check("challenger beats all-red on separable", res.chalAcc === 1 && res.chalAcc > res.champAcc, `${res.chalAcc} vs ${res.champAcc}`);
	check("AUC computed", res.auc === 1, String(res.auc));
	const wrongDims = { weights: [1, 2, 3], bias: 0, features: ["a", "b", "c"] };
	check("v1/foreign-dim champion is never compared", ml.timeSplitValidateV2(rows, wrongDims).champIsBaseline === true);
	check("champion re-scored on same slice", ml.timeSplitValidateV2(rows, res.model).champAcc === 1);
	check("aucOf mixed", approx(ml.aucOf([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75));
}

// --- retrain rowset: label v2, no p_red, first-sight signals only ---
{
	check("RETRAIN_SQL_V2 labels with dead_v2", /o\.dead_v2 AS dead/.test(ml.RETRAIN_SQL_V2) && /dead_v2 IS NOT NULL/.test(ml.RETRAIN_SQL_V2));
	check("leak guard: RETRAIN_SQL_V2 never reads p_red", !/p_red/i.test(ml.RETRAIN_SQL_V2));
	const base = { ts: 5, dead: 1, choice: "red", seen: 1000, sigTs: 1000 + 60e3, top1: 40, simpson: 0.3, liq: 900, fWhale: 0.7, src: "gecko", pRed: 0.99 };
	const r1 = ml.rowFromDb(base);
	check("rowFromDb keeps first-sight signals", r1.top1 === 40 && r1.simpson === 0.3 && r1.dead === 1 && r1.pRed === undefined);
	const r2 = ml.rowFromDb({ ...base, sigTs: 1000 + 11 * 60e3 });
	check("rowFromDb nulls late (recomputed) signals", r2.top1 === null && r2.simpson === null && r2.liq === 900);
}

// --- backfill-v9.sql parity with resolveDeadV2 (synthetic, node:sqlite) ---
try {
	const { DatabaseSync } = await import("node:sqlite");
	const { readFileSync } = await import("node:fs");
	const db = new DatabaseSync(":memory:");
	const NEW = ["dead_v2", "idle", "p_red_first", "tier", "policy_v", "label_v"];
	db.exec(readFileSync(path.join(HERE, "schema.sql"), "utf8").split(/\r?\n/).filter((l) => !NEW.some((c) => l.trim().startsWith(c + " "))).join("\n").replace(/,(\s*\))/g, "$1"));
	db.exec(readFileSync(path.join(HERE, "migrate-v9.sql"), "utf8"));
	const H = 3600e3, T0 = 1_000_000_000, RAT = T0 + 6 * H + 60e3;
	const cases = {
		price: [["gecko", 0, 1, 5000, 10, 100], ["dex", 6 * H, 0.05, 0, 0, 20]],
		liq: [["gecko", 0, 1, 5000, 10, null], ["gecko", 6 * H, 0.9, 500, 3, null]],
		idleDex: [["gecko", 0, 1, 5000, 10, 100], ["dex", 6 * H, 0.8, 0, 0, 0]],
		aliveDex: [["gecko", 0, 1, 5000, 10, 100], ["dex", 6 * H, 0.8, 0, 0, 40]],
		stale: [["gecko", 0, 1, 5000, 10, 100], ["dex", 3 * H, 0.8, 0, 0, 0]],
		nosample: [["gecko", 0, 1, 5000, 10, 100]],
		geckoFrozen: [["gecko", 0, 1, 5000, 10, null], ["gecko", 5 * H, 0.7, 4000, 0, null], ["gecko", 6 * H, 0.7, 4000, 0, null]],
		geckoMoved: [["gecko", 0, 1, 5000, 10, null], ["gecko", 5 * H, 0.75, 4000, 2, null], ["gecko", 6 * H, 0.7, 4000, 0, null]],
		late: [["gecko", 0, 1, 5000, 10, 100], ["dex", 6 * H, 0.8, 0, 0, 30], ["dex", 9 * H, 0.01, 0, 0, 0]],
	};
	const insS = db.prepare("INSERT INTO snapshots (mint, ts, price_usd, liquidity_usd, txns_5m, vol_h1, feed) VALUES (?, ?, ?, ?, ?, ?, ?)");
	for (const [mint, ss] of Object.entries(cases)) {
		db.prepare("INSERT INTO rounds (mint, first_seen, source) VALUES (?, ?, 'gecko')").run(mint, T0);
		db.prepare("INSERT INTO outcomes (mint, resolved_at, dead) VALUES (?, ?, 0)").run(mint, RAT);
		for (const [feed, dt, p, l, tx, vol] of ss) insS.run(mint, T0 + dt, p, l, tx, vol, feed);
	}
	db.exec(readFileSync(path.join(HERE, "backfill-v9.sql"), "utf8"));
	let ok = 0; const bad = [];
	for (const [mint, ss] of Object.entries(cases)) {
		const lite = (s) => s ? { ts: T0 + s[1], price: s[2], liq: s[3], feed: s[0], tx5: s[4], volH1: s[5] } : null;
		const inH = ss.filter((s) => T0 + s[1] <= RAT);
		const last = inH[inH.length - 1];
		const prior = ss.find((s) => T0 + s[1] >= T0 + last[1] - 2 * H && T0 + s[1] <= T0 + last[1] - 55 * 60e3) ?? null;
		const js = up.resolveDeadV2(lite(ss[0]), lite(last), lite(prior), "gecko", RAT);
		const row = db.prepare("SELECT dead_v2, idle FROM outcomes WHERE mint = ?").get(mint);
		if ((row.dead_v2 ?? null) === (js.dead_v2 ?? null) && (row.idle ?? null) === (js.idle ?? null)) ok++; else bad.push(`${mint}: sql=${row.dead_v2}/${row.idle} js=${js.dead_v2}/${js.idle}`);
	}
	check(`backfill-v9 parity (${Object.keys(cases).length} synthetic cases)`, bad.length === 0, bad.join("; "));
	const exp = Object.fromEntries(db.prepare("SELECT mint, dead_v2 FROM outcomes").all().map((r) => [r.mint, r.dead_v2]));
	check("backfill-v9 expected labels", exp.price === 1 && exp.liq === 1 && exp.idleDex === 1 && exp.aliveDex === 0 && exp.stale === 0 && exp.nosample === null && exp.geckoFrozen === 1 && exp.geckoMoved === 0 && exp.late === 0, JSON.stringify(exp));
	const leftover = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '_regrade_v9%'").get();
	check("backfill-v9 drops scratch tables", Number(leftover.n) === 0);
} catch (e) {
	check("backfill-v9 parity (node:sqlite)", false, String(e).slice(0, 200));
}

// --- on-demand verdict guard: never overwrite first-sight verdicts ---
{
	const P = up.shouldPersistVerdict, now = 1_000_000_000;
	check("persist when this call created the round", P({ createdRound: true, firstSeen: now, hasVerdict: false, now }) === true);
	check("persist fresh round (<10 min) without verdict", P({ createdRound: false, firstSeen: now - 5 * 60e3, hasVerdict: false, now }) === true);
	check("never overwrite existing verdict (fresh round)", P({ createdRound: false, firstSeen: now - 60e3, hasVerdict: true, now }) === false);
	check("never write late verdict for old coin", P({ createdRound: false, firstSeen: now - 3 * 3600e3, hasVerdict: false, now }) === false);
	check("10 min boundary is preview", P({ createdRound: false, firstSeen: now - 10 * 60e3, hasVerdict: false, now }) === false);
	check("unknown round -> preview", P({ createdRound: false, firstSeen: null, hasVerdict: false, now }) === false);
	check("future first_seen -> preview", P({ createdRound: false, firstSeen: now + 60e3, hasVerdict: false, now }) === false);
}

if (failures > 0) { console.error(`${failures} check(s) failed, ${passes} passed`); process.exit(1); }
console.log(`ml-check: all green (${passes} passed)`);
