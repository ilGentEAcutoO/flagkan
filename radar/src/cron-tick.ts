// Cron tick math (pure, unit-tested in ml-check.mjs).
//
// Cloudflare fires the minutely trigger ~0.6s BEFORE the minute boundary
// (scheduledTime itself reads hh:mm:59), so the wall-clock minute at handler
// start is the PREVIOUS minute. Gating full rounds on it silently skipped
// every :x0/:x5 tick from 12 Oct 14:10 UTC (no intake, no grading). Key the
// gate on the trigger minute instead: the scheduled time rounded to the
// nearest minute.

export const FULL_ROUND_EVERY_MIN = 5;

/** Trigger minute (UTC, 0-59) a cron fire at `ms` belongs to. */
export function tickMinute(ms: number): number {
	return new Date(Math.round(ms / 60000) * 60000).getUTCMinutes();
}

/** True on the ticks that run discovery + refresh (every 5th minute). */
export function isFullRound(ms: number): boolean {
	return tickMinute(ms) % FULL_ROUND_EVERY_MIN === 0;
}
