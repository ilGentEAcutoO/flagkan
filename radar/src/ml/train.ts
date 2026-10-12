// Pure ML module: no Worker APIs, no dependencies.
// Used by the worker (train on the edge) and testable via tsc + node.

// Model v8 / label v2 (Oct 12): 27 strictly first-sight dims. REMOVED the
// leaky pRed, pRedVsF, pRedVsConc: they read verdicts.p_red, which the
// upgrade path overwrites after a price crash (post-outcome information);
// v7's offline 80.7/44.3 was inflated by it.
// TODO(p_red_first): a first-sight Jev/model p_red can come back as a
// feature from verdicts.p_red_first once enough policy-v2 rows resolve.
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
	"missSig",
	"missChg",
	"missVol",
	"missCount",
	"chgVolGap",
	"missSigChg",
	"fSpread",
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
	// Legacy, NOT a feature since v8 (verdicts.p_red is overwritten by
	// upgrades = post-outcome leak). Kept optional so old row dumps load.
	pRed?: number | null;
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

// Reward shaping (Oct 11): dead-row upweight + model-red bar, tuned by
// sweep-reward.mjs on real resolved data. Live (index.ts MODEL_RED_P)
// imports DEFAULT_RED_BAR — single source of truth, validation == live.
export const DEFAULT_POS_WEIGHT = 5;
export const DEFAULT_RED_BAR = 0.7;
export const DEFAULT_L2 = 0.01;
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

