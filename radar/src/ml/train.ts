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

export function hardRed(s: {
	liquidity_usd?: unknown;
	top1_pct?: unknown;
	early_buys?: unknown;
	mint_age_min?: unknown;
}): string | null {
	const liq = Number(s.liquidity_usd);
	const top1 = Number(s.top1_pct);
	const early = Number(s.early_buys);
	const age = Number(s.mint_age_min);
	// R1: effectively no liquidity at first sight — unbuyable
	if (Number.isFinite(liq) && liq < 1000 && (!Number.isFinite(top1) || top1 > 10)) return "illiquid";
	// R2: bot-frenzy ignition — brand-new coin with an extreme early-tx rate
	if (Number.isFinite(age) && Number.isFinite(early) && age > 0 && age < 10 && early / age > 50)
		return "bot_frenzy";
	return null;
}

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
	return [top1, t211, logLiq, fdvLiq, earlyRate, ageN, sellRatio, txns, pool, pRed];
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
	const l2 = opts.l2 ?? 0.1;
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

function correct(choice: string, dead: number): boolean {
	return (choice === "red" && dead === 1) || (choice !== "red" && dead === 0);
}

function champChoice(r: TrainRow): string {
	const rule = hardRed({
		liquidity_usd: r.liq,
		top1_pct: r.top1,
		early_buys: r.early,
		mint_age_min: r.age,
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
	});
	if (rule) return "red";
	const p = predict(m, buildFeatures(r));
	if (p >= 0.75) return "red";
	if (r.choice === "green" && p < 0.5) return "green";
	return "yellow";
}

export interface SplitResult {
	n: number;
	nTrain: number;
	nTest: number;
	champAcc: number | null;
	chalAcc: number | null;
	model: GoldModel;
}

export function timeSplitValidate(rows: TrainRow[]): SplitResult {
	const sorted = [...rows].sort((a, b) => a.ts - b.ts);
	const n = sorted.length;
	const k = Math.floor(n * 0.7);
	const train = sorted.slice(0, k);
	const test = sorted.slice(k);
	const model = trainLR(train.map((r) => ({ x: buildFeatures(r), y: r.dead })));
	if (test.length < 5) {
		return { n, nTrain: train.length, nTest: test.length, champAcc: null, chalAcc: null, model };
	}
	let champOk = 0;
	let chalOk = 0;
	for (const r of test) {
		if (correct(champChoice(r), r.dead)) champOk++;
		if (correct(chalChoice(r, model), r.dead)) chalOk++;
	}
	return {
		n,
		nTrain: train.length,
		nTest: test.length,
		champAcc: champOk / test.length,
		chalAcc: chalOk / test.length,
		model,
	};
}
