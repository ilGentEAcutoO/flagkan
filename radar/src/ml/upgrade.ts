// FlagKan E5-1: feed-aware upgrade triggers + outcome.
// Liquidity is NOT comparable across feeds (gecko virtual bonding-curve
// reserves vs dex LP liquidity, often 0 for ungraduated coins). Every liq
// comparison must prove same-feed first; price is feed-agnostic.
// Pure functions — tested by ml-check.mjs against this real module.
export type Feed = string | null | undefined;

export function sameFeed(a: Feed, b: Feed): boolean {
	if (typeof a !== "string" || typeof b !== "string") return false;
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

const num = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;

// Backtest: 72.2% on 18 in-window upgrades (289 rows). Same-feed only.
export function liqCrash(feedNow: Feed, feedFirst: Feed, liq1: unknown, liqNow: unknown): boolean {
	if (!sameFeed(feedNow, feedFirst)) return false;
	const a = num(liq1), b = num(liqNow);
	return a !== null && b !== null && a > 0 && b < 0.5 * a;
}

// Backtest: 12/12 dead on resolved rows (see backtest UP late-illiquid).
export function lateIlliquid(feedNow: Feed, feedFirst: Feed, liq1: unknown, liqNow: unknown): boolean {
	if (!sameFeed(feedNow, feedFirst)) return false;
	const a = num(liq1), b = num(liqNow);
	return a !== null && b !== null && a >= 1000 && b < 1000;
}

// Backtest: 66.7% on 9 in-window upgrades. Price is feed-agnostic, so this
// is the trigger dex-batch refresh can drive for gecko long-tail coins.
export function priceCrash(px1: unknown, pxNow: unknown): boolean {
	const a = num(px1), b = num(pxNow);
	return a !== null && b !== null && a > 0 && b < 0.3 * a;
}

export interface DeadCall { dead: 0 | 1; zombie: boolean; dead_v2?: 0 | 1 | null; idle?: 0 | 1 | null }

// Per-rule red confidence (E2-2): one 0.95 stamp overstated frenzy reds by
// ~35pp. R1 measured 91.2% (31/34, CI contains 0.95 — stamp kept); R2-fat
// measured 60% (6/10, 0.95 far outside CI — restamped to measured 0.60).
// Display + ECE only: no gate consumes confidence. The ECE panel judges
// these stamps forward; restamp again if they drift (E4-6).
export function ruleConfidence(rule: string | null): number {
	if (rule === "bot_frenzy") return 0.6;
	return 0.95;
}

// Feed-aware outcome: the <1000 liq clause applies ONLY when the last
// snapshot's feed matches the intake feed (else dex structural 0 for
// ungraduated coins would mass-label healthy coins dead).
export function resolveDead(
	mult: unknown, lastLiq: unknown, lastFeed: Feed, firstFeed: Feed,
	firstTx: unknown, lastTx: unknown,
	v2?: { first: SnapLite | null; last: SnapLite | null; prior: SnapLite | null; resolvedAt: number },
): DeadCall {
	const m = num(mult);
	const zombie = m === 1 && num(firstTx) === 0 && num(lastTx) === 0;
	const l = num(lastLiq);
	// Null liq counts as dead (preserves the old `?? 0` semantics exactly
	// when feeds match — unknown liquidity is not exonerating).
	const liqDead = sameFeed(lastFeed, firstFeed) && (l === null || l < 1000);
	const dead = (m !== null && m <= 0.1) || liqDead || zombie ? 1 : 0;
	// v1 semantics above are frozen (legacy column outcomes.dead). Label v2
	// rides along when the caller passes the snapshots it needs.
	if (!v2) return { dead, zombie };
	const r2 = resolveDeadV2(v2.first, v2.last, v2.prior, firstFeed, v2.resolvedAt);
	return { dead, zombie, dead_v2: r2.dead_v2, idle: r2.idle };
}

// ---------------------------------------------------------------------------
// Label v2 (Oct 12). v1's liq clause was switched off for ~91% of rows
// (gecko intake, dex re-sample => cross-feed), so dust that simply stopped
// trading resolved ALIVE. v2 adds the idle clause the public site already
// promised ("price frozen with zero trading"), measured on real data:
// dex h1 volume is NOT a structural zero for gecko coins (94% of dex samples
// <30 min after first sight show volume, decaying to 4% by 4-6 h), and when
// the final dex sample says vol_h1 = 0 the price is frozen vs a sample
// 10-60 min earlier in 1239/1240 cases.
//
// dead_v2 = 1 when, at resolution (~6 h after first sight):
//   (a) last price <= 0.1 x first price, OR
//   (b) last liquidity < $1,000 measured on the SAME feed as intake, OR
//   (c) idle = nobody traded in the final hour:
//       - last sample must be fresh (<= 90 min before resolution), else idle
//         is unknown (NULL) and cannot kill the coin;
//       - feed reports h1 volume: idle = vol_h1 == 0 AND txns_5m == 0;
//       - feed has no h1 volume (gecko detail): idle = a sample 55-120 min
//         before the last one has the IDENTICAL price AND last txns_5m == 0;
//         any trade evidence => 0; no comparable sample => NULL.
// dead_v2 is NULL (ungradeable) when there was never a follow-up sample
// after first sight — no outcome evidence at all. Unknown never kills.
export const LABEL_V2 = {
	horizonH: 6,
	priceDrop: 0.9,
	liqUsd: 1000,
	idleWindowH: 1,
	staleMs: 90 * 60 * 1000,
	priorMinMs: 55 * 60 * 1000,
	priorMaxMs: 120 * 60 * 1000,
} as const;

export interface SnapLite {
	ts: number;
	price: number | null;
	liq: number | null;
	feed: Feed;
	tx5: number | null;
	volH1: number | null;
}

export interface DeadCallV2 { dead_v2: 0 | 1 | null; idle: 0 | 1 | null; why: string }

export function resolveDeadV2(
	first: SnapLite | null, last: SnapLite | null, prior: SnapLite | null,
	firstFeed: Feed, resolvedAt: number,
): DeadCallV2 {
	const fp = first ? num(first.price) : null;
	if (!first || !last || fp === null || fp <= 0) return { dead_v2: null, idle: null, why: "no_first" };
	if (last.ts <= first.ts) return { dead_v2: null, idle: null, why: "no_sample" };
	const lp = num(last.price) ?? 0;
	const priceDead = lp / fp <= 0.1; // = price fell >= LABEL_V2.priceDrop (90%), same literal as v1
	const l = num(last.liq);
	const liqDead = sameFeed(last.feed, firstFeed) && (l === null || l < LABEL_V2.liqUsd);
	let idle: 0 | 1 | null = null;
	if (resolvedAt - last.ts <= LABEL_V2.staleMs) {
		const vol = num(last.volH1);
		const tx = num(last.tx5);
		if (vol !== null) {
			idle = vol === 0 && (tx ?? 0) === 0 ? 1 : 0;
		} else {
			const p = prior && prior.ts >= last.ts - LABEL_V2.priorMaxMs && prior.ts <= last.ts - LABEL_V2.priorMinMs ? prior : null;
			if (p && tx === 0 && num(p.price) !== null && num(p.price) === num(last.price)) idle = 1;
			else if (p || (tx !== null && tx > 0)) idle = 0;
		}
	}
	const dead_v2: 0 | 1 = priceDead || liqDead || idle === 1 ? 1 : 0;
	return { dead_v2, idle, why: priceDead ? "price" : liqDead ? "liq" : idle === 1 ? "idle" : "alive" };
}
