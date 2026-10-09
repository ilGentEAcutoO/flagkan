// Pure ML module: no Worker APIs, no dependencies.
// Used by the worker (train on the edge) and testable via tsc + node.

export const FEATURES = [
	"top1",
	"t211",
	"logLiq",
	"fdvLiq",
	"earlyRate",
	"age",
	"sellRatio",
	"txns",
	"pool",
	"pRed",
	"mintLive",
	"freezeLive",
	"momH1",
	"volLiqH1",
	"pairAge",
	"lysis",
	"simpson",
	"fWhale",
	"fSell",
	"fStruct",
	"isGecko",
] as const;

export interface TrainRow {
	ts: number;
	dead: 0 | 1;
	choice: string;
	liq: number | null;
	top1: number | null;
	t211: number | null;
	fdv: number | null;
	early: number | null;
	age: number | null;
	txns: number | null;
	buys: number | null;
	sells: number | null;
	pool: number | null;
	pRed: number | null;
	mintLive: number | null;
	freezeLive: number | null;
	chgH1: number | null;
	volH1: number | null;
	pairAge: number | null;
	simpson: number | null;
	fWhale: number | null;
	fSell: number | null;
	fStruct: number | null;
	src: string | null;
	zombie?: boolean;
}

export interface GoldModel {
	weights: number[];
	bias: number;
	features: string[];
}

export const DEFAULT_MODEL: GoldModel = {
	weights: FEATURES.map(() => 0),
	bias: 0,
	features: [...FEATURES],
};

export interface MintAuth {
	mintLive: 0 | 1;
	freezeLive: 0 | 1;
}

// Dependency-free base64 decode: works identically on Workers and Node,
// no atob/Buffer so this module stays runtime-agnostic and unit-testable.
export function b64ToBytes(b64: string): Uint8Array | null {
	const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const s = b64.replace(/\s/g, "");
	if (s.length === 0 || s.length % 4 !== 0) return null;
	let pad = 0;
	if (s.endsWith("==")) pad = 2;
	else if (s.endsWith("=")) pad = 1;
	const out = new Uint8Array((s.length / 4) * 3 - pad);
	let o = 0;
	for (let i = 0; i < s.length; i += 4) {
		let v = 0;
		for (let j = 0; j < 4; j++) {
			const c = s[i + j];
			v <<= 6;
			if (c === "=") {
				if (i + 4 < s.length || (j < 2 && pad > 0)) return null;
			} else {
				const k = abc.indexOf(c);
				if (k < 0) return null;
				v |= k;
			}
		}
		out[o++] = (v >> 16) & 0xff;
		if (o < out.length) out[o++] = (v >> 8) & 0xff;
		if (o < out.length) out[o++] = v & 0xff;
	}
	return out;
}

// Parse a Solana Mint account (base64, 82 bytes) for live authorities.
// Layout: mint_auth COption<Pubkey> @0 (4B tag + 32B), supply u64 @36,
// decimals @44, initialized @45, freeze_auth COption<Pubkey> @46.
// A live mint authority can print infinite supply; a live freeze authority
// can lock your tokens — both are classic rug flags. Returns null when the
// account data is missing or malformed (caller treats as unknown, not safe).
export function parseMintAuthorities(b64: unknown): MintAuth | null {
	if (typeof b64 !== "string") return null;
	const bytes = b64ToBytes(b64);
	if (!bytes || bytes.length < 82) return null;
	const u32 = (off: number) =>
		bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24);
	return {
		mintLive: u32(0) === 0 ? 0 : 1,
		freezeLive: u32(46) === 0 ? 0 : 1,
	};
}

// Relaxed green bar for shadow logging (E4-7): looser than Jev's strict green
// on every axis, authorities may be unknown but never live. Missing holder
// data fails closed (999 defaults), never passes.
export function shadowGreen(v: Record<string, unknown>): boolean {
	const top1 = Number(v.top1_pct ?? 999);
	const t211 = Number(v.top2_11_pct ?? 999);
	const liq = Number(v.liquidity_usd ?? 0);
	const age = Number(v.mint_age_min ?? 0);
	const sratio = Number(v.sell_ratio_5m ?? 1);
	return top1 < 25 && t211 < 60 && liq > 20000 && age > 10 && sratio < 0.65
		&& v.mint_auth_live !== 1 && v.freeze_auth_live !== 1;
}

