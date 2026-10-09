-- FlagKan E5-3-lite: Jev sensor factors stored per verdict, reused as LR features.
-- Run once against production D1:
--   wrangler d1 execute radar-d1-main --remote --file=migrate-v4.sql
ALTER TABLE verdicts ADD COLUMN f_whale REAL;
ALTER TABLE verdicts ADD COLUMN f_sell REAL;
ALTER TABLE verdicts ADD COLUMN f_struct REAL;
