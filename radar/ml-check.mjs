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
	execSync(`"${process.execPath}" "${TSC}" src/ml/train.ts src/ml/upgrade.ts src/ml/gbm.ts src/ml/collect.ts src/ml/ranking.ts --outDir "${CACHE}" --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck --strict`,
		{ cwd: HERE, stdio: "pipe" });
} catch (e) {
	console.error("FAIL tsc compile:", String(e.stdout ?? e.message).slice(0, 400));
	process.exit(1);
}
const ml = await import(pathToFileURL(path.join(CACHE, "train.js")).href);
const up = await import(pathToFileURL(path.join(CACHE, "upgrade.js")).href);
const gbm = await import(pathToFileURL(path.join(CACHE, "gbm.js")).href);
const col = await import(pathToFileURL(path.join(CACHE, "collect.js")).href);
const rk = await import(pathToFileURL(path.join(CACHE, "ranking.js")).href);
// LIVE-001 pure helpers compile into their own dir (keeps rootDir of the ml set).
try {
	execSync(`"${process.execPath}" "${TSC}" src/live-core.ts --outDir "${path.join(CACHE, "live")}" --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck --strict`, { cwd: HERE, stdio: "pipe" });
} catch (e) {
	console.error("FAIL tsc compile live-core:", String(e.stdout ?? e.message).slice(0, 400));
	process.exit(1);
}
const lc = await import(pathToFileURL(path.join(CACHE, "live", "live-core.js")).href);

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
	// DATA-001 label isolation: every case also gets +15m and near-resolution
	// look samples that WOULD flip labels if read (dust price, zero liq/vol,
	// fresh). Parity + expected labels below must be unchanged.
	const insL = db.prepare("INSERT INTO snapshots (mint, ts, price_usd, liquidity_usd, txns_5m, vol_h1, feed, look) VALUES (?, ?, ?, ?, ?, ?, 'gecko', ?)");
	const LOOKS = [[15 * 60e3, 15], [6 * H + 30e3, 30]];
	for (const mint of Object.keys(cases)) for (const [dt, lk] of LOOKS) insL.run(mint, T0 + dt, 1e-9, 0, 0, 0, lk);
	{ // control: the look rows would matter if they were not excluded
		let flips = 0;
		for (const [, ss] of Object.entries(cases)) {
			const lite = (s) => s ? { ts: T0 + s[1], price: s[2], liq: s[3], feed: s[0], tx5: s[4], volH1: s[5] } : null;
			const all = [...ss, ...LOOKS.map(([dt]) => ["gecko", dt, 1e-9, 0, 0, 0])].sort((a, b) => a[1] - b[1]);
			const inA = all.filter((x) => T0 + x[1] <= RAT), lastA = inA[inA.length - 1];
			const inH = ss.filter((x) => T0 + x[1] <= RAT), lastH = inH[inH.length - 1];
			const pr = (arr, l) => arr.find((x) => x[1] >= l[1] - 2 * H && x[1] <= l[1] - 55 * 60e3) ?? null;
			const a = up.resolveDeadV2(lite(all[0]), lite(lastA), lite(pr(all, lastA)), "gecko", RAT);
			const b = up.resolveDeadV2(lite(ss[0]), lite(lastH), lite(pr(ss, lastH)), "gecko", RAT);
			if (a.dead_v2 !== b.dead_v2 || a.idle !== b.idle) flips++;
		}
		check("look-isolation control: look rows would flip labels if read", flips >= 3, String(flips));
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
	// Live resolution SQL (index.ts imports these constants) ignores look rows.
	{
		const bad2 = [];
		for (const [mint, ss] of Object.entries(cases)) {
			const f = db.prepare(col.RESOLVE_FIRST_SQL).get(mint);
			const l = db.prepare(col.RESOLVE_LAST_SQL).get(mint);
			const want = ss[ss.length - 1];
			const pr = ss.find((x) => x[1] >= want[1] - 2 * H && x[1] <= want[1] - 55 * 60e3) ?? null;
			const p = db.prepare(col.RESOLVE_PRIOR_SQL).get(mint, l.ts - up.LABEL_V2.priorMaxMs, l.ts - up.LABEL_V2.priorMinMs);
			if (f.ts !== T0 + ss[0][1] || l.ts !== T0 + want[1] || l.p !== want[2] || (p?.ts ?? null) !== (pr ? T0 + pr[1] : null)) bad2.push(mint);
		}
		check("resolution SQL (first/last/prior) ignores look snapshots", bad2.length === 0, bad2.join(","));
	}
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

// --- LightGBM shadow challenger (SHADOW-001) ---
{
	const { readFileSync } = await import("node:fs");
	const model = JSON.parse(readFileSync(path.join(HERE, "src", "ml", "gbm-model.json"), "utf8"));
	const fx = JSON.parse(readFileSync(path.join(HERE, "gbm-parity.json"), "utf8")).rows;
	check("gbm model passes feature-order guard", gbm.gbmModelOk(model) === true);
	check("gbm model features == train.ts FEATURES", JSON.stringify(model.features) === JSON.stringify([...ml.FEATURES]) && JSON.stringify(model.meta.features) === JSON.stringify([...ml.FEATURES]));
	check("gbm meta has gbm_v + t_sure", model.meta.gbm_v === "gbm27-2026-10-12" && typeof model.meta.t_sure === "number" && model.meta.t_sure > 0.9 && model.meta.t_sure < 1);
	let worst = 0;
	for (const c of fx) worst = Math.max(worst, Math.abs(gbm.predictGbm(model, c.x) - c.p));
	check(`gbm parity vs LightGBM (${fx.length} rows) <= 1e-9`, fx.length >= 20 && worst <= 1e-9, `max_abs_err=${worst}`);
	check("scoreGbm == predictGbm on fixture", approx(gbm.scoreGbm(model, fx[0].x), fx[0].p, 1e-9));
	// guard: any reorder / rename / wrong dims refuses to score
	const swapped = { ...model, features: [model.features[1], model.features[0], ...model.features.slice(2)] };
	check("gbm refuses swapped feature order", gbm.gbmModelOk(swapped) === false && gbm.scoreGbm(swapped, fx[0].x) === null);
	const metaBad = { ...model, meta: { ...model.meta, features: model.features.slice(0, 26) } };
	check("gbm refuses meta feature mismatch", gbm.scoreGbm(metaBad, fx[0].x) === null);
	check("gbm refuses wrong dims", gbm.scoreGbm(model, fx[0].x.slice(0, 26)) === null);
	check("gbm null on garbage model", gbm.scoreGbm(null, fx[0].x) === null && gbm.scoreGbm({ kind: "x" }, fx[0].x) === null);
	const broken = { ...model, trees: [{ f: [0], t: [0], dl: [0], l: [0], r: [0], v: [0], root: 0 }] };
	check("gbm null (no throw) on cyclic tree", gbm.scoreGbm(broken, fx[0].x) === null);
	// live vector from buildFeatures scores to a probability
	const row = { ts: 0, dead: 0, choice: "yellow", liq: 12000, top1: 12, t211: 25, fdv: 50000, early: 40, age: 30, txns: 120, buys: 70, sells: 50, pool: 0, mintLive: 0, freezeLive: 0, chgH1: 15, volH1: 9000, pairAge: 20, simpson: 0.8, fWhale: 0.3, fSell: 0.4, fStruct: 0.2, src: "gecko" };
	const pg = gbm.scoreGbm(model, ml.buildFeatures(row));
	check("gbm scores a buildFeatures vector in (0,1)", typeof pg === "number" && pg > 0 && pg < 1, String(pg));
	// AUC (Mann-Whitney with ties)
	check("auc perfect = 1", ml.aucOf([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]) === 1);
	check("auc inverted = 0", ml.aucOf([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]) === 0);
	check("auc all ties = 0.5", ml.aucOf([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]) === 0.5);
	// pos {0.6,0.4}, neg {0.4,0.2}: pairs (0.6>0.4)=1,(0.6>0.2)=1,(0.4=0.4)=.5,(0.4>0.2)=1 -> 3.5/4
	check("auc partial ties = 0.875", approx(ml.aucOf([0.6, 0.4, 0.4, 0.2], [1, 1, 0, 0]), 0.875));
	check("auc one class = null", ml.aucOf([0.1, 0.2], [1, 1]) === null);
	// challengerStats
	const rows = [];
	for (let i = 0; i < 40; i++) rows.push({ pLr: i < 4 ? 0.3 : 0.9, pGbm: i < 4 ? 0.2 : 0.95, dead: i < 4 ? 0 : 1 });
	const st = gbm.challengerStats(rows);
	check("challenger n/acc/baseline", st.n === 40 && st.acc_lr === 1 && st.acc_gbm === 1 && approx(st.baseline_all_red_accuracy, 0.9), JSON.stringify(st));
	check("challenger auc + brier", st.auc_lr === 1 && st.auc_gbm === 1 && approx(st.brier_lr, (4 * 0.09 + 36 * 0.01) / 40) && approx(st.brier_gbm, (4 * 0.04 + 36 * 0.0025) / 40));
	check("challenger survivor_top5 (2 lowest of 40 alive)", st.survivor_top5_lr === 1 && st.survivor_top5_gbm === 1);
	check("challenger survivor null under 20 rows", gbm.challengerStats(rows.slice(0, 19)).survivor_top5_lr === null);
	check("challenger acc threshold strictly > 0.5", gbm.challengerStats([{ pLr: 0.5, pGbm: 0.51, dead: 1 }]).acc_lr === 0 && gbm.challengerStats([{ pLr: 0.5, pGbm: 0.51, dead: 1 }]).acc_gbm === 1);
	check("challenger empty", gbm.challengerStats([]).n === 0 && gbm.challengerStats([]).auc_gbm === null);
	// source guards: shadow columns written only by first-verdict INSERTs,
	// never by an UPDATE (decider wiring: SWITCH-001 block below).
	const src = readFileSync(path.join(HERE, "src", "index.ts"), "utf8");
	const updates = src.match(/UPDATE verdicts[^"`]*/g) ?? [];
	check("upgrade UPDATE never sets p_gbm_first/p_lr_first/gbm_v", updates.length > 0 && updates.every((u) => !/p_gbm_first|p_lr_first|gbm_v/.test(u)), updates.join(" | ").slice(0, 200));
	const inserts = src.match(/INSERT OR REPLACE INTO verdicts \([^)]*\)/g) ?? [];
	check("every verdict INSERT stores p_lr_first, p_gbm_first, gbm_v", inserts.length >= 4 && inserts.every((q) => /p_lr_first, p_gbm_first, gbm_v/.test(q)), String(inserts.length));
}

// --- SWITCH-001: LightGBM decides, LR automatic fallback ---
{
	const { readFileSync } = await import("node:fs");
	const pd = ml.pickDecider;
	check("DECIDER defaults to gbm", ml.DECIDER === "gbm");
	const g = pd("gbm", 0.2, 0.8, 0.996, null);
	check("gbm decides when it scored", g.decider === "gbm" && g.p === 0.2 && g.tSure === 0.996, JSON.stringify(g));
	const f = pd("gbm", null, 0.8, 0.996, null);
	check("lr fallback when gbm null (guard failed / no score)", f.decider === "lr" && f.p === 0.8 && f.tSure === ml.T_SURE, JSON.stringify(f));
	check("lr fallback when gbm NaN", pd("gbm", NaN, 0.7, 0.996, null).decider === "lr");
	check("gbm without meta t_sure uses T_SURE", pd("gbm", 0.5, 0.8, null, null).tSure === ml.T_SURE);
	check("rule when no model p + rule", JSON.stringify(pd("gbm", null, null, 0.996, "mint_live")) === JSON.stringify({ p: null, tSure: ml.T_SURE, decider: "rule" }));
	check("base when no model p, no rule", pd("gbm", null, null, 0.996, null).decider === "base");
	const l = pd("lr", 0.2, 0.8, 0.996, null);
	check("DECIDER=lr ignores gbm (rollback switch)", l.decider === "lr" && l.p === 0.8 && l.tSure === ml.T_SURE, JSON.stringify(l));
	check("DECIDER=lr, no LR champion -> base (never gbm)", pd("lr", 0.2, null, 0.996, null).decider === "base");
	// a newly promoted LR champion only changes pLr: with gbm scoring it can't decide
	check("new LR champion can't take over while DECIDER=gbm", pd("gbm", 0.4, 0.999, 0.996, null).decider === "gbm" && pd("gbm", 0.4, 0.001, 0.996, null).p === 0.4);
	// red_sure threshold per decider
	const P = ml.policyV2;
	check("red_sure gbm: 0.995 < 0.996 is plain red", P(0.995, null, null, 0.996).tier === "red");
	check("red_sure gbm: 0.996 is red_sure", P(0.996, null, null, 0.996).tier === "red_sure");
	check("red_sure lr (default 0.99) unchanged", P(0.99, null, null).tier === "red_sure" && P(0.995, null, null, ml.T_SURE).tier === "red_sure");
	check("green / red bars shared", P(0.3, null, null, 0.996).tier === "green" && P(0.51, null, null, 0.996).choice === "red" && P(0.4, null, null, 0.996).tier === "yellow");
	// source guards: decider wired + written only on first-verdict INSERTs
	const src = readFileSync(path.join(HERE, "src", "index.ts"), "utf8");
	check("decideV2 routes through pickDecider(DECIDER, pGbm, pLr, GBM_T_SURE, rule)", /pickDecider\(DECIDER, pGbm, pLr, GBM_T_SURE, rule\)/.test(src) && /policyV2\(p, rule, jev, pick\.tSure\)/.test(src));
	const inserts = src.match(/INSERT OR REPLACE INTO verdicts \([^)]*\)/g) ?? [];
	check("every verdict INSERT stores decider", inserts.length >= 4 && inserts.every((q) => /gbm_v, decider\)/.test(q)), String(inserts.length));
	const updates = src.match(/UPDATE verdicts[^"`]*/g) ?? [];
	check("upgrade UPDATE never sets decider", updates.length > 0 && updates.every((u) => !/decider/.test(u)));
	check("schema.sql + migrate-v13 add verdicts.decider", /decider TEXT/.test(readFileSync(path.join(HERE, "schema.sql"), "utf8")) && /ALTER TABLE verdicts ADD COLUMN decider TEXT/.test(readFileSync(path.join(HERE, "migrate-v13.sql"), "utf8")));
	// placeholders == columns on every INSERT (decider added one each)
	const full = src.match(/INSERT OR REPLACE INTO verdicts \([^)]*\) VALUES \([^)]*\)/g) ?? [];
	check("verdict INSERT placeholder count == column count", full.length >= 4 && full.every((q) => {
		const [cols, vals] = q.match(/\(([^)]*)\)/g).map((x) => x.slice(1, -1).split(",").length);
		return cols === vals;
	}), String(full.length));
	// sqlite: decider column round-trips through a real insert, upgrade leaves it
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(":memory:");
		db.exec(readFileSync(path.join(HERE, "schema.sql"), "utf8"));
		db.prepare("INSERT INTO verdicts (mint, ts, choice, confidence, decider) VALUES ('m', 1, 'red', 0.9, 'gbm')").run();
		const up = updates[0].replace(/\?/g, "0").replace("WHERE mint = 0", "WHERE mint = 'm'");
		db.exec(up);
		check("upgrade UPDATE keeps decider (sqlite)", db.prepare("SELECT decider, choice FROM verdicts WHERE mint = 'm'").get().decider === "gbm");
	} catch (e) {
		check("SWITCH-001 sqlite check", false, String(e).slice(0, 200));
	}
}

