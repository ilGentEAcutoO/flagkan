// LIVE-001 pure helpers (no Workers runtime imports) so ml-check.mjs can
// compile and unit-test them in plain node. The Durable Object lives in
// live.ts; the Worker wiring lives in index.ts.

/** Browser origins allowed to open /api/live (cross-site abuse guard). */
export const LIVE_ORIGINS: readonly string[] = ["flag.sornkan.com", "radar-worker-api.sornkan.workers.dev"];
/** Max rows carried by one tick (keeps a push small; extra coins wait for the next tick / REST). */
export const TICK_MAX_ROWS = 60;
/** Hard byte cap for one pushed frame; rows are dropped from the tail until it fits. */
export const TICK_MAX_BYTES = 32 * 1024;
/** Max inbound client frame we even look at (viewers only ever send "ping"). */
export const LIVE_MAX_IN_BYTES = 64;
/** Concurrent socket cap on the single global LiveFeed; over it: accept-then-close 4429. */
export const LIVE_MAX_SOCKETS = 300;
/** Concurrent sockets per client IP (tagged by a short IP hash). */
export const LIVE_MAX_PER_IP = 3;
/** Legacy keepalive words. Clients send NOTHING now (server heartbeat instead);
 *  a stray "ping" is still answered "pong", but only after it is counted. */
export const LIVE_PING = "ping";
export const LIVE_PONG = "pong";
/** Client watchdog: no frame (tick or hb) for this long -> reconnect. */
export const LIVE_WATCHDOG_MS = 150_000;
/** Cron skips the RPC when the stash says 0 sockets AND the last connect is older than this. */
export const LIVE_IDLE_SKIP_MS = 5 * 60_000;
/** A stored tick older than this is NOT replayed to a fresh connect (would overwrite fresher REST rows). */
export const LIVE_REPLAY_MAX_AGE_MS = 120_000;
/** Close code used for every "go away, poll instead" refusal (caps, budget). */
export const LIVE_CLOSE_REFUSED = 4429;

// --- worst-case monthly cost (Workers Paid includes 1,000,000 DO requests
// and 400,000 GB-s per month) ---------------------------------------------
// Requests:
//   broadcasts  <= 1 per cron minute = 30 d x 1,440 = 43,200 (31 d: 44,640)
//   upgrades: counted at 3 requests EACH (LIVE_COST.upgrade = 60 units):
//     1 for the upgrade + pre-paid 1 for its webSocketClose + 1 for a
//     possible webSocketError, so the bound holds even if both events bill.
//   client frames bill at 20:1 and are counted at 1/20 EACH, pings included
//     (no auto-response: every frame reaches webSocketMessage and is counted).
//   At 800,000 counted the DO refuses everything and closes all sockets; the
//     Worker stops calling it (in-isolate overUntil -> cached D1 stash, and
//     FAILS CLOSED with 503 when the stash cannot be read); cron skips the RPC.
//   Clients send no keepalive at all (server heartbeat), so idle viewers
//     cost nothing but the 1/min broadcast.
//   total <= 800,000 + 44,640 = 844,640 < 1,000,000 (the broadcasts are also
//     inside the 800k counter, so this double-counts them on purpose).
// DO SQLite storage row writes (Paid includes 50,000,000/month):
//   one budget row write per counted event, none once over the line;
//   the most events is 16,000,000 (all 1-unit client frames) + 44,640
//   broadcasts x 3 rows (budget + last + last_at) = 16,133,920 < 50,000,000.
// Duration: exactly ONE instance exists (idFromName("global"), only path);
//   even awake every second of a month at the 128 MB billing size:
//   31 d x 86,400 s x 0.125 GB = 334,800 GB-s < 400,000 (30 d: 324,000).

// --- monthly DO budget kill-switch -------------------------------------
// Accounting unit = 1/20 of a billed DO request (incoming WS messages bill
// at 20:1), kept integral so no float drift. Upgrade attempt = 20 units,
// broadcast RPC = 20, non-ping client frame = 1.
export const LIVE_UNITS_PER_REQUEST = 20;
export const LIVE_MONTH_BUDGET_REQ = 800_000;
export const LIVE_MONTH_BUDGET_UNITS = LIVE_MONTH_BUDGET_REQ * LIVE_UNITS_PER_REQUEST;
export const LIVE_COST = { upgrade: 60, broadcast: 20, clientMsg: 1 } as const; // upgrade pre-pays its close + error events

export interface LiveBudget { month: string; units: number }

