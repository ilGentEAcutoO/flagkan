// LightGBM decider (shadow Oct 12; decides since SWITCH-001, Oct 12). Pure
// module: no Worker APIs, no deps. Port of ml-lab/out/predict-live.mjs
// (lightgbm-compact-v1). It scores the SAME 27-dim buildFeatures(row) vector
// as the live LR, at first sight only; the result is stored
// (verdicts.p_gbm_first), graded on /api/proof, and — when train.ts DECIDER
// is "gbm" and scoring succeeds — drives policyV2 (see pickDecider).
import { FEATURES, aucOf } from "./train.js";

export interface GbmTree {
	f: number[];
	t: number[];
	dl: number[];
	l: number[];
	r: number[];
	v: number[];
	root: number;
}

export interface GbmModel {
	kind: string;
	features: string[];
	n_trees?: number;
	trees: GbmTree[];
	meta?: { gbm_v?: string; features?: string[]; t_sure?: number; [k: string]: unknown };
}

// Feature order must equal train.ts FEATURES exactly (names AND positions):
// a silent reorder would score garbage, so any mismatch refuses to score.
export function gbmModelOk(m: unknown): m is GbmModel {
	if (!m || typeof m !== "object") return false;
	const g = m as GbmModel;
	if (g.kind !== "lightgbm-compact-v1" || !Array.isArray(g.trees) || g.trees.length === 0) return false;
	const sameOrder = (fs: unknown) =>
		Array.isArray(fs) && fs.length === FEATURES.length && FEATURES.every((k, i) => fs[i] === k);
	if (!sameOrder(g.features)) return false;
	if (g.meta?.features !== undefined && !sameOrder(g.meta.features)) return false;
	return true;
}

// Raw evaluator: P(dead_v2) = sigmoid(sum of leaf values). x in model
// feature order; null/undefined/NaN = missing (buildFeatures never emits
// missing, but the encoding is kept exact for parity with LightGBM).
// dl = default_left + 2*missing_type; missing_type 0=NaN, 1=None (missing->0), 2=Zero.
export function predictGbm(m: GbmModel, x: ReadonlyArray<number | null | undefined>): number {
	let s = 0;
	for (const tr of m.trees) {
		let n = tr.root;
		let guard = 0;
		while (n >= 0) {
			if (++guard > 4096) throw new Error("gbm: tree cycle");
			let v = x[tr.f[n]];
			const dl = tr.dl[n] & 1, mt = tr.dl[n] >> 1;
			let miss = v === null || v === undefined || Number.isNaN(v);
			if (mt === 1 && miss) { v = 0; miss = false; }
			if (mt === 2 && !miss && Math.abs(v as number) <= 1e-35) miss = true;
			const left = miss && mt !== 1 ? dl === 1 : (v as number) <= tr.t[n];
			n = left ? tr.l[n] : tr.r[n];
		}
		s += tr.v[-n - 1];
	}
	return 1 / (1 + Math.exp(-s));
}

// Safe live entry: null on a bad model, wrong dims or any evaluator error,
// so the cron can never break on the shadow.
export function scoreGbm(m: unknown, x: number[]): number | null {
	try {
		if (!gbmModelOk(m) || x.length !== FEATURES.length) return null;
		const p = predictGbm(m, x);
		return Number.isFinite(p) ? p : null;
	} catch {
		return null;
	}
}

// Head-to-head over graded live rows (both first-sight probabilities
// present). acc: RED iff P > 0.5 vs dead; survivor_top5: alive rate among
// the 5% lowest P(dead) (null under 20 rows). AUC via aucOf (Mann-Whitney,
// ties get average ranks).
export interface ChallengerRow { pLr: number; pGbm: number; dead: 0 | 1 }
export interface ChallengerStats {
	n: number;
	auc_lr: number | null; auc_gbm: number | null;
	acc_lr: number | null; acc_gbm: number | null;
	baseline_all_red_accuracy: number | null;
	brier_lr: number | null; brier_gbm: number | null;
	survivor_top5_lr: number | null; survivor_top5_gbm: number | null;
}

export function survivorTop(ps: number[], ys: number[], frac = 0.05, minN = 20): number | null {
	if (ps.length < minN) return null;
	const k = Math.max(1, Math.floor(ps.length * frac));
	const idx = ps.map((p, i) => i).sort((a, b) => ps[a] - ps[b] || a - b).slice(0, k);
	return idx.reduce((s, i) => s + (ys[i] === 0 ? 1 : 0), 0) / k;
}

export function challengerStats(rows: ChallengerRow[]): ChallengerStats {
	const ok = rows.filter((r) => Number.isFinite(r.pLr) && Number.isFinite(r.pGbm) && (r.dead === 0 || r.dead === 1));
	const n = ok.length;
	if (!n) return { n: 0, auc_lr: null, auc_gbm: null, acc_lr: null, acc_gbm: null, baseline_all_red_accuracy: null, brier_lr: null, brier_gbm: null, survivor_top5_lr: null, survivor_top5_gbm: null };
	const ys = ok.map((r) => r.dead as number);
	const lr = ok.map((r) => r.pLr), gb = ok.map((r) => r.pGbm);
	const acc = (ps: number[]) => ps.reduce((s, p, i) => s + ((p > 0.5 ? 1 : 0) === ys[i] ? 1 : 0), 0) / n;
	const brier = (ps: number[]) => ps.reduce((s, p, i) => s + (p - ys[i]) * (p - ys[i]), 0) / n;
	return {
		n,
		auc_lr: aucOf(lr, ys), auc_gbm: aucOf(gb, ys),
		acc_lr: acc(lr), acc_gbm: acc(gb),
		baseline_all_red_accuracy: ys.reduce((s, y) => s + y, 0) / n,
		brier_lr: brier(lr), brier_gbm: brier(gb),
		survivor_top5_lr: survivorTop(lr, ys), survivor_top5_gbm: survivorTop(gb, ys),
	};
}
