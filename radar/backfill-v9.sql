-- FlagKan label v2 history re-grade (Oct 12). Run AFTER migrate-v9.sql:
--   wrangler d1 execute radar-d1-main --remote --file=backfill-v9.sql
-- Re-grades every stored outcome into outcomes.dead_v2 / outcomes.idle from
-- the stored snapshots with EXACTLY the rule in src/ml/upgrade.ts
-- resolveDeadV2 (verified row-for-row against it offline on the Oct 12 dump,
-- see ml-check.mjs "backfill-v9 parity"). Legacy outcomes.dead is untouched.
--   first  = earliest snapshot (ts, id); intake feed = rounds.source, else first.feed
--   last   = latest snapshot with ts <= resolved_at (ts, id)
--   prior  = earliest snapshot 55..120 min before last (gecko-feed idle check)
--   no follow-up sample (last.ts <= first.ts) or no first price => dead_v2 NULL
--   idle NULL when last is > 90 min older than resolved_at
-- Idempotent: safe to re-run. Uses scratch tables _regrade_v9* (dropped at end).
DROP TABLE IF EXISTS _regrade_v9a;
DROP TABLE IF EXISTS _regrade_v9b;
CREATE TABLE _regrade_v9a AS
SELECT o.mint AS mint, o.resolved_at AS rat, r.source AS rsrc,
	(SELECT s.id FROM snapshots s WHERE s.mint = o.mint ORDER BY s.ts ASC, s.id ASC LIMIT 1) AS fid,
	(SELECT s.id FROM snapshots s WHERE s.mint = o.mint AND s.ts <= o.resolved_at ORDER BY s.ts DESC, s.id DESC LIMIT 1) AS lid
FROM outcomes o LEFT JOIN rounds r ON r.mint = o.mint;
CREATE TABLE _regrade_v9b AS
SELECT a.mint AS mint, a.rat AS rat,
	f.ts AS fts, f.price_usd AS fp, COALESCE(a.rsrc, f.feed) AS ffeed,
	l.ts AS lts, l.price_usd AS lp, l.liquidity_usd AS ll, l.feed AS lfeed, l.txns_5m AS ltx, l.vol_h1 AS lvol,
	(SELECT p.price_usd FROM snapshots p WHERE p.mint = a.mint AND p.ts >= l.ts - 7200000 AND p.ts <= l.ts - 3300000 ORDER BY p.ts ASC, p.id ASC LIMIT 1) AS pp,
	(SELECT COUNT(*) FROM snapshots p WHERE p.mint = a.mint AND p.ts >= l.ts - 7200000 AND p.ts <= l.ts - 3300000) AS pn,
	CAST(NULL AS INTEGER) AS idle
FROM _regrade_v9a a LEFT JOIN snapshots f ON f.id = a.fid LEFT JOIN snapshots l ON l.id = a.lid;
UPDATE _regrade_v9b SET idle = CASE
	WHEN lts IS NULL OR fts IS NULL OR fp IS NULL OR fp <= 0 OR lts <= fts THEN NULL
	WHEN rat - lts > 5400000 THEN NULL
	WHEN lvol IS NOT NULL THEN (CASE WHEN lvol = 0 AND COALESCE(ltx, 0) = 0 THEN 1 ELSE 0 END)
	WHEN pn > 0 AND ltx = 0 AND pp IS NOT NULL AND lp IS NOT NULL AND pp = lp THEN 1
	WHEN pn > 0 OR ltx > 0 THEN 0
	ELSE NULL END;
CREATE INDEX IF NOT EXISTS _regrade_v9b_mint ON _regrade_v9b (mint);
UPDATE outcomes SET
	idle = (SELECT b.idle FROM _regrade_v9b b WHERE b.mint = outcomes.mint),
	dead_v2 = (SELECT CASE
		WHEN b.fp IS NULL OR b.fp <= 0 OR b.lts IS NULL OR b.fts IS NULL OR b.lts <= b.fts THEN NULL
		WHEN COALESCE(b.lp, 0) / b.fp <= 0.1 THEN 1
		WHEN b.ffeed IS NOT NULL AND b.lfeed IS NOT NULL AND LOWER(TRIM(b.lfeed)) = LOWER(TRIM(b.ffeed)) AND (b.ll IS NULL OR b.ll < 1000) THEN 1
		WHEN b.idle = 1 THEN 1
		ELSE 0 END
		FROM _regrade_v9b b WHERE b.mint = outcomes.mint);
-- Pre-v2 verdicts: p_red is first-sight unless an upgrade overwrote it.
UPDATE verdicts SET p_red_first = p_red WHERE p_red_first IS NULL AND upgraded_from IS NULL AND policy_v IS NULL;
DROP TABLE IF EXISTS _regrade_v9a;
DROP TABLE IF EXISTS _regrade_v9b;
