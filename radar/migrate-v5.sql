-- FlagKan E3-4: rug memory (dead-vector templates) + red-source audit.
-- Run once against production D1:
--   wrangler d1 execute radar-d1-main --remote --file=migrate-v5.sql
CREATE TABLE IF NOT EXISTS rug_vectors (
	mint TEXT PRIMARY KEY,
	resolved_at INTEGER NOT NULL,
	vec TEXT NOT NULL
);
ALTER TABLE verdicts ADD COLUMN red_source TEXT;
ALTER TABLE verdicts ADD COLUMN mem_dist REAL;
