-- FlagKan council v3: streaming re-verdict audit + shadow green + Simpson diversity.
-- Run once against production D1:
--   wrangler d1 execute radar-d1-main --remote --file=migrate-v3.sql
ALTER TABLE verdicts ADD COLUMN upgraded_from TEXT;
ALTER TABLE verdicts ADD COLUMN upgraded_ts INTEGER;
ALTER TABLE verdicts ADD COLUMN shadow TEXT;
ALTER TABLE signals ADD COLUMN simpson REAL;
