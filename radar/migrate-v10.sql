-- FlagKan LightGBM SHADOW challenger (Oct 12). Additive only; no light changes.
--   verdicts.p_lr_first   model-only LR P(dead_v2) at first sight (NULL when no
--                         champion was loaded). p_red_first is NOT model-only:
--                         with no champion it holds the rule/base-rate stamp.
--   verdicts.p_gbm_first  model-only LightGBM P(dead_v2) at first sight, same
--                         27-dim buildFeatures vector (NULL if scoring failed)
--   verdicts.gbm_v        LightGBM model version that produced p_gbm_first
-- Written only by first-verdict INSERTs; the upgrade UPDATE never touches them.
-- Run once against production D1 BEFORE deploying the shadow worker:
--   npx wrangler d1 execute radar-d1-main --remote --file=migrate-v10.sql
ALTER TABLE verdicts ADD COLUMN p_lr_first REAL;
ALTER TABLE verdicts ADD COLUMN p_gbm_first REAL;
ALTER TABLE verdicts ADD COLUMN gbm_v TEXT;
