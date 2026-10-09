-- FlagKan E5-1: attribute live upgrades to their trigger (liq_crash /
-- late_illiquid / price_crash / model) so per-trigger live precision is
-- measurable in /api/proof instead of console logs only.
-- Run once against production D1:
--   wrangler d1 execute radar-d1-main --remote --file=migrate-v7.sql
ALTER TABLE verdicts ADD COLUMN upgrade_why TEXT;
-- The first 3 upgrades (pre-column) provably fired via price_crash: dex-fed
-- refresh (liq triggers feed-skipped) with last/first price < 0.001.
UPDATE verdicts SET upgrade_why = 'price_crash' WHERE upgraded_from IS NOT NULL AND upgrade_why IS NULL;