// --- DATA-001: look-snapshot isolation (static) + dev/creator parsing ---
{
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(path.join(HERE, "src", "index.ts"), "utf8");
	// Every snapshot SELECT in index.ts must exclude look samples, except the
	// coin-detail chart (LIMIT 200, read-only display) and row counts.
	const sel = (src.match(/["`][^"`]*FROM snapshots[^"`]*["`]/g) ?? []).flatMap((q) => q.split("(SELECT").filter((x) => /FROM snapshots/.test(x)));
	const leaks = sel.filter((q) => !/look IS NULL/.test(q) && !/LIMIT 200/.test(q) && !/^\s*COUNT\(\*\) FROM snapshots\)/.test(q));
	check("index.ts: every snapshot selection filters look IS NULL (chart/count exempt)", sel.length >= 11 && leaks.length === 0, `${sel.length} ` + leaks.join(" | ").slice(0, 300));
	check("index.ts resolution uses the tested RESOLVE_* constants", /prepare\(\s*RESOLVE_FIRST_SQL/.test(src) && /prepare\(\s*RESOLVE_LAST_SQL/.test(src) && /prepare\(\s*RESOLVE_PRIOR_SQL/.test(src));
	check("resolution constants filter look IS NULL", [col.RESOLVE_FIRST_SQL, col.RESOLVE_LAST_SQL, col.RESOLVE_PRIOR_SQL].every((q) => /look IS NULL/.test(q)));
	const rsub = ml.RETRAIN_SQL_V2.split("(SELECT").filter((x) => /FROM snapshots/.test(x));
	check("RETRAIN_SQL_V2 first-snapshot features skip look rows", rsub.length === 8 && rsub.every((q) => /look IS NULL/.test(q)));
	const bf = readFileSync(path.join(HERE, "backfill-v9.sql"), "utf8").split("(SELECT").filter((x) => /FROM snapshots/.test(x));
	check("backfill-v9.sql snapshot selections skip look rows", bf.length === 4 && bf.every((q) => /look IS NULL/.test(q)));
	const dev = readFileSync(path.join(HERE, "src", "dev.ts"), "utf8");
	check("dev.ts never touches verdicts/outcomes/upgrade", !/maybeUpgrade|recordMint|INTO verdicts|UPDATE verdicts|INTO outcomes|UPDATE outcomes/.test(dev));
	check("look insert tags look and writes only snapshots", /^INSERT INTO snapshots \([^)]*, look\)/.test(col.LOOK_INSERT_SQL));

	check("oldestSig picks last (oldest) entry", JSON.stringify(col.oldestSig([{ signature: "new", blockTime: 3 }, { signature: "old", blockTime: 2 }])) === JSON.stringify({ sig: "old", ts: 2000 }));
	check("oldestSig full page -> unknown", col.oldestSig(new Array(1000).fill({ signature: "x" })).err === "sigs_ge_1000");
	check("oldestSig empty -> no_sigs", col.oldestSig([]).err === "no_sigs");
	// parseCreateTx: minimal jsonParsed pump.fun-style create+buy fixture
	const MINT = "Mint111pump", DEV = "Dev1111", OTHER = "Curve111";
	const tok = (idx, owner, ui) => ({ accountIndex: idx, mint: MINT, owner, uiTokenAmount: { uiAmount: ui, uiAmountString: String(ui), decimals: 6, amount: String(ui * 1e6) } });
	const fx = {
		blockTime: 1760000000, slot: 1,
		meta: {
			err: null, fee: 5000,
			preBalances: [3_000_000_000, 0, 0], postBalances: [1_975_000_000, 0, 0],
			preTokenBalances: [tok(2, OTHER, 0)],
			postTokenBalances: [tok(1, DEV, 35_000_000), tok(2, OTHER, 965_000_000), { accountIndex: 3, mint: "OtherMint", owner: DEV, uiTokenAmount: { uiAmountString: "999" } }],
		},
		transaction: { message: { accountKeys: [{ pubkey: DEV, signer: true, writable: true }, { pubkey: "Ata1", signer: false, writable: true }, { pubkey: OTHER, signer: false, writable: true }] } },
	};
	const f = col.parseCreateTx(fx, MINT);
	check("parseCreateTx creator = fee payer", f.creator === DEV, JSON.stringify(f));
	check("parseCreateTx dev buy tokens = post - pre for this mint only", f.devBuyTokens === 35_000_000);
	check("parseCreateTx dev SOL excludes fee", approx(f.devBuySol, 1.024995, 1e-12), String(f.devBuySol));
	check("parseCreateTx create ts in ms", f.createTs === 1760000000000);
	check("dev_share_initial = tokens / supply", col.shareOf(f.devBuyTokens, 1e9) === 0.035);
	check("parseCreateTx missing tx -> err", col.parseCreateTx(null, MINT).err === "tx_missing");
	check("parseCreateTx legacy string keys", col.parseCreateTx({ ...fx, transaction: { message: { accountKeys: [DEV] } } }, MINT).creator === DEV);
	check("ownerBalance sums token accounts", col.ownerBalance({ value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: "10.5" } } } } } }, { account: { data: { parsed: { info: { tokenAmount: { uiAmountString: "4.5" } } } } } }] }) === 15);
	check("ownerBalance empty -> 0, malformed -> null", col.ownerBalance({ value: [] }) === 0 && col.ownerBalance(null) === null);
	check("shareOf guards zero supply", col.shareOf(5, 0) === null && col.shareOf(null, 10) === null);
	check("look windows +15/+30 min, 30 per batch", col.LOOKS.map((w) => w.look).join() === "15,30" && col.LOOK_BATCH === 30 && /LIMIT 30$/.test(col.LOOK_PICK_SQL));

	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(":memory:");
		db.exec(readFileSync(path.join(HERE, "schema.sql"), "utf8"));
		const NOW = 10_000_000;
		const addR = db.prepare("INSERT INTO rounds (mint, first_seen) VALUES (?, ?)");
		const addD = db.prepare("INSERT INTO dev_signals (mint, creator, fetched_at) VALUES (?, ?, ?)");
		const addO = db.prepare("INSERT INTO outcomes (mint, resolved_at, dead, dead_v2) VALUES (?, ?, 0, ?)");
		for (const [m, fs, cr] of [["a", 100, "C"], ["b", 200, "C"], ["c", 300, "C"], ["x", 150, "Z"], ["later", 900, "C"], ["me", 500, "C"]]) { addR.run(m, fs); addD.run(m, cr, fs); }
		addO.run("a", 1000, 1); addO.run("b", 2000, 0); addO.run("c", NOW + 5, 1); addO.run("later", 1500, 1);
		const h = db.prepare(col.CREATOR_HISTORY_SQL).get(NOW, "C", "me", 500);
		check("creator history: strictly prior coins, future outcomes not counted", h.n === 3 && h.graded === 2 && h.dead === 1, JSON.stringify(h));
		const addS = db.prepare("INSERT INTO snapshots (mint, ts, price_usd, look) VALUES (?, ?, 1, ?)");
		const T = 50_000_000;
		addR.run("w1", T - 15 * 60e3); addR.run("w2", T - 15 * 60e3); addR.run("old", T - 20 * 60e3);
		addS.run("w2", T - 60e3, 15); addS.run("w1", T - 60e3, null);
		const [fr, to] = col.lookWindow(T, col.LOOKS[0]);
		const picked = db.prepare(col.LOOK_PICK_SQL).all(fr, to, 15).map((r) => r.mint);
		check("look pick: in-window coins without that look only", picked.join() === "w1", picked.join());
		addR.run("fresh1", T - 2 * 60e3); addR.run("zzpump", T - 60e3); addR.run("done1", T - 60e3); addD.run("done1", "Q", T);
		const dp = db.prepare(col.DEV_PICK_SQL).all(T - col.DEV_WINDOW_MS, T - col.DEV_RETRY_AFTER_MS, T - col.DEV_RETRY_WINDOW_MS, 10).map((r) => r.mint);
		check("dev pick: first-sight window, no dev row yet, pump-style first", dp.join() === "zzpump,fresh1", dp.join());
	} catch (e) {
		check("DATA-001 sqlite checks", false, String(e).slice(0, 200));
	}
}

