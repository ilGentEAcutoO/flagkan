-- FlagKan label v2 + leak fix + policy tiers (Oct 12).
-- Additive only: legacy outcomes.dead (label v1) is untouched.
--   outcomes.dead_v2  label v2 (price -90% | same-feed liq < $1k | idle final hour); NULL = ungradeable
--   outcomes.idle     1 = no trades in the final hour, 0 = traded, NULL = unknown (stale/no sample)
--   verdicts.p_red_first  first-sight P(dead); upgrades never touch it (leak-free audit/training)
--   verdicts.tier     red_sure | red | yellow | green (final call; upgrades set 'red')
--   verdicts.policy_v 2 for policy-v2 verdicts; NULL = legacy
--   models.label_v    label version a model was trained on; champions are only
--                     loaded/compared within the current label version
-- Run once against production D1 BEFORE deploying the v2 worker:
--   wrangler d1 execute radar-d1-main --remote --file=migrate-v9.sql
ALTER TABLE outcomes ADD COLUMN dead_v2 INTEGER;
ALTER TABLE outcomes ADD COLUMN idle INTEGER;
ALTER TABLE verdicts ADD COLUMN p_red_first REAL;
ALTER TABLE verdicts ADD COLUMN tier TEXT;
ALTER TABLE verdicts ADD COLUMN policy_v INTEGER;
ALTER TABLE models ADD COLUMN label_v INTEGER;
UPDATE models SET label_v = 1 WHERE label_v IS NULL;
