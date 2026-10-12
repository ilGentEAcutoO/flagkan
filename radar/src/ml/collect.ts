// DATA-001 (Oct 12): pure helpers for the data-only collectors in src/dev.ts.
// Nothing here feeds a light, verdict, upgrade, outcome label or proof number.
// Unit-tested in ml-check.mjs (fixtures + node:sqlite).
//
// 1. Second-look snapshots: +15 / +30 min after first sight, tagged
//    snapshots.look = 15 / 30. Every label/upgrade/refresh selection filters
//    `look IS NULL`, so labels are computed exactly as before.
// 2. Dev/creator signals at first sight (dev_signals table).

// ---------------------------------------------------------------------------
// Label isolation: the ONLY snapshot selections outcome resolution uses.
// index.ts resolves with these constants; ml-check runs them in node:sqlite
// with look samples present and proves they are ignored.
export const RESOLVE_FIRST_SQL =
	"SELECT ts, price_usd AS p, liquidity_usd AS l, txns_5m AS t, vol_h1 AS v, feed FROM snapshots WHERE mint = ? AND look IS NULL ORDER BY ts ASC LIMIT 1";
export const RESOLVE_LAST_SQL =
	"SELECT ts, price_usd AS p, liquidity_usd AS l, txns_5m AS t, vol_h1 AS v, feed FROM snapshots WHERE mint = ? AND look IS NULL ORDER BY ts DESC LIMIT 1";
export const RESOLVE_PRIOR_SQL =
	"SELECT ts, price_usd AS p FROM snapshots WHERE mint = ? AND look IS NULL AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1";

// ---------------------------------------------------------------------------
// Second look. A coin's first_seen sits inside each 2-minute window for 2-3
// consecutive minutely ticks, so a round's burst (<= ~35 coins sharing one
// first_seen) fits in <= 2 batches of 30. Retries are implicit: a coin that
// got no market this tick is picked again next tick while still in window.
export const LOOKS = [
	{ look: 15, fromAgoMs: 16 * 60 * 1000, toAgoMs: 14 * 60 * 1000 },
	{ look: 30, fromAgoMs: 31 * 60 * 1000, toAgoMs: 29 * 60 * 1000 },
] as const;
export const LOOK_BATCH = 30; // one DexScreener batch call per look per tick

export const LOOK_PICK_SQL =
	"SELECT r.mint AS mint FROM rounds r WHERE r.first_seen >= ? AND r.first_seen <= ? "
	+ "AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.mint = r.mint AND s.look = ?) "
	+ "ORDER BY r.first_seen ASC, r.mint ASC LIMIT " + LOOK_BATCH;

export const LOOK_INSERT_SQL =
	"INSERT INTO snapshots (mint, ts, price_usd, liquidity_usd, fdv, txns_5m, buys_5m, sells_5m, price_chg_h1, vol_h1, pair_age_min, feed, look) "
	+ "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dex', ?)";

export function lookWindow(now: number, w: { fromAgoMs: number; toAgoMs: number }): [number, number] {
	return [now - w.fromAgoMs, now - w.toAgoMs];
}

// ---------------------------------------------------------------------------
// Dev / creator signals.
export const DEV_PER_RUN = 10;
// Graduated pump coins often arrive with > 1000 signatures (sample of 12
// recent pump mints: 8 fit one page, 1 needed 4, 3 needed > 5). Walk back at
// most DEV_SIG_PAGES pages; beyond that the create tx is marked unknown.
export const DEV_SIG_PAGES = 5;
export const SIG_PAGE = 1000;
// Upper bound per dev_signals row: DEV_SIG_PAGES x getSignaturesForAddress
// + getTransaction + getTokenSupply + getTokenAccountsByOwner. Typical is
// ~5 (most coins fit one page); the budget estimate uses this worst case.
export const DEV_RPC_PER_ROW = DEV_SIG_PAGES + 3;
export const SIGNAL_RPC_PER_ROW = 4; // computeSignals in index.ts
// Soft kill-switch below the /api/cost 50k/day solami_volume alert.
export const SOLAMI_SOFT_CAP_24H = 40000;
export const DEV_WINDOW_MS = 10 * 60 * 1000; // "first sight" = first 10 min

// pump.fun-style mints first, then the rest, FIFO inside the first-sight window.
export const DEV_PICK_SQL =
	"SELECT r.mint AS mint, r.first_seen AS first_seen FROM rounds r LEFT JOIN dev_signals d ON d.mint = r.mint "
	+ "WHERE d.mint IS NULL AND r.first_seen > ? ORDER BY (CASE WHEN r.mint LIKE '%pump' THEN 0 ELSE 1 END) ASC, r.first_seen ASC LIMIT ?";

export const SOLAMI_EST_24H_SQL =
	"SELECT (SELECT COUNT(*) FROM signals WHERE ts > ?) AS sig, (SELECT COUNT(*) FROM dev_signals WHERE fetched_at > ?) AS dev";

// Creator history from OUR OWN DB, strictly prior and leak-free: only coins
// by the same creator first seen BEFORE this one, and only outcomes already
// resolved at fetch time (resolved_at <= now). Bind: now, creator, mint, first_seen.
export const CREATOR_HISTORY_SQL =
	"SELECT COUNT(*) AS n, "
	+ "SUM(CASE WHEN o.dead_v2 IS NOT NULL THEN 1 ELSE 0 END) AS graded, "
	+ "SUM(CASE WHEN o.dead_v2 = 1 THEN 1 ELSE 0 END) AS dead "
	+ "FROM dev_signals d JOIN rounds r ON r.mint = d.mint "
	+ "LEFT JOIN outcomes o ON o.mint = d.mint AND o.resolved_at <= ? "
	+ "WHERE d.creator = ? AND d.mint != ? AND r.first_seen < ?";

