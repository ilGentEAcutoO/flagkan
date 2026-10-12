-- FlagKan DATA-001 (Oct 12): collect the data the model is missing. DATA-ONLY:
-- nothing here changes a light, verdict, outcome label, upgrade or proof number.
--   snapshots.look   15 / 30 for the +15m / +30m second-look samples, NULL for
--                    every other snapshot. Look samples are EXCLUDED from
--                    outcome resolution, backfill-v9, upgrade/refresh "last
--                    snapshot" logic and stale re-sampling (AND look IS NULL).
--   dev_signals      dev/creator facts fetched at first sight (create tx,
--                    dev buy, dev share initial/now, creator history from our
--                    own DB, strictly prior coins only).
-- Additive only. Run once against production D1 BEFORE deploying the worker
-- that writes these columns:
--   npx wrangler d1 execute radar-d1-main --remote --file=migrate-v11.sql
ALTER TABLE snapshots ADD COLUMN look INTEGER;
CREATE INDEX IF NOT EXISTS idx_rounds_first_seen ON rounds (first_seen);
CREATE TABLE IF NOT EXISTS dev_signals (
	mint TEXT PRIMARY KEY,
	creator TEXT,
	create_sig TEXT,
	create_ts INTEGER,
	dev_buy_sol REAL,
	dev_buy_tokens REAL,
	dev_share_initial REAL,
	dev_share_now REAL,
	creator_prior_n INTEGER,
	creator_prior_graded INTEGER,
	creator_prior_dead INTEGER,
	err TEXT,
	fetched_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dev_creator ON dev_signals (creator);
CREATE INDEX IF NOT EXISTS idx_dev_fetched ON dev_signals (fetched_at);
