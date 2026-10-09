// Offline rule backtest on REAL resolved data (first-seen state only — no leakage).
// Pulls resolved live verdicts + first/second snapshots + signals from remote D1,
// then simulates candidate red rules and reports honest deltas vs current /proof.
// Usage: npm run backtest   (from radar/)
import { execSync } from "node:child_process";

const SQL = `SELECT v.choice AS choice, o.dead AS dead,`
	+ ` (SELECT liquidity_usd FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS liq1,`
	+ ` (SELECT fdv FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS fdv1,`
	+ ` (SELECT txns_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS tx1,`
	+ ` (SELECT buys_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS b1,`
	+ ` (SELECT sells_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS s1,`
	+ ` (SELECT price_usd FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS p1,`
	+ ` (SELECT ts FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS t1,`
	+ ` (SELECT liquidity_usd FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1 OFFSET 1) AS liq2,`
	+ ` (SELECT txns_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1 OFFSET 1) AS tx2,`
	+ ` (SELECT buys_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1 OFFSET 1) AS b2,`
	+ ` (SELECT sells_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1 OFFSET 1) AS s2,`
	+ ` (SELECT price_usd FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1 OFFSET 1) AS p2,`
	+ ` (SELECT ts FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1 OFFSET 1) AS t2,`
+ ` (SELECT price_chg_h1 FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1 OFFSET 1) AS chg2,`
+ ` (SELECT pair_age_min FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS pairAge,`
	+ ` g.top1_pct AS top1, g.top2_11_pct AS t211, g.early_buys AS early, g.mint_age_min AS age, g.pool_suspect AS pool, g.mint_auth_live AS mauth, g.freeze_auth_live AS fauth, v.f_whale AS fWhale, v.f_sell AS fSell, v.f_struct AS fStruct,`
+ ` (SELECT price_chg_h1 FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS chg1,`
+ ` (SELECT vol_h1 FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS vol1,`
	+ ` r.first_seen AS seen`
	+ ` FROM verdicts v JOIN outcomes o ON o.mint=v.mint LEFT JOIN signals g ON g.mint=v.mint JOIN rounds r ON r.mint=v.mint WHERE v.source='live'`;

