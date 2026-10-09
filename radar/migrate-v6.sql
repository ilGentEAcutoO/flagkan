-- FlagKan E5-1: feed-aware liq comparisons (gecko virtual reserves vs dex LP
-- liquidity are NOT comparable). Pre-change refreshes were always same-feed
-- (gecko via gecko detail, dex via dex), so backfilling every snapshot's feed
-- from its intake source is correct.
-- Run once against production D1:
--   wrangler d1 execute radar-d1-main --remote --file=migrate-v6.sql
ALTER TABLE snapshots ADD COLUMN feed TEXT;
UPDATE snapshots SET feed = COALESCE((SELECT source FROM rounds WHERE rounds.mint = snapshots.mint), 'dex');