/** UTC month key, e.g. "2026-10". */
export function monthKey(ts: number): string {
	const d = new Date(ts);
	return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

/** Add units for an event at `now`; a new UTC month starts from zero. Pure. */
export function budgetAdd(b: LiveBudget | null | undefined, now: number, units: number): LiveBudget {
	const m = monthKey(now);
	const base = b && b.month === m && Number.isFinite(b.units) ? b.units : 0;
	return { month: m, units: base + Math.max(0, Math.floor(units)) };
}

/** True once this month's spend is past the kill-switch line. */
export function budgetOver(b: LiveBudget | null | undefined, now: number): boolean {
	return !!b && b.month === monthKey(now) && b.units > LIVE_MONTH_BUDGET_UNITS;
}

/** Heartbeat frame the cron pushes when nothing changed (server-side keepalive). */
export function heartbeatEvent(ts: number): { type: "hb"; ts: number } {
	return { type: "hb", ts: Math.floor(Number(ts) || Date.now()) };
}

/**
 * Cron gate for the per-minute RPC: skip when the last broadcast reported 0
 * sockets AND nobody connected in the last LIVE_IDLE_SKIP_MS (the Worker
 * stamps last_connect on every successful upgrade, so a new viewer re-arms
 * it). No stash yet (first run) = broadcast.
 */
export function shouldBroadcast(stash: { sockets?: unknown; last_connect?: unknown } | null | undefined, now: number): boolean {
	if (!stash) return true;
	const socks = Number(stash.sockets);
	if (!Number.isFinite(socks) || socks > 0) return true;
	const lc = Number(stash.last_connect);
	return Number.isFinite(lc) && lc > 0 && now - lc <= LIVE_IDLE_SKIP_MS;
}

/** First ms of the next UTC month (how long a budget trip stays tripped). */
export function monthEndMs(now: number): number {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** D1 error that only means "the worker never wrote the stash yet" (safe = not over). */
export function isNoTableError(e: unknown): boolean {
	return /no such table/i.test(String((e as { message?: unknown })?.message ?? e));
}

/** Worker-side view of the stashed state row: over only if it is THIS month's row. */
export function stashOver(row: { month?: unknown; over?: unknown } | null | undefined, now: number): boolean {
	return !!row && row.month === monthKey(now) && Number(row.over) === 1;
}

/**
 * Origin gate for the WebSocket upgrade. Absent Origin = non-browser client
 * (curl / node test) and is allowed; browsers always send Origin on WS.
 * localhost origins are allowed only when the request itself is local
 * (wrangler dev), never against production hosts.
 */
export function originAllowed(origin: string | null | undefined, requestHost?: string | null): boolean {
	if (origin == null || origin === "") return true;
	let u: URL;
	try { u = new URL(origin); } catch { return false; }
	const host = u.hostname.toLowerCase();
	if (u.protocol === "https:" && LIVE_ORIGINS.includes(host) && (u.port === "" || u.port === "443")) return true;
	const local = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
	const reqHost = String(requestHost ?? "").toLowerCase().replace(/:\d+$/, "");
	if ((u.protocol === "http:" || u.protocol === "https:") && local(host) && local(reqHost)) return true;
	return false;
}

/** Fields of /api/proof the pages render live (headline / legacy / challenger / decider + legacy top line). */
export const PROOF_LIVE_KEYS: readonly string[] = [
	"resolved_with_verdict", "correct", "accuracy", "red_precision",
	"label", "label_def", "headline", "v2_history_regrade", "legacy_v1", "challenger", "decider",
];

/** Pick the small live summary out of a full (or core) proof object. */
export function proofSummaryOf(full: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
	if (!full || typeof full !== "object") return undefined;
	const out: Record<string, unknown> = {};
	for (const k of PROOF_LIVE_KEYS) if (k in full) out[k] = full[k];
	return out;
}

export interface TickInput {
	ts: number;
	rows: Array<Record<string, unknown>>;
	total: number | null;
	proof?: Record<string, unknown> | null;
	maxRows?: number;
	maxBytes?: number;
}
export interface TickEvent {
	type: "tick";
	ts: number;
	rounds: Array<Record<string, unknown>>;
	proof?: Record<string, unknown>;
	total?: number;
}

/**
 * Build ONE compact tick event, or null when nothing worth pushing changed.
 * Rows keep the exact /api/rounds row shape; deduped by mint (first wins),
 * capped by count and then by serialized size.
 */
export function buildTickEvent(inp: TickInput): TickEvent | null {
	const maxRows = Math.max(0, inp.maxRows ?? TICK_MAX_ROWS);
	const maxBytes = Math.max(256, inp.maxBytes ?? TICK_MAX_BYTES);
	const seen = new Set<string>();
	const rounds: Array<Record<string, unknown>> = [];
	for (const r of inp.rows ?? []) {
		const m = r && typeof r.mint === "string" ? r.mint : "";
		if (!m || seen.has(m)) continue;
		seen.add(m);
		rounds.push(r);
		if (rounds.length >= maxRows) break;
	}
	const proof = inp.proof && typeof inp.proof === "object" ? inp.proof : undefined;
	if (rounds.length === 0 && !proof) return null;
	const evt: TickEvent = { type: "tick", ts: Math.floor(Number(inp.ts) || Date.now()), rounds };
	if (proof) evt.proof = proof;
	if (typeof inp.total === "number" && Number.isFinite(inp.total)) evt.total = inp.total;
	while (evt.rounds.length > 0 && JSON.stringify(evt).length > maxBytes) evt.rounds.pop();
	if (JSON.stringify(evt).length > maxBytes) delete evt.proof; // pathological proof size: rows-only beats nothing
	if (evt.rounds.length === 0 && !evt.proof) return null;
	return evt;
}

/**
 * Per-run "touched coins" collector. prio 0 = new round / verdict / upgrade /
 * outcome; prio 1 = price/liquidity refresh only. pick() returns prio-0 first.
 */
export class TouchSet {
	private hi = new Set<string>();
	private lo = new Set<string>();
	add(mint: string, prio: 0 | 1 = 1): void {
		if (!mint) return;
		if (prio === 0) { this.hi.add(mint); this.lo.delete(mint); }
		else if (!this.hi.has(mint)) this.lo.add(mint);
	}
	get size(): number { return this.hi.size + this.lo.size; }
	pick(max: number): string[] {
		const out: string[] = [];
		for (const m of this.hi) { if (out.length >= max) return out; out.push(m); }
		for (const m of this.lo) { if (out.length >= max) return out; out.push(m); }
		return out;
	}
}
