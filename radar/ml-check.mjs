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

// --- buildFeatures: new slots + null defaults ---
{
	check("FEATURES has 21 entries", ml.FEATURES.length === 21, String(ml.FEATURES.length));
	const nullRow = { ts: 1, dead: 0, choice: "yellow", liq: null, top1: null, t211: null, fdv: null, early: null, age: null, txns: null, buys: null, sells: null, pool: null, pRed: null, mintLive: null, freezeLive: null, chgH1: null, volH1: null, pairAge: null, simpson: null, fWhale: null, fSell: null, fStruct: null, src: null };
	const f = ml.buildFeatures(nullRow);
	check("features length 21", f.length === 21, String(f.length));
	check("null auth -> 0.5 neutral", f[10] === 0.5 && f[11] === 0.5, f.slice(10, 12).join(","));
	check("null momentum -> 0", f[12] === 0 && f[13] === 0, f.slice(12, 14).join(","));
	check("null pairAge -> 0.5", f[14] === 0.5, String(f[14]));
	check("null lysis -> 0.3 placeholder", f[15] === 0.3, String(f[15]));
	check("null simpson -> 0.5 neutral", f[16] === 0.5, String(f[16]));
	const lys = ml.buildFeatures({ ...nullRow, t211: 20, fdv: 1000000, liq: 10000 });
	check("lysis log-scaled", approx(lys[15], Math.log10(21) / 3), String(lys[15]));
	const sim = ml.buildFeatures({ ...nullRow, simpson: 0.2 });
	check("simpson passthrough", sim[16] === 0.2, String(sim[16]));
	check("null factors -> 0.5 uncertain", f[17] === 0.5 && f[18] === 0.5 && f[19] === 0.5, f.slice(17, 20).join(","));
	const fac = ml.buildFeatures({ ...nullRow, fWhale: 0.9, fSell: 0.1, fStruct: 1.7 });
	check("factors passthrough+clamp", fac[17] === 0.9 && fac[18] === 0.1 && fac[19] === 1, fac.slice(17, 20).join(","));
	check("null src -> 0.5 neutral", f[20] === 0.5, String(f[20]));
	check("gecko -> 1, dex -> 0", ml.buildFeatures({ ...nullRow, src: "gecko" })[20] === 1 && ml.buildFeatures({ ...nullRow, src: "dex" })[20] === 0);
	const live = ml.buildFeatures({ ...nullRow, mintLive: 1, freezeLive: 0, chgH1: -50, volH1: 10000, liq: 10000, pairAge: 720 });
	check("live auth -> 1/0", live[10] === 1 && live[11] === 0, live.slice(10, 12).join(","));
	check("dump momentum negative", approx(live[12], Math.tanh(-0.5)), String(live[12]));
	check("volume depth positive", live[13] > 0, String(live[13]));
	check("pairAge scaled", approx(live[14], 0.5), String(live[14]));
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

if (failures > 0) { console.error(`${failures} check(s) failed, ${passes} passed`); process.exit(1); }
console.log(`ml-check: all green (${passes} passed)`);