export function hardRed(s: {
	liquidity_usd?: unknown;
	top1_pct?: unknown;
	early_buys?: unknown;
	mint_age_min?: unknown;
	txns_5m?: unknown;
}): string | null {
	const liq = Number(s.liquidity_usd);
	const top1 = Number(s.top1_pct);
	const age = Number(s.mint_age_min);
	const tx5 = Number(s.txns_5m);
	// R1: effectively no liquidity at first sight — unbuyable
	if (Number.isFinite(liq) && liq < 1000 && (!Number.isFinite(top1) || top1 > 10)) return "illiquid";
	// R2: bot-frenzy ignition — hundreds of market txns in 5 min on a
	// minutes-old coin with BIG exit liquidity. Thin frenzy (<$20k liq) is
	// organic hype, not bot ignition: measured on 32 liquid first-seen
	// reds, 1k-5k died at 5.6% (1/18), 5k-20k at 50% (2/4), 20k+ at 60%
	// (6/10). Thin frenzy is demoted to yellow (sequential upgrade evidence
	// can still catch its dumps); only big-money frenzy calls red one-shot.
	if (Number.isFinite(liq) && liq >= 20000 && Number.isFinite(age) && Number.isFinite(tx5) && age > 0 && age < 10 && tx5 >= 500)
		return "bot_frenzy";
	return null;
}

// V4 demote (Oct 9): one-shot illiquid (17.2%, n=640) + memory (14.2%,
// n=471) reds measured far below the red line on 2619 resolved rows, and a
// KEEP sweep found NO first-seen feature predicting death inside that pool
// (best: liq1==0 15%, top1>30 15% — at base). Forward-only: these channels
// no longer mint RED; demoted coins stay upgrade-eligible so measured
// crashes still re-RED pre-outcome. Returns the audit marker or null.
// Frozen; revisit only if demoted-recall (/api/proof) rises past 50%.
export function demoteOneShot(redSource: string | null, vRule: string | null): string | null {
	if (vRule === "illiquid" || redSource === "rule:illiquid") return "demoted:illiquid";
	if (redSource === "memory") return "demoted:memory";
	return null;
}
// Calibrated p_red for demoted yellows (measured channel precision —
// the ECE panel judges these stamps forward like E2-2 ruleConfidence).
export const DEMOTE_P_RED: Record<string, number> = { "demoted:illiquid": 0.17, "demoted:memory": 0.14 };

export function buildFeatures(r: TrainRow): number[] {
	const top1 = r.top1 == null ? 0.15 : r.top1 / 100;
	const t211 = r.t211 == null ? 0.2 : r.t211 / 100;
	const liq = r.liq ?? 0;
	const logLiq = Math.log10(1 + Math.max(0, liq)) / 6;
	const fdv = r.fdv ?? 0;
	const fdvLiq = Math.log10(1 + fdv / Math.max(1, liq)) / 4;
	const early = r.early ?? 0;
	const age = r.age ?? 1440;
	const earlyRate = Math.min(early / Math.max(0.5, age), 200) / 200;
	const ageN = Math.min(Math.max(0, age), 1440) / 1440;
	const sellRatio =
		r.buys == null || r.sells == null ? 0.5 : r.sells / Math.max(1, r.buys + r.sells);
	const txns = Math.min(r.txns ?? 0, 2000) / 2000;
	const pool = r.pool ? 1 : 0;
	const pRed = r.pRed == null ? 0.5 : Math.min(Math.max(r.pRed, 0), 1);
	// Authorities: unknown (0.5) leans neither safe nor risky; the model
	// learns the weight of known-live (1) vs known-renounced (0).
	const mintLive = r.mintLive == null ? 0.5 : r.mintLive ? 1 : 0;
	const freezeLive = r.freezeLive == null ? 0.5 : r.freezeLive ? 1 : 0;
	// Momentum: h1 price change in percent, squashed to (-1, 1).
	const momH1 = r.chgH1 == null ? 0 : Math.tanh(r.chgH1 / 100);
	// Volume depth: h1 volume relative to liquidity, log-scaled like fdvLiq.
	const volLiqH1 = Math.log10(1 + (r.volH1 ?? 0) / Math.max(1, liq)) / 4;
	const pairAge = r.pairAge == null ? 0.5 : Math.min(Math.max(0, r.pairAge), 1440) / 1440;
	// Lysis depth (E3-3, demoted to feature): backtest showed (t211 x FDV)/liq
	// flags too broadly for a binary rule (~40% precision), but the ratio still
	// carries signal the linear model can weight. Log-scaled; unknown → 0.3
	// (near-median placeholder, never a safe-zero).
	const lysisR = r.t211 == null || r.fdv == null ? null : ((r.t211 / 100) * r.fdv) / Math.max(1, liq);
	const lysis = lysisR === null ? 0.3 : Math.log10(1 + Math.max(0, lysisR)) / 3;
	// Simpson holder diversity over top-20 accounts (E3-7): 1 = perfectly
	// dispersed, 0 = one wallet owns all. Unknown → neutral 0.5.
	const simpson = r.simpson == null ? 0.5 : Math.min(Math.max(r.simpson, 0), 1);
	// Jev sensor factors (E5-3-lite): LLM risk judgments reused as ML features.
	// Noul near 0.5 means uncertain — the honest default for missing factors.
	const clamp01 = (v: number | null) => (v == null ? 0.5 : Math.min(Math.max(v, 0), 1));
	// Discovery source (E5-8-lite): resolved accuracy differs by source
	// (dex 74% vs gecko 82%), so the model gets to learn the base rate.
	// Legacy rows with null source sit at neutral 0.5.
	const isGecko = r.src == null ? 0.5 : r.src === "gecko" ? 1 : 0;
	// E5-6 interaction terms REVERTED (Oct 8): dry retrain on 997 silent rows
	// scored chalAcc identical to v5 (0.7612), +0 marginal — linear suffices,
	// extra dims are overfit surface. Do not re-add without beating v5.
	return [top1, t211, logLiq, fdvLiq, earlyRate, ageN, sellRatio, txns, pool, pRed,
		mintLive, freezeLive, momH1, volLiqH1, pairAge, lysis, simpson,
		clamp01(r.fWhale), clamp01(r.fSell), clamp01(r.fStruct), isGecko];
}