// --- dev collector: concurrency pool + stop on 429 ---
{
	check("DEV_CONCURRENCY is 1 (sequential), DEV_PER_RUN is 3", col.DEV_CONCURRENCY === 1 && col.DEV_PER_RUN === 3);
	check("isRateLimited: solami 429 / rate limit yes, 500 / timeout no",
		col.isRateLimited(new Error("solami 429")) && col.isRateLimited("Too Many Requests") && !col.isRateLimited(new Error("solami 500")) && !col.isRateLimited(new Error("TimeoutError")));
	let inflight = 0, peak = 0;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const p1 = await col.runPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (x) => { inflight++; peak = Math.max(peak, inflight); await sleep(5); inflight--; return x * 2; });
	check("runPool: all 10 run, <= 3 in flight, order kept", p1.started === 10 && p1.skipped === 0 && peak <= 3 && peak > 1 && p1.results.join() === "2,4,6,8,10,12,14,16,18,20", `${peak} ${p1.results.join()}`);
	let stop = false;
	const p2 = await col.runPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (x) => { await sleep(2); if (x === 1) stop = true; return x; }, () => stop);
	check("runPool: stop() halts new starts (429 path)", p2.started === 3 && p2.skipped === 7 && p2.results.slice(3).every((r) => r === undefined), `${p2.started} ${p2.skipped}`);
	const dev = (await import("node:fs")).readFileSync(path.join(HERE, "src", "dev.ts"), "utf8");
	check("collectDev uses runPool(DEV_CONCURRENCY) + 429 stop, no unbounded Promise.all over picks", /runPool\(picks, DEV_CONCURRENCY/.test(dev) && /isRateLimited\(e\)/.test(dev) && !/Promise\.all\(picks/.test(dev));
	const idx = (await import("node:fs")).readFileSync(path.join(HERE, "src", "index.ts"), "utf8");
	check("solamiRpc has an 8s AbortSignal.timeout", /async function solamiRpc[\s\S]{0,600}AbortSignal\.timeout\(8000\)/.test(idx));
}

// FIX-003: tx v1, sequential + 429 backoff, transient retries
{
	const { readFileSync } = await import("node:fs");
	const MINT = "Mint111pump", DEV = "Dev1111";
	const meta = {
		fee: 5000, preBalances: [2_000_000_000, 0, 0], postBalances: [974_995_000 + 1, 0, 0],
		preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: DEV, uiTokenAmount: { uiAmountString: "35000000" } }],
	};
	// v1 (SIMD-0385): inline keys, message.transactionConfig, version: 1.
	const v1 = { blockTime: 1760000000, version: 1, meta, transaction: { message: {
		accountKeys: [{ pubkey: DEV, signer: true, writable: true, source: "transaction" }, { pubkey: "Ata1", signer: false, writable: true, source: "transaction" }, { pubkey: "Curve1", signer: false, writable: true, source: "transaction" }],
		instructions: [], recentBlockhash: "x", transactionConfig: { computeUnitLimit: 30000, heapSize: null, loadedAccountsDataSizeLimit: 200000, priorityFee: null } } } };
	const f1 = col.parseCreateTx(v1, MINT);
	check("parseCreateTx v1 shape: creator = fee payer, buy parsed", f1.creator === DEV && f1.devBuyTokens === 35_000_000 && f1.createTs === 1760000000000, JSON.stringify(f1));
	// v0: static keys first, lookup-table keys appended (never signers).
	const v0 = { ...v1, version: 0, transaction: { message: { accountKeys: [{ pubkey: DEV, signer: true, writable: true, source: "transaction" }, { pubkey: "Ata1", signer: false, writable: true, source: "transaction" }, { pubkey: "Alt1", signer: false, writable: true, source: "lookupTable" }] } } };
	check("parseCreateTx v0 with loaded addresses: creator = first signer", col.parseCreateTx(v0, MINT).creator === DEV);
	const odd = { ...v1, meta: { ...meta, preBalances: [0, 3_000_000_000], postBalances: [0, 1_999_995_000] }, transaction: { message: { accountKeys: [{ pubkey: "NotSigner", signer: false }, { pubkey: DEV, signer: true }] } } };
	const fo = col.parseCreateTx(odd, MINT);
	check("parseCreateTx: first signer wins, lamports read at its index", fo.creator === DEV && approx(fo.devBuySol, 1.0, 1e-12), JSON.stringify(fo));
	check("DEV_TX_MAX_VERSION is the integer 1", col.DEV_TX_MAX_VERSION === 1);
	const e32015 = new Error('solami {"code":-32015,"message":"Transaction version (2) is not supported by the requesting client. Please try the request again with the following configuration parameter: \\"maxSupportedTransactionVersion\\": 2"}');
	check("txVersionFromErr parses -32015", col.txVersionFromErr(e32015) === 2 && col.txVersionFromErr(new Error("solami 429")) === null);
	const seen = [];
	const fake = async (m, p) => { seen.push(p[1].maxSupportedTransactionVersion); if (p[1].maxSupportedTransactionVersion < 2) throw e32015; return { ok: 1 }; };
	const got = await col.getTxAnyVersion(fake, "sig1");
	check("getTxAnyVersion: asks v1 first, retries once with the version -32015 names", got.ok === 1 && seen.join() === "1,2", seen.join());
	const seen2 = [];
	let threw = "";
	try { await col.getTxAnyVersion(async () => { seen2.push(1); throw new Error("solami 429"); }, "s"); } catch (e) { threw = String(e); }
	check("getTxAnyVersion: non -32015 errors are not retried", seen2.length === 1 && /429/.test(threw));

	const errs = ["solami 429", "solami dev_stopped_429", "owner_Error: solami 429", "no_supply", "supply_Error: solami 429",
		'solami {"code":-32015,"message":"Transaction version (1) is not supported"}', "TimeoutError: The operation was aborted due to timeout",
		"sigs_gt_5000", "tx_no_payer", "no_sigs", null];
	check("isTransientDevErr: 429/timeout/-32015/no_supply yes, sigs_gt_5000/tx_no_payer/no_sigs/null no",
		errs.map((e) => (col.isTransientDevErr(e) ? 1 : 0)).join("") === "11111110000");
	const NOW = 100_000_000;
	const R = col.DEV_RETRY_AFTER_MS;
	check("devRetryEligible: transient + >= 30 min old + < 3 attempts",
		col.devRetryEligible({ err: "solami 429", fetched_at: NOW - R, attempts: 1 }, NOW)
		&& col.devRetryEligible({ err: "no_supply", fetched_at: NOW - R - 1, attempts: null }, NOW)
		&& !col.devRetryEligible({ err: "solami 429", fetched_at: NOW - R + 1, attempts: 1 }, NOW)
		&& !col.devRetryEligible({ err: "solami 429", fetched_at: NOW - R, attempts: 3 }, NOW)
		&& !col.devRetryEligible({ err: "sigs_gt_5000", fetched_at: NOW - 10 * R, attempts: 1 }, NOW));
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(":memory:");
		db.exec(readFileSync(path.join(HERE, "schema.sql"), "utf8"));
		// SQL clause agrees with isTransientDevErr on every sample.
		db.exec("CREATE TABLE t (err TEXT)");
		const ins = db.prepare("INSERT INTO t (err) VALUES (?)");
		for (const e of errs) ins.run(e);
		const sqlFlags = db.prepare("SELECT CASE WHEN " + col.DEV_TRANSIENT_SQL.replaceAll("d.err", "err") + " THEN 1 ELSE 0 END AS f FROM t ORDER BY rowid").all().map((r) => r.f).join("");
		check("DEV_TRANSIENT_SQL agrees with isTransientDevErr", sqlFlags === "11111110000", sqlFlags);
		const addR = db.prepare("INSERT INTO rounds (mint, first_seen) VALUES (?, ?)");
		const addD = db.prepare("INSERT INTO dev_signals (mint, err, fetched_at, attempts) VALUES (?, ?, ?, ?)");
		const T = 500_000_000;
		addR.run("new1", T - 60e3);
		addR.run("r429", T - 60 * 60e3); addD.run("r429", "solami 429", T - R - 1, 1);
		addR.run("rsup", T - 50 * 60e3); addD.run("rsup", "no_supply", T - R - 1, null);
		addR.run("rtoo_soon", T - 40 * 60e3); addD.run("rtoo_soon", "solami 429", T - R + 60e3, 1);
		addR.run("rmax", T - 90 * 60e3); addD.run("rmax", "solami 429", T - R - 1, 3);
		addR.run("rperm", T - 60 * 60e3); addD.run("rperm", "sigs_gt_5000", T - R - 1, 1);
		addR.run("rold", T - 5 * 3600e3); addD.run("rold", "solami 429", T - R - 1, 1);
		addR.run("rok", T - 60 * 60e3); addD.run("rok", null, T - R - 1, 1);
		const pk = db.prepare(col.DEV_PICK_SQL).all(T - col.DEV_WINDOW_MS, T - R, T - col.DEV_RETRY_WINDOW_MS, 10);
		const pks = pk.map((r) => r.mint + ":" + r.attempts).join();
		check("dev pick: new coins first, then transient retries (30 min, < 3 tries, 3h window), never permanent/ok", pks === "new1:0,r429:1,rsup:1", pks);
		const lim = db.prepare(col.DEV_PICK_SQL).all(T - col.DEV_WINDOW_MS, T - R, T - col.DEV_RETRY_WINDOW_MS, col.DEV_PER_RUN);
		check("dev pick: at most DEV_PER_RUN (3) mints", lim.length <= 3);
		const bo = (now) => db.prepare(col.DEV_BACKOFF_SQL).get(now - col.DEV_BACKOFF_MS).n;
		check("backoff: no 429 in last 5 min -> 0", bo(T) === 0);
		addR.run("hot", T - 60e3); addD.run("hot", "owner_Error: solami 429", T - 60e3, 1);
		check("backoff: a 429 row in last 5 min -> skip", bo(T) === 1 && bo(T + col.DEV_BACKOFF_MS + 60e3) === 0);
		db.prepare(col.DEV_UPSERT_SQL).run("r429", "C", null, null, null, null, null, null, 0, 0, 0, null, T, 2);
		check("upsert stores attempts", db.prepare("SELECT attempts FROM dev_signals WHERE mint = 'r429'").get().attempts === 2);
	} catch (e) {
		check("FIX-003 sqlite checks", false, String(e).slice(0, 200));
	}
	const devSrc = readFileSync(path.join(HERE, "src", "dev.ts"), "utf8");
	check("collectDev: backoff query before any RPC, getTxAnyVersion, sequential supply (no swallowed catch)",
		/DEV_BACKOFF_SQL[\s\S]*runPool\(picks, DEV_CONCURRENCY/.test(devSrc) && /getTxAnyVersion\(rpc/.test(devSrc) && !/getTokenSupply", \[mint\]\)\.catch/.test(devSrc) && !/maxSupportedTransactionVersion: 0/.test(devSrc));
	const idxSrc = readFileSync(path.join(HERE, "src", "index.ts"), "utf8");
	const ing = idxSrc.slice(idxSrc.indexOf("async function ingest("));
	check("collectDev runs after intake signals (recordMint loops) in ingest()", ing.indexOf("collectDev(") > ing.lastIndexOf("recordMint(env, prow.mint"));
}

// --- LIVE-001: real-time push (Durable Object LiveFeed) ---
{
	const { readFileSync } = await import("node:fs");
	// event builder: shape, dedupe, caps, null when nothing changed
	const row = (i, extra = {}) => ({ mint: "M" + i, first_seen: 1, name: "n" + i, choice: "yellow", confidence: 0.5, mult: null, dead: null, tier: "yellow", policy_v: 2, dead_v2: null, last_price: 0.001, last_liq: 5000, top1: 12, resolved_at: null, ...extra });
	check("tick: nothing changed -> null", lc.buildTickEvent({ ts: 1, rows: [], total: 5 }) === null);
	const e1 = lc.buildTickEvent({ ts: 1700000000000, rows: [row(1), row(2), row(1)], total: 42 });
	check("tick: shape {type,ts,rounds,total}, no proof key when absent", e1 && e1.type === "tick" && e1.ts === 1700000000000 && e1.total === 42 && e1.rounds.length === 2 && !("proof" in e1), JSON.stringify(e1).slice(0, 200));
	check("tick: rows keep the /api/rounds shape untouched", JSON.stringify(e1.rounds[0]) === JSON.stringify(row(1)));
	const many = Array.from({ length: 200 }, (_, i) => row(i));
	const e2 = lc.buildTickEvent({ ts: 1, rows: many, total: 1 });
	check("tick: row cap = TICK_MAX_ROWS (60)", lc.TICK_MAX_ROWS === 60 && e2.rounds.length === 60);
	check("tick: under 32 KB byte cap", lc.TICK_MAX_BYTES === 32 * 1024 && JSON.stringify(e2).length <= lc.TICK_MAX_BYTES);
	const fat = Array.from({ length: 60 }, (_, i) => row(i, { name: "x".repeat(2000) }));
	const e3 = lc.buildTickEvent({ ts: 1, rows: fat, total: 1 });
	check("tick: oversized rows trimmed from the tail to fit", e3 && e3.rounds.length < 60 && e3.rounds.length > 0 && JSON.stringify(e3).length <= lc.TICK_MAX_BYTES, String(e3 && e3.rounds.length));
	const full = { resolved_with_verdict: 9, correct: 5, accuracy: 0.55, red_precision: 0.7, label: "v2", label_def: { text_en: "x" }, headline: { n: 3, ready: false }, v2_history_regrade: { n: 1 }, legacy_v1: { accuracy: 0.5 }, challenger: { n: 0 }, decider: { model: "lightgbm-27" }, by_rule: [1, 2, 3], conf_deciles: new Array(10).fill({}), brier: 0.1 };
	const ps = lc.proofSummaryOf(full);
	check("proof summary: keeps headline/legacy/challenger/decider + top line, drops heavy panels",
		ps.headline && ps.legacy_v1 && ps.challenger && ps.decider && ps.accuracy === 0.55 && ps.resolved_with_verdict === 9 && !("by_rule" in ps) && !("conf_deciles" in ps) && !("brier" in ps));
	const e4 = lc.buildTickEvent({ ts: 1, rows: [], total: 7, proof: ps });
	check("tick: proof-only tick allowed (outcomes resolved, no visible rows)", e4 && e4.rounds.length === 0 && e4.proof && e4.proof.headline.n === 3);
	// touched-coin collector: important changes first
	const tset = new lc.TouchSet();
	tset.add("a", 1); tset.add("b", 0); tset.add("c", 1); tset.add("a", 0); tset.add("b", 1);
	check("TouchSet: prio-0 first, no dupes, downgrade ignored", JSON.stringify(tset.pick(10)) === JSON.stringify(["b", "a", "c"]) && tset.size === 3 && tset.pick(1).length === 1);
	// origin gate
	check("origin: absent allowed (non-browser)", lc.originAllowed(null, "flag.sornkan.com") && lc.originAllowed("", "flag.sornkan.com"));
	check("origin: flag.sornkan.com + workers.dev allowed (https)", lc.originAllowed("https://flag.sornkan.com", "flag.sornkan.com") && lc.originAllowed("https://radar-worker-api.sornkan.workers.dev", "x"));
	check("origin: cross-site / http / lookalike rejected",
		!lc.originAllowed("https://evil.example", "flag.sornkan.com") && !lc.originAllowed("http://flag.sornkan.com", "flag.sornkan.com") &&
		!lc.originAllowed("https://flag.sornkan.com.evil.io", "flag.sornkan.com") && !lc.originAllowed("https://xflag.sornkan.com", "flag.sornkan.com") &&
		!lc.originAllowed("null", "flag.sornkan.com") && !lc.originAllowed("https://flag.sornkan.com:8443", "flag.sornkan.com"));
	check("origin: localhost only when the request is local (wrangler dev)", lc.originAllowed("http://localhost:8787", "localhost:8787") && !lc.originAllowed("http://localhost:8787", "flag.sornkan.com"));
	// monthly budget kill-switch
	const T0 = Date.UTC(2026, 9, 15, 12);
	check("budget: month key UTC", lc.monthKey(T0) === "2026-10" && lc.monthKey(Date.UTC(2026, 11, 31, 23, 59)) === "2026-12");
	let b = lc.budgetAdd(null, T0, lc.LIVE_COST.upgrade);
	b = lc.budgetAdd(b, T0, lc.LIVE_COST.broadcast);
	b = lc.budgetAdd(b, T0, lc.LIVE_COST.clientMsg);
	check("budget: units = upgrade 60 (pre-pays close+error) + broadcast 20 + client frame 1 (1/20 request)", b.units === 81 && b.month === "2026-10" && lc.LIVE_UNITS_PER_REQUEST === 20 && lc.LIVE_COST.upgrade === 3 * lc.LIVE_UNITS_PER_REQUEST);
	check("budget: under line not over", !lc.budgetOver(b, T0));
	const atLine = { month: "2026-10", units: lc.LIVE_MONTH_BUDGET_UNITS };
	check("budget: line = 800,000 requests; over only past it", lc.LIVE_MONTH_BUDGET_REQ === 800000 && !lc.budgetOver(atLine, T0) && lc.budgetOver(lc.budgetAdd(atLine, T0, 1), T0));
	const nextMonth = Date.UTC(2026, 10, 1, 0, 0, 1);
	check("budget: new UTC month resets", !lc.budgetOver(lc.budgetAdd(atLine, T0, 99), nextMonth) && lc.budgetAdd({ month: "2026-10", units: 5e9 }, nextMonth, 20).units === 20);
	check("budget: worker stash over only for THIS month's row", lc.stashOver({ month: "2026-10", over: 1 }, T0) && !lc.stashOver({ month: "2026-09", over: 1 }, T0) && !lc.stashOver({ month: "2026-10", over: 0 }, T0) && !lc.stashOver(null, T0));
	check("caps: 300 sockets total, 3 per IP, refusal close 4429, ping/pong", lc.LIVE_MAX_SOCKETS === 300 && lc.LIVE_MAX_PER_IP === 3 && lc.LIVE_CLOSE_REFUSED === 4429 && lc.LIVE_PING === "ping" && lc.LIVE_PONG === "pong");

	// source guards: only /api/live reaches DO_LIVE, only for upgrades; broadcast has no HTTP path
	const idx = readFileSync(path.join(HERE, "src", "index.ts"), "utf8");
	const live = readFileSync(path.join(HERE, "src", "live.ts"), "utf8");
	const doUses = idx.match(/env\.DO_LIVE\b/g) || [];
	check("DO_LIVE referenced only inside liveStub()", doUses.length === 2 && /function liveStub\(env: Env\)[^{]*\{\s*return env\.DO_LIVE\.get\(env\.DO_LIVE\.idFromName\("global"\)\);\s*\}/.test(idx));
	const stubCalls = idx.match(/liveStub\(env\)\.(\w+)\(/g) || [];
	check("stub used only for .fetch (in liveUpgrade) and .broadcast (in pushTick)", stubCalls.length === 2 && stubCalls.includes("liveStub(env).fetch(") && stubCalls.includes("liveStub(env).broadcast("));
	const up = idx.slice(idx.indexOf("async function liveUpgrade("), idx.indexOf("// Shared by /api/proof"));
	const iFetch = up.indexOf("liveStub(env).fetch(");
	check("liveUpgrade: kill flag, upgrade, origin, client-ip, budget checks all BEFORE the DO", iFetch > 0 &&
		["liveEnabled(env)", '"websocket"', "originAllowed(", "CF-Connecting-IP", "stashOver("].every((k) => up.indexOf(k) >= 0 && up.indexOf(k) < iFetch) && /status: 426/.test(up) && /status: 503/.test(up));
	check("route: only /api/live dispatches to liveUpgrade", (idx.match(/liveUpgrade\(request, env\)/g) || []).length === 1 && /url\.pathname === "\/api\/live"\) return liveUpgrade\(request, env\)/.test(idx));
	const pt = idx.slice(idx.indexOf("async function pushTick("), idx.indexOf("async function liveUpgrade("));
	check("pushTick: disabled / over budget checked before the RPC, never throws", pt.indexOf("liveEnabled(env)") < pt.indexOf(".broadcast(") && pt.indexOf("stashOver(") < pt.indexOf(".broadcast(") && /catch \(e\)/.test(pt));
	check("scheduled: ONE pushTick per minutely run, after ingest", (idx.match(/await pushTick\(/g) || []).length === 1 && idx.indexOf("await pushTick(") > idx.indexOf("const stats = await ingest(env);"));
	check("/api/rounds + tick share ROUND_COLS/ROUND_FROM (no SQL drift)", (idx.match(/\$\{ROUND_COLS\}/g) || []).length === 2 && !/SELECT r\.mint, r\.first_seen, r\.name, v\.choice/.test(idx.slice(idx.indexOf("export default {"))));
	check("/api/proof + tick share proofCore()", (idx.match(/await proofCore\(env\)/g) || []).length === 2);
	check("LiveFeed: hibernation accept, NO auto-response (every frame counted), no ws.accept on viewers, no fetch path to broadcast",
		/this\.ctx\.acceptWebSocket\(server, \[tag\]\)/.test(live) && /ctx\.setWebSocketAutoResponse\(\);/.test(live) && !/new WebSocketRequestResponsePair/.test(live) &&
		(live.match(/server\.accept\(\)/g) || []).length === 1 && /private refuse\(/.test(live) && /async broadcast\(msg: string\)/.test(live) &&
		!/broadcast/.test(live.slice(live.indexOf("async fetch("), live.indexOf("async broadcast("))));
	check("LiveFeed: non-ping client frame closes 1008; caps via getWebSockets(tag)", /ws\.close\(1008/.test(live) && /getWebSockets\(tag\)\.length >= LIVE_MAX_PER_IP/.test(live) && /getWebSockets\(\)\.length >= LIVE_MAX_SOCKETS/.test(live));
	const wr = readFileSync(path.join(HERE, "wrangler.jsonc"), "utf8");
	check("wrangler: DO_LIVE -> LiveFeed + v1-livefeed sqlite migration", /"name": "DO_LIVE", "class_name": "LiveFeed"/.test(wr) && /"tag": "v1-livefeed", "new_sqlite_classes": \["LiveFeed"\]/.test(wr));
	check("worker entry exports LiveFeed", /export \{ LiveFeed \};/.test(idx));

	// frontend client: upsert helper, backoff, polling only as fallback
	const vm = await import("node:vm");
	const ctx = { Math, JSON, Date, Array, Object, setTimeout, clearTimeout, setInterval, clearInterval };
	ctx.globalThis = ctx;
	vm.createContext(ctx);
	vm.runInContext(readFileSync(path.join(HERE, "public", "live.js"), "utf8"), ctx);
	const FL = ctx.FlagLive;
	const list = [{ mint: "A", v: 1 }, { mint: "B", v: 1 }];
	const u = FL.upsertRows(list, [{ mint: "B", v: 2 }, { mint: "N1", v: 1 }, { mint: "N2", v: 1 }, { mint: "N1", v: 9 }, { v: 0 }, null]);
	check("live.js upsert: replaces in place, new on top in tick order, dedupes, skips junk",
		list.map((x) => x.mint).join(",") === "N1,N2,A,B" && list[3].v === 2 && list[0].v === 1 && u.added === 2 && u.changed.join(",") === "B,N1,N2", list.map((x) => x.mint).join(","));
	const win = [{ mint: "X", first_seen: 100 }, { mint: "Y", first_seen: 50 }];
	const uw = FL.upsertRows(win, [{ mint: "OLD", first_seen: 10 }, { mint: "NEW", first_seen: 200 }, { mint: "Y", first_seen: 50, v: 3 }], FL.inWindow(win, false));
	win.sort(FL.byNewest);
	check("live.js window gate: old coins outside the loaded page are not injected; new ones sorted newest-first",
		win.map((x) => x.mint).join(",") === "NEW,X,Y" && uw.added === 1 && uw.changed.join(",") === "NEW,Y" && win[2].v === 3, win.map((x) => x.mint).join(","));
	const mp = FL.mergeProof({ by_rule: [1], accuracy: 0.1 }, { accuracy: 0.2, headline: { n: 1 } });
	check("live.js mergeProof keeps heavy fields, overwrites live ones", mp.by_rule.length === 1 && mp.accuracy === 0.2 && mp.headline.n === 1);
	check("live.js backoff: grows, jittered, capped at 30s", FL.backoff(0, 1) === 1000 && FL.backoff(3, 1) === 8000 && FL.backoff(20, 1) === 30000 && FL.backoff(20, 0) === 15000);
	check("live.js: watchdog 150s (= LIVE_WATCHDOG_MS), poll 60s fallback, slow retry >= 5 min, 3 fails, refusal 4429", FL.WATCHDOG_MS === 150000 && FL.WATCHDOG_MS === lc.LIVE_WATCHDOG_MS && !("PING_MS" in FL) && FL.POLL_MS === 60000 && FL.SLOW_MS >= 300000 && FL.MAX_FAILS === 3 && FL.REFUSED === 4429);
	check("live.js status text TH/EN", FL.statusText("live", "en") === "live" && FL.statusText("polling", "th") === "อัปเดตทุกนาที" && FL.statusText("reconnecting", "en") === "reconnecting…");
	const ljs = readFileSync(path.join(HERE, "public", "live.js"), "utf8");
	check("live.js sends NOTHING (no ping, no .send at all); watchdog re-armed on every frame", !/\.send\(/.test(ljs) && !/"ping"/.test(ljs) && /sock\.onmessage=function\(ev\)\{lastMsg=Date\.now\(\);arm\(\);/.test(ljs) && /WATCHDOG_MS\)\}/.test(ljs));
	// server heartbeat + idle skip
	const hb = lc.heartbeatEvent(1234.9);
	check("heartbeat frame is tiny {type:hb,ts}", hb.type === "hb" && hb.ts === 1234 && JSON.stringify(hb).length < 40 && JSON.stringify(hb).startsWith('{"type":"hb"'));
	const NOW = 10_000_000;
	check("shouldBroadcast: no stash yet -> broadcast", lc.shouldBroadcast(null, NOW) === true);
	check("shouldBroadcast: sockets > 0 -> broadcast", lc.shouldBroadcast({ sockets: 2, last_connect: 0 }, NOW) === true);
	check("shouldBroadcast: 0 sockets + recent connect (<5 min) -> broadcast", lc.shouldBroadcast({ sockets: 0, last_connect: NOW - 60_000 }, NOW) === true);
	check("shouldBroadcast: 0 sockets + connect older than 5 min / never -> SKIP", lc.shouldBroadcast({ sockets: 0, last_connect: NOW - 6 * 60_000 }, NOW) === false && lc.shouldBroadcast({ sockets: 0, last_connect: null }, NOW) === false && lc.LIVE_IDLE_SKIP_MS === 300000);
	check("pushTick: idle gate + heartbeat fallback before the single RPC", pt.indexOf("shouldBroadcast(") > 0 && pt.indexOf("shouldBroadcast(") < pt.indexOf(".broadcast(") && /evt \?\? heartbeatEvent\(/.test(pt) && (pt.match(/\.broadcast\(/g) || []).length === 1 && !/touched\.size === 0 && resolved === 0\) return/.test(pt));
	check("liveUpgrade: stamps last_connect on 101, flips stash on DO 'budget'", /res\.status === 101\) \{\s*try \{ await liveStampConnect\(env\)/.test(up) && /liveStampOver\(env\)/.test(up));
	check("LiveFeed: every client frame counted BEFORE ping/close handling; heartbeats not stored for replay; stale replay suppressed",
		/webSocketMessage[\s\S]{0,200}this\.spend\(LIVE_COST\.clientMsg\)[\s\S]{0,200}LIVE_PING/.test(live) && /startsWith\('\{"type":"hb"'\)/.test(live) && /LIVE_REPLAY_MAX_AGE_MS/.test(live));
	// fail-closed gate + in-isolate trip + close/error pre-pay
	check("monthEndMs: first ms of next UTC month", lc.monthEndMs(Date.UTC(2026, 9, 15, 12)) === Date.UTC(2026, 10, 1) && lc.monthEndMs(Date.UTC(2026, 11, 31, 23, 59)) === Date.UTC(2027, 0, 1));
	check("isNoTableError: only 'no such table' is treated as safe", lc.isNoTableError(new Error("D1_ERROR: no such table: live_state: SQLITE_ERROR")) && !lc.isNoTableError(new Error("D1_ERROR: Network connection lost")) && !lc.isNoTableError(new Error("timeout")) && !lc.isNoTableError(undefined));
	const tryFn = idx.slice(idx.indexOf("async function liveStashTry("), idx.indexOf("async function liveStashRead("));
	check("liveStashTry: errors return ok:false and are NOT memoized (except no-such-table)", /return \{ ok: false/.test(tryFn) && /isNoTableError\(e\)/.test(tryFn) && (tryFn.match(/liveStashMemo = /g) || []).length === 2 && tryFn.indexOf("return { ok: false") > tryFn.lastIndexOf("liveStashMemo = "));
	const iOver = up.indexOf("Date.now() < liveOverUntil"), iTry = up.indexOf("liveStashTry(env, LIVE_STASH_CACHE_MS)"), iClosed = up.indexOf("if (!sr.ok) return new Response("), iDo = up.indexOf("liveStub(env).fetch(");
	check("liveUpgrade order: overUntil -> cached stash (<=10s) -> fail closed 503 on error -> DO", iOver > 0 && iOver < iTry && iTry < iClosed && iClosed < iDo && /LIVE_STASH_CACHE_MS = 10_000/.test(idx) && /status: 503, headers: \{ "X-Live-State": "unknown" \}/.test(up));
	check("liveUpgrade: DO 'budget' trips overUntil BEFORE the D1 stamp, returns 503 even if the stamp fails",
		/X-Live-State"\) === "budget"\) \{\s*liveTrip\(Date\.now\(\)\);[^\n]*\n\s*try \{ await liveStampOver\(env\); \} catch/.test(up) && /return budgetRes\(\);\s*\}\s*if \(res\.status === 101\)/.test(up));
	check("pushTick: overUntil short-circuit, fail closed on stash error, trips on broadcast over", pt.indexOf("liveOverUntil") < pt.indexOf("liveStashTry(") && /if \(!sr\.ok\) return;/.test(pt) && /if \(st\.over\) liveTrip/.test(pt));
	check("LiveFeed.spend stops writing storage once over (bounded row writes); close/error carry no extra spend",
		/if \(!wasOver\) await this\.ctx\.storage\.put\(K_BUDGET/.test(live) && !/webSocketClose[\s\S]{0,300}spend\(/.test(live) && !/webSocketError[\s\S]{0,200}spend\(/.test(live));
	check("storage writes worst case 16,000,000 + 44,640 x 3 = 16,133,920 < 50M (documented)", lc.LIVE_MONTH_BUDGET_UNITS + 44640 * 3 === 16133920 && 16133920 < 50_000_000 && /16,133,920 < 50,000,000/.test(readFileSync(path.join(HERE, "src", "live-core.ts"), "utf8")));
	check("worst case (documented in live-core): 800k + 44,640 broadcasts < 1M req; 31d x 86400 x 0.125 = 334,800 GB-s < 400k",
		lc.LIVE_MONTH_BUDGET_REQ + 31 * 1440 === 844640 && 844640 < 1_000_000 && 31 * 86400 * 0.125 === 334800 && 334800 < 400000 &&
		/total <= 800,000 \+ 44,640 = 844,640 < 1,000,000/.test(readFileSync(path.join(HERE, "src", "live-core.ts"), "utf8")));
	for (const pg of ["board.html", "index.html", "proof.html"]) {
		const h = readFileSync(path.join(HERE, "public", pg), "utf8");
		check(pg + ": loads /live.js, connects, no 60s setInterval polling", /<script src="\/live\.js"><\/script>/.test(h) && /FlagLive\.connect\(\{onTick:onTick/.test(h) && !/setInterval\(load\w*,\s*60000\)/.test(h));
	}
}

// FINAL-WEB: tie-aware ranking (display-only)
{
	// 10 coins, distinct scores, survivors at the 2 safest -> top 10% = 1 coin alive
	const g = [];
	for (let i = 0; i < 10; i++) g.push({ p: i / 10, n: 1, alive: i < 2 ? 1 : 0 });
	const s = rk.rankingStats(g, [0.1, 0.2]);
	check("ranking: base 2/10, top10% survival 1, lift 5", s.n === 10 && approx(s.survival, 0.2) && approx(s.top[0].survival, 1) && approx(s.top[0].lift, 5) && s.top[0].tie_share === 0);
	check("ranking: perfect order AUC 1", approx(s.auc, 1));
	// one big tie: order must NOT create skill (pro rata, tie_share 1, lift 1, AUC 0.5)
	const t = rk.rankingStats([{ p: 0, n: 100, alive: 10 }, { p: 0.5, n: 100, alive: 10 }], [0.1]);
	check("ranking: tied group taken pro rata (no row-order skill)", approx(t.top[0].survival, 0.1) && approx(t.top[0].lift, 1) && approx(t.top[0].tie_share, 1) && approx(t.auc, 0.5));
	const d = t.deciles.map((x) => x.survival);
	check("ranking: deciles tie-aware and complete", d.length === 10 && d.every((v) => approx(v, 0.1)));
	check("ranking: ready gate needs n>=200 and >=10 survivors", t.ready === true && rk.rankingStats([{ p: 0, n: 300, alive: 9 }]).ready === false && rk.rankingStats([{ p: 0, n: 150, alive: 50 }]).ready === false);
	check("ranking: empty / junk groups", rk.rankingStats([]).n === 0 && rk.rankingStats([{ p: NaN, n: 3, alive: 1 }, { p: 0.2, n: 2, alive: 5 }]).n === 0);
	const w = rk.wilson(10, 100);
	check("wilson 10/100 = [0.0552, 0.1744]", approx(w[0], 0.0552, 5e-4) && approx(w[1], 0.1744, 5e-4));
}

// INGEST-STALL (12 Oct): Cloudflare fires the minutely cron ~0.6s BEFORE the
// minute (scheduledTime itself reads :59), so the full-round gate must key on
// the trigger minute (scheduledTime rounded), not the wall-clock minute.
{
	try {
		execSync(`"${process.execPath}" "${TSC}" src/cron-tick.ts --outDir "${path.join(CACHE, "tick")}" --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck --strict`, { cwd: HERE, stdio: "pipe" });
	} catch (e) {
		console.error("FAIL tsc compile cron-tick:", String(e.stdout ?? e.message).slice(0, 400));
		process.exit(1);
	}
	const ct = await import(pathToFileURL(path.join(CACHE, "tick", "cron-tick.js")).href);
	const at = (hms) => Date.parse("2026-10-12T" + hms + "Z");
	check("cron-tick: early fire 17:44:59.000 is the 17:45 tick -> full round", ct.isFullRound(at("17:44:59.000")) === true);
	check("cron-tick: on-time 17:45:00.000 -> full round", ct.isFullRound(at("17:45:00.000")) === true);
	check("cron-tick: late-ish 17:45:20 still the 17:45 tick -> full round", ct.isFullRound(at("17:45:20.000")) === true);
	check("cron-tick: 17:45:59.000 is the 17:46 tick -> not full", ct.isFullRound(at("17:45:59.000")) === false);
	check("cron-tick: 17:49:59.000 is the 17:50 tick -> full round", ct.isFullRound(at("17:49:59.000")) === true);
	let fulls = 0;
	for (let m = 0; m < 60; m++) if (ct.isFullRound(at("17:00:59.000") + m * 60000)) fulls++;
	check("cron-tick: :59 early fires still give exactly 12 full rounds/hour", fulls === 12);
}

if (failures > 0) { console.error(`${failures} check(s) failed, ${passes} passed`); process.exit(1); }
console.log(`ml-check: all green (${passes} passed)`);
