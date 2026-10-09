-- FlagKan R2-demote: stamp the first-seen rule result on every verdict so
-- forward rule precision (incl. thin-frenzy demotion) is exactly measurable
-- even though signals rows overwrite. NULL for pre-ship rows (unattributable).
-- Run once against production D1:
--   wrangler d1 execute radar-d1-main --remote --file=migrate-v8.sql
ALTER TABLE verdicts ADD COLUMN v_rule TEXT;
