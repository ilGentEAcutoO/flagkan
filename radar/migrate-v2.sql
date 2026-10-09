-- FlagKan accuracy v2: authority flags + momentum columns.
-- Run once against production D1 (idempotent-ish: fails loudly if a column
-- already exists, which means a previous run already applied it):
--   wrangler d1 execute radar-d1-main --remote --file=migrate-v2.sql
ALTER TABLE signals ADD COLUMN mint_auth_live INTEGER;
ALTER TABLE signals ADD COLUMN freeze_auth_live INTEGER;
ALTER TABLE snapshots ADD COLUMN price_chg_h1 REAL;
ALTER TABLE snapshots ADD COLUMN vol_h1 REAL;
ALTER TABLE snapshots ADD COLUMN pair_age_min REAL;
