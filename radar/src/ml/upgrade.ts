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

export interface DeadCall { dead: 0 | 1; zombie: boolean }

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
): DeadCall {
	const m = num(mult);
	const zombie = m === 1 && num(firstTx) === 0 && num(lastTx) === 0;
	const l = num(lastLiq);
	// Null liq counts as dead (preserves the old `?? 0` semantics exactly
	// when feeds match — unknown liquidity is not exonerating).
	const liqDead = sameFeed(lastFeed, firstFeed) && (l === null || l < 1000);
	const dead = (m !== null && m <= 0.1) || liqDead || zombie ? 1 : 0;
	return { dead, zombie };
}