export function sigmoid(z: number): number {
	if (z >= 0) {
		const e = Math.exp(-z);
		return 1 / (1 + e);
	}
	const e = Math.exp(z);
	return e / (1 + e);
}

export function predict(m: GoldModel, x: number[]): number {
	let z = m.bias;
	const n = Math.min(m.weights.length, x.length);
	for (let i = 0; i < n; i++) z += m.weights[i] * x[i];
	return sigmoid(z);
}

export function trainLR(
	rows: Array<{ x: number[]; y: number }>,
	opts: { iters?: number; lr?: number; l2?: number } = {}
): GoldModel {
	const iters = opts.iters ?? 500;
	const lr = opts.lr ?? 1.0;
	// L2 0.03 (not 0.1): still regularizes ~200 rows x 15 features, but lets
	// overwhelming evidence cross the 0.85 model-red bar. At 0.1 even a
	// perfectly separable signal capped at p=0.76, so model reds could never
	// fire. Locked by ml-check: separable synthetic data must hit chalAcc 1.
	const l2 = opts.l2 ?? 0.03;
	const d = FEATURES.length;
	const w = new Array<number>(d).fill(0);
	let b = 0;
	const n = Math.max(1, rows.length);
	for (let it = 0; it < iters; it++) {
		const gw = new Array<number>(d).fill(0);
		let gb = 0;
		for (const r of rows) {
			let z = b;
			for (let j = 0; j < d; j++) z += w[j] * r.x[j];
			const err = sigmoid(z) - r.y;
			for (let j = 0; j < d; j++) gw[j] += err * r.x[j];
			gb += err;
		}
		for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
		b -= lr * (gb / n);
	}
	return { weights: w, bias: b, features: [...FEATURES] };
}

