-- FlagKan SWITCH-001 (Oct 12): LightGBM decides the lights, LR is the
-- automatic fallback and the head-to-head comparison (policy_v stays 2).
--   verdicts.decider  model whose first-sight P(dead_v2) drove the light:
--                     'gbm' | 'lr' | 'rule' (no model p, hard rule fired) |
--                     'base' (no model p, base-rate all-red). NULL = rows
--                     written before this migration (all LR-decided).
-- Written only by first-verdict INSERTs; the upgrade UPDATE never touches it.
-- Additive. Run once against production D1 BEFORE deploying the worker that
-- writes this column:
--   npx wrangler d1 execute radar-d1-main --remote --file=migrate-v13.sql
ALTER TABLE verdicts ADD COLUMN decider TEXT;
CREATE INDEX IF NOT EXISTS idx_verdicts_decider_ts ON verdicts (decider, ts);
