// GREEN arm sweep: find survival conditions >=95% among resolved non-reds.
// Offline, read-only, first-seen only. Fit oldest 70% / eval newest 30%.
// Yellow->green never changes accuracy (both predict alive); ship gate is
// eval survival >=93% + volume, purely to revive the missing GREEN arm safely.
// Usage: node sweep-green.mjs (from radar/)
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = `SELECT v.mint AS mint, v.ts AS ts, v.choice AS choice, o.dead AS dead,`
	+ ` (SELECT liquidity_usd FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS liq1,`
	+ ` (SELECT price_chg_h1 FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS chg1,`
	+ ` (SELECT vol_h1 FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS vol1,`
	+ ` (SELECT txns_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS tx1,`
	+ ` (SELECT buys_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS b1,`
	+ ` (SELECT sells_5m FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS s1,`
	+ ` (SELECT pair_age_min FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS pairAge,`
	+ ` (SELECT fdv FROM snapshots s WHERE s.mint=v.mint ORDER BY ts ASC LIMIT 1) AS fdv1,`
	+ ` g.top1_pct AS top1, g.top2_11_pct AS t211, g.early_buys AS early, g.mint_age_min AS age, g.pool_suspect AS pool, g.mint_auth_live AS mauth, g.freeze_auth_live AS fauth, g.simpson AS simpson,`
	+ ` r.source AS src, r.first_seen AS seen`
	+ ` FROM verdicts v JOIN outcomes o ON o.mint=v.mint LEFT JOIN signals g ON g.mint=v.mint JOIN rounds r ON r.mint=v.mint WHERE v.source='live' AND v.choice != 'red'`;
function dq(sql) {
	const raw = execSync(`npx wrangler d1 execute radar-d1-main --remote --command "${sql.replace(/"/g, "'")}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: HERE });
	const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
	return JSON.parse(json)[0].results;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rows = dq(SQL).map((r) => ({ ...r, dead: Number(r.dead) === 1 ? 1 : 0, ts: Number(r.ts) }));
console.log(`non-red resolved rows=${rows.length}`);
rows.sort((a, b) => a.ts - b.ts);
const k = Math.floor(rows.length * 0.7);
const fit = rows.slice(0, k), eva = rows.slice(k);
console.log(`fit=${fit.length} eval=${eva.length}`);

const sr = (r) => { const b = num(r.b1), s = num(r.s1); return (b === null || s === null || b + s <= 0) ? null : s / (b + s); };
const renounced = (r) => num(r.mauth) === 0 && num(r.fauth) === 0;
const cand = {
	"liq1>=20000": (r) => { const l = num(r.liq1); return l !== null && l >= 20000; },
	"liq1>=50000": (r) => { const l = num(r.liq1); return l !== null && l >= 50000; },
	"renounced": renounced,
	"renounced+liq>=20k": (r) => { const l = num(r.liq1); return renounced(r) && l !== null && l >= 20000; },
	"pairAge>60": (r) => { const p = num(r.pairAge); return p !== null && p > 60; },
	"pairAge>120": (r) => { const p = num(r.pairAge); return p !== null && p > 120; },
	"top1<10": (r) => { const t = num(r.top1); return t !== null && t < 10; },
	"simpson>0.7": (r) => { const s = num(r.simpson); return s !== null && s > 0.7; },
	"chgH1>0": (r) => { const c = num(r.chg1); return c !== null && c > 0; },
	"tx1>=100": (r) => { const t = num(r.tx1); return t !== null && t >= 100; },
	"buyPressure(sr<0.4)": (r) => { const s = sr(r); return s !== null && s < 0.4; },
	"early==0": (r) => num(r.early) === 0,
	"liq>=20k+old+renounced": (r) => { const l = num(r.liq1), p = num(r.pairAge); return l !== null && l >= 20000 && p !== null && p > 60 && renounced(r); },
	"src=dex": (r) => r.src === "dex",
};
console.log(`--- GREEN SWEEP (survival rate; base=${((fit.filter((r) => r.dead === 0).length / fit.length) * 100).toFixed(1)}% fit) ---`);
const picked = [];
for (const [name, fn] of Object.entries(cand)) {
	const f = fit.filter(fn), e = eva.filter(fn);
	const fs = f.length ? f.filter((r) => r.dead === 0).length / f.length : null;
	const es = e.length ? e.filter((r) => r.dead === 0).length / e.length : null;
	const d = (x) => x === null ? "n/a" : (x * 100).toFixed(1) + "%";
	const win = fs !== null && fs >= 0.95 && f.length >= 20;
	if (win) picked.push(name);
	console.log(`  ${name}: fit n=${f.length} surv=${d(fs)} | eval n=${e.length} surv=${d(es)} ${win ? "GREEN-CANDIDATE" : ""}`);
}
console.log(`picked: ${picked.length ? picked.join(" + ") : "(none)"}`);
// Marginal: winner union yellow->green on eval (acc must not move; green volume + precision reported).
if (picked.length) {
	const green = (r) => picked.some((n) => cand[n](r));
	const e = eva.filter(green);
	const es = e.length ? e.filter((r) => r.dead === 0).length / e.length : null;
	let ok0 = 0, ok1 = 0;
	for (const r of eva) {
		const c0 = r.choice;
		const c1 = green(r) ? "green" : c0;
		const good = (c) => (c === "red" && r.dead === 1) || (c !== "red" && r.dead === 0);
		if (good(c0)) ok0++;
		if (good(c1)) ok1++;
	}
	console.log(`MARGINAL eval: greens=${e.length} greenPrec=${es === null ? "n/a" : (es * 100).toFixed(1) + "%"} acc ${(ok0 / eva.length * 100).toFixed(1)}->${(ok1 / eva.length * 100).toFixed(1)}`);
	console.log(`GATE-GREEN: ${es !== null && es >= 0.93 && e.length >= 10 ? "SHIP" : "KILL"}`);
} else console.log("GATE-GREEN: KILL (no candidate)");