// Cosine similarity for rug memory (E3-4). Features are mostly non-negative
// (momH1 may dip below 0); raw cosine in [-1, 1] is the right measure.
export function cosine(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na <= 0 || nb <= 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface MemVector {
	mint: string;
	v: number[];
}

// Nearest-rug recall: closest dead vector at or above threshold, skipping the
// query coin itself (a coin must never match its own corpse — that would be
// leakage for backfilled training rows).
export function memoryHit(q: number[], mem: MemVector[], skipMint: string, thresh: number): { mint: string; cos: number } | null {
	let best: { mint: string; cos: number } | null = null;
	for (const m of mem) {
		if (m.mint === skipMint) continue;
		if (!Array.isArray(m.v) || m.v.length === 0) continue;
		const c = cosine(q, m.v);
		if (c >= thresh && (!best || c > best.cos)) best = { mint: m.mint, cos: c };
	}
	return best;
}

function correct(choice: string, dead: number): boolean {
	return (choice === "red" && dead === 1) || (choice !== "red" && dead === 0);
}

function champChoice(r: TrainRow): string {
	const rule = hardRed({
		liquidity_usd: r.liq,
		top1_pct: r.top1,
		early_buys: r.early,
		mint_age_min: r.age,
		txns_5m: r.txns,
	});
	if (rule) return "red";
	return r.choice === "red" ? "yellow" : r.choice === "green" ? "green" : "yellow";
}

function chalChoice(r: TrainRow, m: GoldModel): string {
	const rule = hardRed({
		liquidity_usd: r.liq,
		top1_pct: r.top1,
		early_buys: r.early,
		mint_age_min: r.age,
		txns_5m: r.txns,
	});
	if (rule) return "red";
	const p = predict(m, buildFeatures(r));
	// Mirrors live maybePromoteRed: the model may call red, but only with
	// a high bar (0.85) so validation measures exactly what ships.
	if (p >= 0.85) return "red";
	if (r.choice === "green" && p < 0.5) return "green";
	return "yellow";
}

export interface SplitResult {
	n: number;
	nTrain: number;
	nTest: number;
	champAcc: number | null;
	chalAcc: number | null;
	champRedP: number | null;
	chalRedP: number | null;
	model: GoldModel;
	nSilentTrain: number;
	nSilentTest: number;
	chalAccSilent: number | null;
	chalRedPSilent: number | null;
	chalRedSilent: number;
	nZombieDropped: number;
}

export interface PromoScore {
	acc: number;
	redP: number | null;
}

// Promotion policy (E4-4): strict accuracy wins, ties break on red precision
// (the metric users feel), full ties keep the incumbent. Pure and unit-tested.
export function shouldPromote(champ: PromoScore, chal: PromoScore): boolean {
	if (chal.acc > champ.acc) return true;
	if (chal.acc < champ.acc) return false;
	const champR = champ.redP ?? 0;
	const chalR = chal.redP ?? 0;
	if (chalR > champR) return true;
	return false;
}

// Rule-silence (E4-3): hardRed replays the live rule gate on a training row.
// The challenger trains ONLY on silent rows — live consumes champion p only
// where rules abstain (rules lock red before the model ever sees the coin),
// so every weight optimizes the disagreement region instead of re-learning
// R1/R2 (the old full-train model added zero marginal reds, proven by
// calibrate.mjs sweeping 0.5–0.9 with +0 marginal reds at every bar).
export function ruleSilent(r: TrainRow): boolean {
	return hardRed({
		liquidity_usd: r.liq,
		top1_pct: r.top1,
		early_buys: r.early,
		mint_age_min: r.age,
		txns_5m: r.txns,
	}) === null;
}

export function timeSplitValidate(rows: TrainRow[]): SplitResult {
	const sorted = [...rows].sort((a, b) => a.ts - b.ts);
	const n = sorted.length;
	const k = Math.floor(n * 0.7);
	const trainAll = sorted.slice(0, k);
	const test = sorted.slice(k);
	// E2-2: zombies (no price action at all, unforeseeable from first-seen
	// tape) are pure label noise — dropped from TRAIN only. The test slice
	// stays representative and /api/proof is untouched by construction.
	const train = trainAll.filter((r) => ruleSilent(r) && !r.zombie);
	const nZombieDropped = trainAll.filter((r) => ruleSilent(r) && r.zombie).length;
	const model = trainLR(train.map((r) => ({ x: buildFeatures(r), y: r.dead })));
	if (test.length < 5) {
		return { n, nTrain: train.length, nTest: test.length, champAcc: null, chalAcc: null, champRedP: null, chalRedP: null, model, nSilentTrain: train.length, nSilentTest: test.filter(ruleSilent).length, chalAccSilent: null, chalRedPSilent: null, chalRedSilent: 0, nZombieDropped };
	}
	let champOk = 0;
	let chalOk = 0;
	let champRed = 0;
	let champRedDead = 0;
	let chalRed = 0;
	let chalRedDead = 0;
	let silOk = 0;
	let silRed = 0;
	let silRedDead = 0;
	let nSil = 0;
	for (const r of test) {
		const cc = champChoice(r);
		const hc = chalChoice(r, model);
		if (correct(cc, r.dead)) champOk++;
		if (correct(hc, r.dead)) chalOk++;
		if (cc === "red") { champRed++; if (r.dead === 1) champRedDead++; }
		if (hc === "red") { chalRed++; if (r.dead === 1) chalRedDead++; }
		if (ruleSilent(r)) {
			nSil++;
			if (correct(hc, r.dead)) silOk++;
			if (hc === "red") { silRed++; if (r.dead === 1) silRedDead++; }
		}
	}
	return {
		n,
		nTrain: train.length,
		nTest: test.length,
		champAcc: champOk / test.length,
		chalAcc: chalOk / test.length,
		champRedP: champRed ? champRedDead / champRed : null,
		chalRedP: chalRed ? chalRedDead / chalRed : null,
		model,
		nSilentTrain: train.length,
		nSilentTest: nSil,
		chalAccSilent: nSil ? silOk / nSil : null,
		chalRedPSilent: silRed ? silRedDead / silRed : null,
		chalRedSilent: silRed,
		nZombieDropped,
	};
}