const raw = execSync(`npx wrangler d1 execute radar-d1-main --remote --command "${SQL.replace(/"/g, "'")}"`, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
const rows = JSON.parse(json)[0].results;
console.log(`rows: ${rows.length} (resolved live verdicts)`);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const correct = (choice, dead) => (choice === "red" && dead === 1) || (choice !== "red" && dead === 0);

// Baseline (mirrors /api/proof exactly).
let baseOk = 0, baseReds = 0, baseRedDead = 0;
for (const r of rows) {
	if (correct(r.choice, r.dead)) baseOk++;
	if (r.choice === "red") { baseReds++; if (r.dead === 1) baseRedDead++; }
}
const baseAcc = baseOk / rows.length, baseRedP = baseRedDead / Math.max(1, baseReds);
console.log(`baseline: acc=${(baseAcc * 100).toFixed(1)}% redP=${(baseRedP * 100).toFixed(1)}% (reds=${baseReds})`);

function report(name, flagFn) {
	let nEval = 0, nFlag = 0, flagDead = 0, newOk = 0, newReds = 0, newRedDead = 0;
	for (const r of rows) {
		const f = flagFn(r);
		if (f === null) { // unevaluable: keep old verdict
			if (correct(r.choice, r.dead)) newOk++;
			if (r.choice === "red") { newReds++; if (r.dead === 1) newRedDead++; }
			continue;
		}
		nEval++;
		const ch = f ? "red" : r.choice;
		if (f) { nFlag++; if (r.dead === 1) flagDead++; }
		if (correct(ch, r.dead)) newOk++;
		if (ch === "red") { newReds++; if (r.dead === 1) newRedDead++; }
	}
	const prec = nFlag ? flagDead / nFlag : null;
	const acc = newOk / rows.length, redP = newReds ? newRedDead / newReds : null;
	const d = (x) => (x === null ? "n/a" : (x * 100).toFixed(1) + "%");
	console.log(`${name}: eval=${nEval} flagged=${nFlag} flagPrec=${d(prec)} acc ${d(baseAcc)}→${d(acc)} redP ${d(baseRedP)}→${d(redP)}`);
}

// E3-3 lysis: lysis$ = (t211/100)*fdv; residual = liq - lysis$.
const lysis = (r) => {
	const liq = num(r.liq1), fdv = num(r.fdv1), t = num(r.t211);
	if (liq === null || fdv === null || t === null || liq <= 0) return null;
	return { residual: liq - (t / 100) * fdv, ratio: ((t / 100) * fdv) / liq };
};
for (const floor of [250, 500, 1000, 2000]) {
	report(`lysis residual<${floor}`, (r) => { const l = lysis(r); return l === null ? null : l.residual < floor; });
}
for (const q of [0.5, 0.8, 1.0, 1.5]) {
	report(`lysis ratio>${q}`, (r) => { const l = lysis(r); return l === null ? null : l.ratio > q; });
}

// E5-2-style upgrade triggers at 2nd snapshot (yellow/green → red only).
// Honesty guard: the 2nd read must land INSIDE the 6h outcome window —
// a live system cannot upgrade after resolution.
const gapMin = (r) => (r.t1 != null && r.t2 != null ? (r.t2 - r.t1) / 60000 : null);
const inWindow = (r) => r.seen != null && r.t2 != null && r.t2 <= r.seen + 21600000;
const upGuard = (r) => {
	if (r.choice === "red") return "red"; // already red: never flippable
	return inWindow(r) ? "ok" : null;
};
const sr = (b, s) => {
	const bb = num(b), ss = num(s);
	return bb === null || ss === null ? null : ss / Math.max(1, bb + ss);
};
report("UP liq crash 50% (gap>5m,in-window)", (r) => {
	const u = upGuard(r);
	if (u !== "ok") return u === "red" ? false : null;
	const g = gapMin(r), a = num(r.liq1), b = num(r.liq2);
	if (g === null || g < 5 || a === null || b === null || a <= 0) return null;
	return b < 0.5 * a;
});
report("UP late-illiquid (gap>5m,in-window)", (r) => {
	const u = upGuard(r);
	if (u !== "ok") return u === "red" ? false : null;
	const g = gapMin(r), a = num(r.liq1), b = num(r.liq2);
	if (g === null || g < 5 || a === null || b === null) return null;
	return a >= 1000 && b < 1000;
});
report("UP sellRatio +0.3 (gap>5m,tx2>=20,in-window)", (r) => {
	const u = upGuard(r);
	if (u !== "ok") return u === "red" ? false : null;
	const g = gapMin(r), r1 = sr(r.b1, r.s1), r2 = sr(r.b2, r.s2), t2 = num(r.tx2);
	if (g === null || g < 5 || r1 === null || r2 === null || t2 === null || t2 < 20) return null;
	return r2 - r1 > 0.3;
});
report("UP price crash 50% (gap>5m,in-window)", (r) => {
	const u = upGuard(r);
	if (u !== "ok") return u === "red" ? false : null;
	const g = gapMin(r), a = num(r.p1), b = num(r.p2);
	if (g === null || g < 5 || a === null || b === null || a <= 0) return null;
	return b < 0.5 * a;
});
report("UP price crash 70% (gap>5m,in-window)", (r) => {
	const u = upGuard(r);
	if (u !== "ok") return u === "red" ? false : null;
	const g = gapMin(r), a = num(r.p1), b = num(r.p2);
	if (g === null || g < 5 || a === null || b === null || a <= 0) return null;
	return b < 0.3 * a;
});
// E1-3 slow-bleed grid: shallower price triggers for late fades.
for (const [nm, f] of [["40%", 0.6], ["50%-dup", 0.5], ["60%", 0.4]]) {
	report(`UP price crash ${nm} (gap>5m,in-window)`, (r) => {
		const u = upGuard(r);
		if (u !== "ok") return u === "red" ? false : null;
		const g = gapMin(r), a = num(r.p1), b = num(r.p2);
		if (g === null || g < 5 || a === null || b === null || a <= 0) return null;
		return b < f * a;
	});
}
report("UP h1-drop 50% (gap>5m,in-window)", (r) => {
	const u = upGuard(r);
	if (u !== "ok") return u === "red" ? false : null;
	const g = gapMin(r), c = num(r.chg2);
	if (g === null || g < 5 || c === null) return null;
	return c <= -50;
});
report("UP UNION liq50|px70 (gap>5m,in-window)", (r) => {
	const u = upGuard(r);
	if (u !== "ok") return u === "red" ? false : null;
	const g = gapMin(r), a = num(r.liq1), b = num(r.liq2), pa = num(r.p1), pb = num(r.p2);
	if (g === null || g < 5) return null;
	const liqFire = a !== null && b !== null && a > 0 && b < 0.5 * a;
	const pxFire = pa !== null && pb !== null && pa > 0 && pb < 0.3 * pa;
	if ((a === null || b === null) && (pa === null || pb === null)) return null;
	return liqFire || pxFire;
});
report("UP txn death (tx1>50,tx2==0,in-window)", (r) => {
	const u = upGuard(r);
	if (u !== "ok") return u === "red" ? false : null;
	const a = num(r.tx1), b = num(r.tx2);
	if (a === null || b === null) return null;
	return a > 50 && b === 0;
});
// Median 2nd-snapshot gap (are we simulating a realistic +30min look?).
{
	const gaps = rows.map(gapMin).filter((g) => g !== null && g > 0).sort((a, b) => a - b);
	console.log(`2nd-snapshot gap median=${gaps.length ? gaps[Math.floor(gaps.length / 2)].toFixed(1) : "n/a"}min n=${gaps.length}`);
}

// ---- VETO MODE (E1-8 / E1-2 / E5-3): replay rules on first-seen state,
// hold pure-R2 reds that match a survivor profile. Vetoes only UN-fire reds.
// Replay caveat: signals (top1/age) overwrite, so replay is approximate for
// old rows; forward rule-ID audit verifies live. A veto SHIPS iff redP
// strictly improves with <=1 lost true red (pre-committed gate).
const replayR1 = (r) => {
	const liq = num(r.liq1), t = num(r.top1);
	return liq !== null && liq < 1000 && (t === null || t > 10);
};
const replayR2 = (r) => {
	const a = num(r.age), t = num(r.tx1);
	return a !== null && t !== null && a > 0 && a < 10 && t >= 500;
};
function reportVeto(name, vetoFn) {
	let newOk = 0, newReds = 0, newRedDead = 0, held = 0, lostTrue = 0, savedFalse = 0, pureR2 = 0;
	for (const r of rows) {
		let ch = r.choice;
		if (r.choice === "red" && replayR2(r) && !replayR1(r)) {
			pureR2++;
			if (vetoFn(r) === true) {
				ch = "yellow"; held++;
				if (r.dead === 1) lostTrue++; else savedFalse++;
			}
		}
		if (correct(ch, r.dead)) newOk++;
		if (ch === "red") { newReds++; if (r.dead === 1) newRedDead++; }
	}
	const d = (x) => (x * 100).toFixed(1) + "%";
	console.log(`${name}: pureR2=${pureR2} held=${held} (lostTrue=${lostTrue} savedFalse=${savedFalse}) acc ${d(baseAcc)}→${d(newOk / rows.length)} redP ${d(baseRedP)}→${d(newReds ? newRedDead / newReds : 0)}`);
}
reportVeto("VETO E1-8 dual-clock (pairAge>=30 hold)", (r) => {
	const p = num(r.pairAge);
	return p !== null && p >= 30;
});
reportVeto("VETO E1-2 buy-absorbed (sellRatio<0.5,buys>=150)", (r) => {
	const b = num(r.b1), s = num(r.s1);
	return b !== null && s !== null && b >= 150 && s / Math.max(1, b + s) < 0.5;
});
for (const [t, l, a] of [[50, 10000, 60], [60, 15000, 90], [40, 5000, 30]]) {
	reportVeto(`VETO E5-3 whale-hype (top1>${t},liq1>${l},age>${a})`, (r) => {
		const top1 = num(r.top1), liq = num(r.liq1), age = num(r.age);
		return top1 !== null && liq !== null && age !== null && top1 > t && liq > l && age > a;
	});
}

// ---- VETO MODE R1 (E1-1 / E1-5 / E1-4): red + liq1<1000 + not-R2, veto on
// overwrite-stable data only (authorities rarely change; chg1/vol1 immutable
// first snapshots). Same ship gate: redP strictly up, lostTrue <= 1.
function reportVetoR1(name, vetoFn) {
	let newOk = 0, newReds = 0, newRedDead = 0, held = 0, lostTrue = 0, savedFalse = 0, cand = 0;
	for (const r of rows) {
		let ch = r.choice;
		const liq = num(r.liq1);
		if (r.choice === "red" && liq !== null && liq < 1000 && !replayR2(r)) {
			cand++;
			if (vetoFn(r) === true) {
				ch = "yellow"; held++;
				if (r.dead === 1) lostTrue++; else savedFalse++;
			}
		}
		if (correct(ch, r.dead)) newOk++;
		if (ch === "red") { newReds++; if (r.dead === 1) newRedDead++; }
	}
	const d = (x) => (x * 100).toFixed(1) + "%";
	console.log(`${name}: cand=${cand} held=${held} (lostTrue=${lostTrue} savedFalse=${savedFalse}) acc ${d(baseAcc)}→${d(newOk / rows.length)} redP ${d(baseRedP)}→${d(newReds ? newRedDead / newReds : 0)}`);
}
reportVetoR1("VETO E1-1 renounced-pardon (both auths 0)", (r) => num(r.mauth) === 0 && num(r.fauth) === 0);
for (const x of [20, 50, 100]) {
	reportVetoR1(`VETO E1-5 momentum (chg1>${x}%)`, (r) => {
		const c = num(r.chg1);
		return c !== null && c > x;
	});
}
for (const y of [1, 3, 5]) {
	reportVetoR1(`VETO E1-4 vol-backed (vol1/liq1>${y})`, (r) => {
		const v = num(r.vol1), l = num(r.liq1);
		return v !== null && l !== null && l > 0 && v / l > y;
	});
}

// ---- E1-1 DEAD-YELLOW AUTOPSY: decile-mine yellow verdicts for >=70%-dead
// (n>=8) buckets. IMMUTABLE features only — signals top1/age/simpson
// overwrite, so they are excluded (would fake separation). Hot deciles
// become one-shot yellow->red trigger candidates via report() above.
function deciles(name, valFn) {
	const ys = rows.filter((r) => r.choice === "yellow").map((r) => ({ v: valFn(r), d: r.dead })).filter((o) => o.v !== null);
	ys.sort((a, b) => a.v - b.v);
	if (ys.length < 20) { console.log(`DEC ${name}: n=${ys.length} too small`); return; }
	const out = [];
	for (let i = 0; i < 10; i++) {
		const s = ys.slice(Math.floor(i * ys.length / 10), Math.floor((i + 1) * ys.length / 10));
		const dead = s.filter((o) => o.d === 1).length;
		const hot = s.length >= 8 && dead / s.length >= 0.7 ? " HOT" : "";
		out.push(`d${i}[${s[0].v.toFixed(2)}..${s[s.length - 1].v.toFixed(2)}]=${dead}/${s.length}${hot}`);
	}
	console.log(`DEC ${name} (n=${ys.length}):\n  ` + out.join("\n  "));
}
const sr1 = (r) => {
	const b = num(r.b1), s = num(r.s1);
	return b === null || s === null ? null : s / Math.max(1, b + s);
};
deciles("sellRatio1", sr1);
deciles("fSell", (r) => num(r.fSell));
deciles("fWhale", (r) => num(r.fWhale));
deciles("fStruct", (r) => num(r.fStruct));
deciles("chg1", (r) => num(r.chg1));
deciles("logLiq1", (r) => { const l = num(r.liq1); return l === null ? null : Math.log10(1 + l); });
deciles("tx1", (r) => num(r.tx1));

// ---- E3-2 GREEN FUNNEL (not autopsy: greens n=2, nothing to split) ----
{
	const gs = rows.filter((r) => r.choice === "green");
	console.log(`GREEN funnel: resolved=${rows.length} greens=${gs.length} deadGreens=${gs.filter((r) => r.dead === 1).length}`);
}