export const DEV_UPSERT_SQL =
	"INSERT OR REPLACE INTO dev_signals (mint, creator, create_sig, create_ts, dev_buy_sol, dev_buy_tokens, dev_share_initial, dev_share_now, creator_prior_n, creator_prior_graded, creator_prior_dead, err, fetched_at) "
	+ "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const fin = (v: unknown): number | null => {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) ? n : null;
};

// Oldest signature of the mint = its create tx. getSignaturesForAddress
// returns newest first; a full page (>= limit) means history is truncated
// and the create tx is unknown.
export function oldestSig(sigs: unknown, limit = 1000): { sig: string; ts: number | null } | { err: string } {
	if (!Array.isArray(sigs) || sigs.length === 0) return { err: "no_sigs" };
	if (sigs.length >= limit) return { err: "sigs_ge_" + limit };
	const o = sigs[sigs.length - 1] as any;
	const sig = typeof o?.signature === "string" ? o.signature : "";
	if (!sig) return { err: "no_sigs" };
	const bt = fin(o?.blockTime);
	return { sig, ts: bt !== null ? bt * 1000 : null };
}

function uiAmt(tb: any): number {
	const ui = tb?.uiTokenAmount;
	const s = fin(ui?.uiAmountString);
	if (s !== null) return s;
	const u = fin(ui?.uiAmount);
	return u ?? 0;
}

export interface CreateTxFacts {
	creator: string;
	createTs: number | null; // ms
	devBuyTokens: number;    // creator's post - pre balance of this mint (ui units)
	devBuySol: number | null; // creator's SOL out, fee excluded (see note)
}

// Parse a getTransaction(sig, {encoding: "jsonParsed", maxSupportedTransactionVersion: 0})
// result. creator = fee payer (first signer, accountKeys[0]).
// devBuySol = (pre - post lamports of the fee payer - fee) / 1e9. APPROXIMATE:
// on pump.fun create+buy it also includes rent for the new mint / curve /
// ATA accounts (~0.02 SOL) and any platform/creator fee legs.
export function parseCreateTx(tx: any, mint: string): CreateTxFacts | { err: string } {
	if (!tx || typeof tx !== "object") return { err: "tx_missing" };
	const keys: any[] = Array.isArray(tx?.transaction?.message?.accountKeys) ? tx.transaction.message.accountKeys : [];
	if (keys.length === 0) return { err: "tx_no_keys" };
	const k0 = keys[0];
	const creator = typeof k0 === "string" ? k0 : typeof k0?.pubkey === "string" ? k0.pubkey : "";
	if (!creator) return { err: "tx_no_payer" };
	const meta = tx.meta ?? {};
	const sumFor = (arr: unknown) => (Array.isArray(arr) ? arr : [])
		.filter((b: any) => b?.mint === mint && b?.owner === creator)
		.reduce((s: number, b: any) => s + uiAmt(b), 0);
	const devBuyTokens = sumFor(meta.postTokenBalances) - sumFor(meta.preTokenBalances);
	const pre0 = fin(Array.isArray(meta.preBalances) ? meta.preBalances[0] : null);
	const post0 = fin(Array.isArray(meta.postBalances) ? meta.postBalances[0] : null);
	const fee = fin(meta.fee) ?? 0;
	const devBuySol = pre0 !== null && post0 !== null ? Math.round((pre0 - post0 - fee)) / 1e9 : null;
	const bt = fin(tx.blockTime);
	return { creator, createTs: bt !== null ? bt * 1000 : null, devBuyTokens, devBuySol };
}

// getTokenAccountsByOwner(owner, {mint}, {encoding: "jsonParsed"}) -> total ui balance.
export function ownerBalance(res: any): number | null {
	const v = res?.value;
	if (!Array.isArray(v)) return null;
	let s = 0;
	for (const a of v) s += fin(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString) ?? fin(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount) ?? 0;
	return s;
}

export function shareOf(tokens: number | null, supply: number | null): number | null {
	if (tokens === null || supply === null || !(supply > 0)) return null;
	return Math.round((tokens / supply) * 1e6) / 1e6;
}

// Per-run concurrency for dev lookups: DEV_PER_RUN mints, at most this many
// in flight, so intake's own signal calls are not starved.
export const DEV_CONCURRENCY = 3;

// True when an RPC error looks like an HTTP 429 / rate limit.
export function isRateLimited(e: unknown): boolean {
	const s = String((e as any)?.message ?? e ?? "");
	return /\b429\b/.test(s) || /rate[ _-]?limit|too many requests/i.test(s);
}

// Tiny promise pool: runs fn over items with at most `limit` in flight and
// starts no new item once stop() is true. Skipped items stay undefined.
export async function runPool<T, R>(
	items: T[], limit: number, fn: (item: T) => Promise<R>, stop: () => boolean = () => false
): Promise<{ results: (R | undefined)[]; started: number; skipped: number }> {
	const results: (R | undefined)[] = new Array(items.length).fill(undefined);
	let next = 0, started = 0;
	const worker = async () => {
		while (next < items.length && !stop()) {
			const i = next++;
			started++;
			results[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return { results, started, skipped: items.length - started };
}