// Policy v2 (Oct 12) REVERTS this demote: under label v2 demoted:illiquid
// rows die at 95.9% and demoted:memory at 95.0% (base 93.5%) — far above
// the 50% line, so demoting them to yellow costs accuracy. Kept (pure,
// unit-tested) for replaying pre-v2 history only; the live path no longer
// calls it.
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
	// RL-missing (Oct 11 wave 1 winner): missingness + disagreement dims.
	// Nulls carry signal, not noise: chgH1-null rows die at 32% vs 8.7%
	// present, signal-JOIN-miss rows at 21% vs 14% base (n=5000 dump).
	// All derive from fixed dump columns — no new SQL. Killed Oct 10 under
	// old hyper (tie, silentReds=0); wins under reward shaping.
	const missSig = (r.top1 == null || r.t211 == null || r.mintLive == null
		|| r.freezeLive == null || r.simpson == null) ? 1 : 0;
	const missChg = r.chgH1 == null ? 1 : 0;
	const missVol = r.volH1 == null ? 1 : 0;
	const missCount = ([r.top1, r.t211, r.mintLive, r.freezeLive, r.simpson, r.chgH1, r.volH1]
		.filter((v) => v == null).length) / 7;
	// Tape gap: volume printed but no h1 change (stale quote history).
	const chgVolGap = r.chgH1 == null && r.volH1 != null ? 1 : 0;
	const missSigChg = missSig === 1 && missChg === 1 ? 1 : 0;
	// Jev sensor spread (disagreement between the three factor judgments).
	// pRed-based disagreement dims were dropped in v8 (leak, see FEATURES).
	const fSpread = Math.max(clamp01(r.fWhale), clamp01(r.fSell), clamp01(r.fStruct))
		- Math.min(clamp01(r.fWhale), clamp01(r.fSell), clamp01(r.fStruct));
	return [top1, t211, logLiq, fdvLiq, earlyRate, ageN, sellRatio, txns, pool,
		mintLive, freezeLive, momH1, volLiqH1, pairAge, lysis, simpson,
		clamp01(r.fWhale), clamp01(r.fSell), clamp01(r.fStruct), isGecko,
		missSig, missChg, missVol, missCount, chgVolGap, missSigChg,
		fSpread];
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
	rows: Array<{ x: number[]; y: number; w?: number }>,
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
	// Per-sample weight (dead-row upweight); normalized by total weight so
	// lr scale is stable. w=1 everywhere is exactly the old math.
	const n = Math.max(1, rows.reduce((s, r) => s + (r.w ?? 1), 0));
	for (let it = 0; it < iters; it++) {
		const gw = new Array<number>(d).fill(0);
		let gb = 0;
		for (const r of rows) {
			let z = b;
			for (let j = 0; j < d; j++) z += w[j] * r.x[j];
			const sw = r.w ?? 1;
			const err = (sigmoid(z) - r.y) * sw;
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

function chalChoice(r: TrainRow, m: GoldModel, redBar: number): string {
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
	// a high bar (redBar = live MODEL_RED_P) so validation measures what ships.
	if (p >= redBar) return "red";
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

export function timeSplitValidate(rows: TrainRow[], opts: { posWeight?: number; redBar?: number; l2?: number } = {}): SplitResult {
	const posWeight = opts.posWeight ?? DEFAULT_POS_WEIGHT;
	const redBar = opts.redBar ?? DEFAULT_RED_BAR;
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
	const model = trainLR(train.map((r) => ({ x: buildFeatures(r), y: r.dead, w: r.dead === 1 ? posWeight : 1 })), { l2: opts.l2 ?? DEFAULT_L2 });
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
		const hc = chalChoice(r, model, redBar);
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

// ---------------------------------------------------------------------------
// Model v8 + policy v2 (Oct 12). Label = outcomes.dead_v2 (see upgrade.ts).
// Offline, newest-30% time split (12500 gradeable verdicts, test n=3750,
// base dead_v2 0.930): AUC 0.694; policy acc 0.9352 vs all-red 0.9304 /
// all-yellow 0.0696; red_sure (p >= 0.99) precision 0.983 (n=293); green
// (p <= 0.30) alive 14/14; hard rules overriding a non-red model call: 5/6
// dead (kept).
export const LABEL_V = 2;
export const MODEL_V = 8;
export const POLICY_V = 2;
// RED iff P(dead_v2) > T_RED: accuracy-optimal for the binary scoring
// (correct = RED&dead | non-RED&alive) when p is calibrated.
export const T_RED = 0.5;
export const T_SURE = 0.99;
export const T_GREEN = 0.3;
export const V2_L2 = 1e-4;
// No champion (or a dim mismatch) => no model p: the base rate (~0.92
// dead) makes all-red the accuracy-optimal fallback. Stamped as p_red.
export const BASE_RATE_P = 0.92;

export type Tier = "red_sure" | "red" | "yellow" | "green";

// Pure policy: control flow in code. p = model P(dead_v2) at first sight
// (null = no model), rule = hardRed(), jev = Jev's yellow/green choice.
// tSure = the DECIDER's red_sure bar (LR: T_SURE 0.99; LightGBM: its
// meta.t_sure 0.996). RED / GREEN thresholds are shared by both models.
export function policyV2(p: number | null, rule: string | null, jev: string | null, tSure: number = T_SURE): { choice: "red" | "yellow" | "green"; tier: Tier } {
	if (p !== null && p >= tSure) return { choice: "red", tier: "red_sure" };
	if (rule) return { choice: "red", tier: "red" };
	if (p === null || p > T_RED) return { choice: "red", tier: "red" };
	if (p <= T_GREEN) return { choice: "green", tier: "green" };
	// Model leans alive but not strongly: Jev may lift to green (its strict
	// all-conditions bar), otherwise yellow.
	if (jev === "green") return { choice: "green", tier: "green" };
	return { choice: "yellow", tier: "yellow" };
}

// ---------------------------------------------------------------------------
// Decider (Oct 12, SWITCH-001). LightGBM decides the lights; the LR champion
// is the automatic fallback and stays the head-to-head comparison. Out-of-
// sample replay on 357 unseen resolved coins: GBM AUC 0.776 vs LR v9 0.736
// (CIs overlap). ROLLBACK = set DECIDER to "lr" here and deploy. The weekly
// LR retrain only swaps the champion used when the decider is "lr" or when
// LightGBM can't score, so a newly promoted LR can never take over silently.
export type DeciderPref = "gbm" | "lr";
export type Decider = "gbm" | "lr" | "rule" | "base";
export const DECIDER: DeciderPref = "gbm";

// Pure: which model's P(dead_v2) drives policyV2. pGbm is null when the
// LightGBM model failed its feature-order guard or could not score.
// decider = the model whose p was used; with no model p at all it is
// "rule" (a hard rule fired: red) or "base" (base-rate all-red fallback).
export function pickDecider(
	pref: DeciderPref,
	pGbm: number | null,
	pLr: number | null,
	gbmTSure: number | null,
	rule: string | null
): { p: number | null; tSure: number; decider: Decider } {
	const ok = (v: number | null): v is number => typeof v === "number" && Number.isFinite(v);
	if (pref === "gbm" && ok(pGbm)) return { p: pGbm, tSure: ok(gbmTSure) ? gbmTSure : T_SURE, decider: "gbm" };
	if (ok(pLr)) return { p: pLr, tSure: T_SURE, decider: "lr" };
	return { p: null, tSure: T_SURE, decider: rule ? "rule" : "base" };
}

function solveLinear(A: number[][], b: number[]): number[] {
	const n = b.length;
	const M = A.map((r, i) => [...r, b[i]]);
	for (let c = 0; c < n; c++) {
		let piv = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
		[M[c], M[piv]] = [M[piv], M[c]];
		const d = M[c][c];
		if (Math.abs(d) < 1e-12) continue;
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = M[r][c] / d;
			if (f !== 0) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
		}
	}
	return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
}

// L2-regularized logistic regression by Newton/IRLS (converges in ~10-20
// steps; plain GD at 500 iters left v2 underfit at AUC 0.64 vs 0.69).
// Penalty = l2 * n / 2 * |w|^2, bias unpenalized. Deterministic.
export function trainLRNewton(rows: Array<{ x: number[]; y: number }>, opts: { l2?: number; iters?: number } = {}): GoldModel {
	const l2 = opts.l2 ?? V2_L2;
	const iters = opts.iters ?? 30;
	const d = FEATURES.length + 1;
	const w = new Array<number>(d).fill(0);
	const n = Math.max(1, rows.length);
	const x = new Array<number>(d).fill(1);
	for (let it = 0; it < iters; it++) {
		const H: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
		const g = new Array<number>(d).fill(0);
		for (const r of rows) {
			for (let j = 0; j < d - 1; j++) x[j] = r.x[j] ?? 0;
			x[d - 1] = 1;
			let z = 0;
			for (let j = 0; j < d; j++) z += w[j] * x[j];
			const p = sigmoid(z);
			const e = p - r.y;
			const h = p * (1 - p);
			for (let j = 0; j < d; j++) {
				g[j] += e * x[j];
				const hx = h * x[j];
				for (let k = j; k < d; k++) H[j][k] += hx * x[k];
			}
		}
		for (let j = 0; j < d; j++) {
			for (let k = 0; k < j; k++) H[j][k] = H[k][j];
			if (j < d - 1) { g[j] += l2 * n * w[j]; H[j][j] += l2 * n; }
			H[j][j] += 1e-9;
		}
		const step = solveLinear(H, g);
		let mx = 0;
		for (let j = 0; j < d; j++) { w[j] -= step[j]; mx = Math.max(mx, Math.abs(step[j])); }
		if (!(mx > 1e-7)) break;
	}
	return { weights: w.slice(0, d - 1), bias: w[d - 1], features: [...FEATURES] };
}

export function aucOf(ps: number[], ys: number[]): number | null {
	const idx = ps.map((p, i) => [p, ys[i]] as [number, number]).sort((a, b) => a[0] - b[0]);
	let sp = 0, np = 0, nn = 0;
	for (let i = 0; i < idx.length;) {
		let j = i;
		while (j < idx.length && idx[j][0] === idx[i][0]) j++;
		const avg = (i + j + 1) / 2;
		for (let k = i; k < j; k++) { if (idx[k][1] === 1) { sp += avg; np++; } else nn++; }
		i = j;
	}
	return np && nn ? (sp - (np * (np + 1)) / 2) / (np * nn) : null;
}

function ruleOf(r: TrainRow): string | null {
	return hardRed({ liquidity_usd: r.liq, top1_pct: r.top1, early_buys: r.early, mint_age_min: r.age, txns_5m: r.txns });
}

export type TierStats = Record<Tier, { n: number; dead: number }>;
export interface PolicyScore { n: number; acc: number | null; redP: number | null; reds: number; tiers: TierStats }

// Replays policy v2 on labeled rows. Jev's yellow/green is NOT replayed
// (verdicts.choice is overwritten by upgrades), so jev = null: validation
// measures model + rules, which own every RED decision.
export function scorePolicy(rows: TrainRow[], m: GoldModel | null): PolicyScore {
	const tiers: TierStats = { red_sure: { n: 0, dead: 0 }, red: { n: 0, dead: 0 }, yellow: { n: 0, dead: 0 }, green: { n: 0, dead: 0 } };
	let ok = 0, reds = 0, redDead = 0;
	for (const r of rows) {
		const p = m ? predict(m, buildFeatures(r)) : null;
		const { choice, tier } = policyV2(p, ruleOf(r), null);
		tiers[tier].n++;
		tiers[tier].dead += r.dead;
		if (correct(choice, r.dead)) ok++;
		if (choice === "red") { reds++; redDead += r.dead; }
	}
	return { n: rows.length, acc: rows.length ? ok / rows.length : null, redP: reds ? redDead / reds : null, reds, tiers };
}

export interface SplitResultV2 {
	labelV: number;
	n: number;
	nTrain: number;
	nTest: number;
	base: number | null;
	auc: number | null;
	champAcc: number | null;
	champRedP: number | null;
	chalAcc: number | null;
	chalRedP: number | null;
	allRedAcc: number | null;
	allYellowAcc: number | null;
	champIsBaseline: boolean;
	tiers: TierStats | null;
	model: GoldModel;
}

// Label-switch-safe validation (Oct 12): rows MUST carry the v2 label in
// `dead`. The champion is scored by replaying ITS weights on the same test
// slice under the same label — never via a stored accuracy measured on the
// v1 label. With no same-label champion (champ = null: label just
// switched, or dims changed) the bar is the all-red base-rate policy,
// which the challenger must strictly beat (shouldPromote).
export function timeSplitValidateV2(rows: TrainRow[], champ: GoldModel | null, opts: { l2?: number } = {}): SplitResultV2 {
	const sorted = [...rows].sort((a, b) => a.ts - b.ts);
	const n = sorted.length;
	const k = Math.floor(n * 0.7);
	const train = sorted.slice(0, k);
	const test = sorted.slice(k);
	const model = trainLRNewton(train.map((r) => ({ x: buildFeatures(r), y: r.dead })), { l2: opts.l2 ?? V2_L2 });
	const champOk = champ !== null && champ.weights.length === FEATURES.length;
	if (test.length < 5) {
		return { labelV: LABEL_V, n, nTrain: train.length, nTest: test.length, base: null, auc: null, champAcc: null, champRedP: null, chalAcc: null, chalRedP: null, allRedAcc: null, allYellowAcc: null, champIsBaseline: !champOk, tiers: null, model };
	}
	const base = test.reduce((s, r) => s + r.dead, 0) / test.length;
	const chal = scorePolicy(test, model);
	const ch = scorePolicy(test, champOk ? champ : null);
	const auc = aucOf(test.map((r) => predict(model, buildFeatures(r))), test.map((r) => r.dead));
	return {
		labelV: LABEL_V, n, nTrain: train.length, nTest: test.length, base, auc,
		champAcc: ch.acc, champRedP: ch.redP, chalAcc: chal.acc, chalRedP: chal.redP,
		allRedAcc: base, allYellowAcc: 1 - base, champIsBaseline: !champOk, tiers: chal.tiers, model,
	};
}
// Shared retrain rowset (label v2, strictly first-sight features). Mirrored
// by lib-local.mjs pullRows (offline gate/sweeps) — keep the two in sync.
// - label = outcomes.dead_v2 (NULL = ungradeable, excluded);
// - features from the FIRST non-look snapshot (look IS NULL: DATA-001 +15/+30m
//   samples never stand in for first sight), first-sight signals, and Jev factors;
//   NO verdicts.p_red (overwritten by upgrades = leak);
// - signals recomputed >10 min after first sight (signals-now) are not
//   first-sight: nulled (unknown) instead of leaking later holder data.
export const RETRAIN_SQL_V2 = "SELECT v.ts AS ts, o.dead_v2 AS dead, v.choice AS choice, r.first_seen AS seen, g.ts AS sigTs, "
	+ "(SELECT liquidity_usd FROM snapshots s WHERE s.mint = v.mint AND s.look IS NULL ORDER BY ts ASC LIMIT 1) AS liq, "
	+ "(SELECT fdv FROM snapshots s WHERE s.mint = v.mint AND s.look IS NULL ORDER BY ts ASC LIMIT 1) AS fdv, "
	+ "(SELECT txns_5m FROM snapshots s WHERE s.mint = v.mint AND s.look IS NULL ORDER BY ts ASC LIMIT 1) AS txns, "
	+ "(SELECT buys_5m FROM snapshots s WHERE s.mint = v.mint AND s.look IS NULL ORDER BY ts ASC LIMIT 1) AS buys, "
	+ "(SELECT sells_5m FROM snapshots s WHERE s.mint = v.mint AND s.look IS NULL ORDER BY ts ASC LIMIT 1) AS sells, "
	+ "(SELECT price_chg_h1 FROM snapshots s WHERE s.mint = v.mint AND s.look IS NULL ORDER BY ts ASC LIMIT 1) AS chgH1, "
	+ "(SELECT vol_h1 FROM snapshots s WHERE s.mint = v.mint AND s.look IS NULL ORDER BY ts ASC LIMIT 1) AS volH1, "
	+ "(SELECT pair_age_min FROM snapshots s WHERE s.mint = v.mint AND s.look IS NULL ORDER BY ts ASC LIMIT 1) AS pairAge, "
	+ "g.top1_pct AS top1, g.top2_11_pct AS t211, g.early_buys AS early, g.mint_age_min AS age, "
	+ "g.pool_suspect AS pool, g.mint_auth_live AS mintLive, g.freeze_auth_live AS freezeLive, "
	+ "g.simpson AS simpson, "
	+ "v.f_whale AS fWhale, v.f_sell AS fSell, v.f_struct AS fStruct, r.source AS src FROM verdicts v "
	+ "JOIN outcomes o ON o.mint = v.mint LEFT JOIN signals g ON g.mint = v.mint LEFT JOIN rounds r ON r.mint = v.mint "
	+ "WHERE o.dead_v2 IS NOT NULL ORDER BY v.ts DESC LIMIT 8000";

const nn = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const SIG_FIRST_SIGHT_MS = 10 * 60 * 1000;

// One mapping for worker retrain and offline tools (lib-local.mjs).
export function rowFromDb(r: Record<string, unknown>): TrainRow {
	const seen = nn(r.seen), sigTs = nn(r.sigTs);
	const sigOk = !(seen !== null && sigTs !== null && sigTs > seen + SIG_FIRST_SIGHT_MS);
	const sg = (v: unknown) => (sigOk ? nn(v) : null);
	return {
		ts: Number(r.ts), dead: Number(r.dead) === 1 ? 1 : 0, choice: String(r.choice ?? "yellow"),
		liq: nn(r.liq), fdv: nn(r.fdv), txns: nn(r.txns), buys: nn(r.buys), sells: nn(r.sells),
		chgH1: nn(r.chgH1), volH1: nn(r.volH1), pairAge: nn(r.pairAge),
		top1: sg(r.top1), t211: sg(r.t211), early: sg(r.early), age: sg(r.age), pool: sg(r.pool),
		mintLive: sg(r.mintLive), freezeLive: sg(r.freezeLive), simpson: sg(r.simpson),
		fWhale: nn(r.fWhale), fSell: nn(r.fSell), fStruct: nn(r.fStruct),
		src: typeof r.src === "string" ? r.src : null,
	};
}
