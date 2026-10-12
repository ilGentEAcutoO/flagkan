// Ranking skill (display-only, read-only; FINAL-WEB). ~98% of new coins die
// within 6h, so accuracy is not the skill metric. The skill is ORDER: do the
// coins a model scores safest survive more often than a random pick?
//
// Input is grouped by distinct first-sight P(dead) (one row per score value)
// so the SQL can aggregate. Tie-aware: when the top-k cut lands inside a
// group of identical scores, that group contributes pro rata (k ordered at
// random within the tie) — never by row order, which would invent skill.

export type ScoreGroup = { p: number; n: number; alive: number };

export type TopSlice = {
	frac: number; // e.g. 0.1 = safest 10%
	n: number; // coins in the slice (k = round(frac x n))
	survival: number | null; // expected survival rate of the slice
	lift: number | null; // survival / overall survival
	ci_lo: number | null; // Wilson 95% on the slice survival
	ci_hi: number | null;
	tie_share: number; // share of the slice taken pro rata from one tied group (1 = no ordering at all)
};

export type RankingStats = {
	n: number;
	survivors: number;
	survival: number | null; // overall = random pick
	survival_ci_lo: number | null;
	survival_ci_hi: number | null;
	auc: number | null; // P(random survivor scored safer than random dead coin), ties = 1/2
	distinct_scores: number;
	top: TopSlice[];
	deciles: Array<{ d: number; survival: number | null }>; // d=1 safest
	ready: boolean;
};

/** Ready = enough coins AND enough survivors that a top-10% number is not noise. */
export const RANK_MIN_N = 200;
export const RANK_MIN_SURVIVORS = 10;

const ok = (g: ScoreGroup) => Number.isFinite(g.p) && Number.isFinite(g.n) && Number.isFinite(g.alive) && g.n > 0 && g.alive >= 0 && g.alive <= g.n;

/** Wilson 95% interval for x successes out of n (x may be fractional from ties). */
export function wilson(x: number, n: number): [number, number] | null {
	if (!(n > 0) || !(x >= 0) || x > n) return null;
	const z = 1.959964, p = x / n, z2 = z * z;
	const den = 1 + z2 / n;
	const mid = (p + z2 / (2 * n)) / den;
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
	return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

// Expected survivors among the k safest coins (groups sorted safest first).
function topK(gs: ScoreGroup[], k: number): { alive: number; tie: number } {
	let left = k, alive = 0, tie = 0;
	for (const g of gs) {
		if (left <= 0) break;
		if (g.n <= left) { alive += g.alive; left -= g.n; continue; }
		alive += (g.alive * left) / g.n; // pro-rata share of a tied group
		tie = left;
		left = 0;
	}
	return { alive, tie };
}

export function rankingStats(groups: ScoreGroup[], fracs: number[] = [0.01, 0.02, 0.1]): RankingStats {
	const gs = groups.filter(ok).slice().sort((a, b) => a.p - b.p); // low P(dead) = safest first
	const n = gs.reduce((s, g) => s + g.n, 0);
	const survivors = gs.reduce((s, g) => s + g.alive, 0);
	const empty: RankingStats = { n, survivors, survival: null, survival_ci_lo: null, survival_ci_hi: null, auc: null, distinct_scores: gs.length, top: [], deciles: [], ready: false };
	if (!n) return empty;
	const base = survivors / n;
	const bci = wilson(survivors, n);
	// AUC over groups: for each survivor, count dead coins with a strictly
	// higher P(dead) (+1/2 for ties). Walk safest-first.
	let auc: number | null = null;
	const dead = n - survivors;
	if (survivors > 0 && dead > 0) {
		let deadAfter = dead, num = 0;
		for (const g of gs) {
			const gd = g.n - g.alive;
			deadAfter -= gd;
			num += g.alive * (deadAfter + gd / 2);
		}
		auc = num / (survivors * dead);
	}
	const top: TopSlice[] = fracs.map((frac) => {
		const k = Math.max(1, Math.round(frac * n));
		const { alive, tie } = topK(gs, k);
		const surv = alive / k;
		const ci = wilson(alive, k);
		return { frac, n: k, survival: surv, lift: base > 0 ? surv / base : null, ci_lo: ci ? ci[0] : null, ci_hi: ci ? ci[1] : null, tie_share: tie / k };
	});
	const deciles: Array<{ d: number; survival: number | null }> = [];
	let prevK = 0, prevAlive = 0;
	for (let d = 1; d <= 10; d++) {
		const k = Math.round((d / 10) * n);
		const a = topK(gs, k).alive;
		deciles.push({ d, survival: k > prevK ? (a - prevAlive) / (k - prevK) : null });
		prevK = k; prevAlive = a;
	}
	return {
		n, survivors, survival: base, survival_ci_lo: bci ? bci[0] : null, survival_ci_hi: bci ? bci[1] : null,
		auc, distinct_scores: gs.length, top, deciles,
		ready: n >= RANK_MIN_N && survivors >= RANK_MIN_SURVIVORS,
	};
}
