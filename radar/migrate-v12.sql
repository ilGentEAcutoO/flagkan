-- FlagKan FIX-003 (Oct 12): dev collector retries transient errors.
--   dev_signals.attempts  tries so far for this coin. Rows whose err is a
--                         429 / timeout / -32015 / no_supply are picked again
--                         after 30 min, at most 3 tries; NULL (rows written
--                         before this migration) counts as 1.
-- Additive, data-only. Run once against production D1 BEFORE deploying the
-- worker that writes this column:
--   npx wrangler d1 execute radar-d1-main --remote --file=migrate-v12.sql
ALTER TABLE dev_signals ADD COLUMN attempts INTEGER DEFAULT 1;
