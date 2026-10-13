// Stats population (pure, unit-tested in ml-check.mjs against real SQLite).
//
// FlagKan's claim is about NEW coins seen by the cron at first sight. Two
// kinds of rows used to leak into the headline / ranking / challenger:
// - on-demand checks (/api/verdict-now, /api/signals-now): a user picked the
//   coin (dogwifhat, Bonk), so it is not a random draw from the feed. New
//   ones are stored with verdicts.source = 'on_demand'; older ones carry
//   source 'live' but their verdict ts is later than rounds.first_seen (the
//   cron path writes the verdict with ts == first_seen, always).
// - old pairs (boosted coins that are days or years old): not "new coins".
// Labels and verdicts are never rewritten; this only selects rows to count.

/** First-sight pair age cap for the stats population (6 hours). */
export const POP_MAX_PAIR_AGE_MIN = 360;

/** verdicts.source for a coin judged on request instead of by the cron. */
export const ON_DEMAND_SOURCE = "on_demand";

/** First-sight pair age of verdict row `v` (earliest non-look snapshot). */
export const FIRST_PAIR_AGE_SQL =
	"(SELECT s.pair_age_min FROM snapshots s WHERE s.mint = v.mint AND s.look IS NULL ORDER BY s.ts ASC LIMIT 1)";

/** Verdict row `v` came through the cron path (verdict ts == first sight). */
export const CRON_PATH_SQL = "v.ts = (SELECT r0.first_seen FROM rounds r0 WHERE r0.mint = v.mint)";

/** WHERE fragment (alias v = verdicts): the counted population. Unknown pair age is excluded. */
export const POP_SQL = `v.source = 'live' AND ${CRON_PATH_SQL} AND ${FIRST_PAIR_AGE_SQL} <= ${POP_MAX_PAIR_AGE_MIN}`;

/** Per-row reason a live-tagged verdict is left out (first match wins), or null when counted. */
export const POP_EXCLUDE_REASON_SQL = `CASE WHEN NOT (${CRON_PATH_SQL}) THEN 'on_demand'
	WHEN ${FIRST_PAIR_AGE_SQL} IS NULL THEN 'unknown_age'
	WHEN ${FIRST_PAIR_AGE_SQL} > ${POP_MAX_PAIR_AGE_MIN} THEN 'old_pair' ELSE NULL END`;

export type PopRow = { source: string; verdictTs: number; firstSeen: number | null; firstPairAgeMin: number | null };

/** Same rule as POP_SQL, for code and tests. */
export function inPopulation(r: PopRow): boolean {
	return r.source === "live" && r.firstSeen !== null && r.verdictTs === r.firstSeen
		&& r.firstPairAgeMin !== null && Number.isFinite(r.firstPairAgeMin) && r.firstPairAgeMin <= POP_MAX_PAIR_AGE_MIN;
}
