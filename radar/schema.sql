CREATE TABLE IF NOT EXISTS rounds (
	mint TEXT PRIMARY KEY,
	first_seen INTEGER NOT NULL,
	pair_address TEXT,
	name TEXT,
	source TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	mint TEXT NOT NULL,
	ts INTEGER NOT NULL,
	price_usd REAL,
	liquidity_usd REAL,
	fdv REAL,
	txns_5m INTEGER,
	buys_5m INTEGER,
	sells_5m INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snap_mint_ts ON snapshots (mint, ts);
CREATE TABLE IF NOT EXISTS verdicts (
	mint TEXT PRIMARY KEY,
	ts INTEGER NOT NULL,
	choice TEXT NOT NULL,
	confidence REAL NOT NULL,
	p_red REAL,
	p_yellow REAL,
	p_green REAL,
	coordinated REAL,
	severity REAL
);
CREATE TABLE IF NOT EXISTS signals (
	mint TEXT PRIMARY KEY,
	ts INTEGER NOT NULL,
	top1_pct REAL,
	top10_pct REAL,
	top2_11_pct REAL,
	pool_suspect INTEGER,
	early_buys INTEGER,
	mint_age_min REAL
);
CREATE TABLE IF NOT EXISTS outcomes (
	mint TEXT PRIMARY KEY,
	resolved_at INTEGER NOT NULL,
	first_price REAL,
	last_price REAL,
	mult REAL,
	dead INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
	version INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at INTEGER NOT NULL,
	weights TEXT NOT NULL,
	bias REAL NOT NULL,
	features TEXT NOT NULL,
	n_train INTEGER NOT NULL,
	test_acc REAL,
	test_n INTEGER,
	champ_acc REAL,
	promoted INTEGER NOT NULL DEFAULT 0
);
