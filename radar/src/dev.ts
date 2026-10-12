// DATA-001 (Oct 12): data-only collectors, called once per cron minute from
// ingest(). They NEVER touch verdicts, upgrades, outcomes or proof numbers,
// and never throw out of the cron (every failure is logged / stored in err).
import {
	LOOKS, LOOK_PICK_SQL, LOOK_INSERT_SQL, lookWindow,
	DEV_PER_RUN, DEV_RPC_PER_ROW, DEV_SIG_PAGES, SIG_PAGE, SIGNAL_RPC_PER_ROW, SOLAMI_SOFT_CAP_24H, DEV_WINDOW_MS,
	DEV_PICK_SQL, SOLAMI_EST_24H_SQL, CREATOR_HISTORY_SQL, DEV_UPSERT_SQL,
	oldestSig, parseCreateTx, ownerBalance, shareOf,
} from "./ml/collect";

export interface LookMarket {
	price: number; liq: number; fdv: number; tx5: number; buys5: number; sells5: number;
	chgH1: number | null; volH1: number | null; pairAgeMin: number | null;
}
type BatchFn = (mints: string[]) => Promise<Map<string, LookMarket>>;
type RpcFn = (method: string, params: unknown[]) => Promise<any>;

// Second-look snapshots (+15 / +30 min). ONE DexScreener batch per look per
// tick; rows tagged look=15/30 and inserted directly — never via the
// intake/refresh path, so no upgrade, verdict or outcome code runs.
export async function collectLooks(db: D1Database, batch: BatchFn, now: number): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	for (const w of LOOKS) {
		const k = "look" + w.look;
		out[k + "_want"] = 0; out[k + "_got"] = 0;
		try {
			const [from, to] = lookWindow(now, w);
			const rows = await db.prepare(LOOK_PICK_SQL).bind(from, to, w.look).all<{ mint: string }>();
			const mints = (rows.results ?? []).map((r) => r.mint);
			out[k + "_want"] = mints.length;
			if (mints.length === 0) continue;
			const markets = await batch(mints);
			const stmts: D1PreparedStatement[] = [];
			for (const mint of mints) {
				const m = markets.get(mint);
				if (!m) continue;
				stmts.push(db.prepare(LOOK_INSERT_SQL).bind(mint, now, m.price, m.liq, m.fdv, m.tx5, m.buys5, m.sells5, m.chgH1, m.volH1, m.pairAgeMin, w.look));
			}
			if (stmts.length) await db.batch(stmts);
			out[k + "_got"] = stmts.length;
		} catch (e) {
			out[k + "_err"] = 1;
			console.log(JSON.stringify({ cron: "look_fail", look: w.look, err: String(e).slice(0, 160) }));
		}
	}
	console.log(JSON.stringify({ cron: "look", ...out }));
	return out;
}

// Estimated Solami RPCs in the last 24h (signals x4 + dev_signals x4).
export async function solamiEst24h(db: D1Database, now: number): Promise<{ signals: number; dev: number; est: number }> {
	const dayAgo = now - 24 * 3600 * 1000;
	const r = await db.prepare(SOLAMI_EST_24H_SQL).bind(dayAgo, dayAgo).first<{ sig: number; dev: number }>();
	const signals = Number(r?.sig ?? 0), dev = Number(r?.dev ?? 0);
	return { signals, dev, est: signals * SIGNAL_RPC_PER_ROW + dev * DEV_RPC_PER_ROW };
}

async function devForMint(db: D1Database, rpc: RpcFn, mint: string, firstSeen: number, now: number): Promise<string | null> {
	let creator: string | null = null, createSig: string | null = null, createTs: number | null = null;
	let buySol: number | null = null, buyTok: number | null = null, shareInit: number | null = null, shareNow: number | null = null;
	let priorN: number | null = null, priorG: number | null = null, priorD: number | null = null;
	let err: string | null = null;
	try {
		// Walk back to the oldest signature (= create tx), at most DEV_SIG_PAGES pages.
		let page: any[] = [];
		let before: string | undefined;
		let os: ReturnType<typeof oldestSig> = { err: "sigs_gt_" + DEV_SIG_PAGES * SIG_PAGE };
		for (let i = 0; i < DEV_SIG_PAGES; i++) {
			const r = await rpc("getSignaturesForAddress", [mint, before ? { limit: SIG_PAGE, before } : { limit: SIG_PAGE }]);
			const prev = page;
			page = Array.isArray(r) ? r : [];
			if (page.length < SIG_PAGE) {
				// Empty continuation page: the previous full page ended exactly at the oldest.
				os = page.length === 0 && prev.length > 0 ? oldestSig(prev, Infinity) : oldestSig(page, SIG_PAGE);
				break;
			}
			before = String(page[page.length - 1]?.signature ?? "");
			if (!before) { os = { err: "no_sigs" }; break; }
		}
		if ("err" in os) err = os.err;
		else {
			createSig = os.sig; createTs = os.ts;
			const [tx, sup] = await Promise.all([
				rpc("getTransaction", [os.sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]),
				rpc("getTokenSupply", [mint]).catch(() => null),
			]);
			const f = parseCreateTx(tx, mint);
			if ("err" in f) err = f.err;
			else {
				creator = f.creator; buyTok = f.devBuyTokens; buySol = f.devBuySol;
				if (f.createTs !== null) createTs = f.createTs;
				const supply = Number(sup?.value?.uiAmountString ?? sup?.value?.uiAmount ?? NaN);
				const supplyOk = Number.isFinite(supply) && supply > 0 ? supply : null;
				if (supplyOk === null) err = "no_supply";
				shareInit = shareOf(buyTok, supplyOk);
				try {
					const bal = ownerBalance(await rpc("getTokenAccountsByOwner", [creator, { mint }, { encoding: "jsonParsed" }]));
					shareNow = shareOf(bal, supplyOk);
				} catch (e) { err = err ?? "owner_" + String(e).slice(0, 80); }
			}
		}
		if (creator) {
			const h = await db.prepare(CREATOR_HISTORY_SQL).bind(now, creator, mint, firstSeen).first<{ n: number; graded: number | null; dead: number | null }>();
			priorN = Number(h?.n ?? 0); priorG = Number(h?.graded ?? 0); priorD = Number(h?.dead ?? 0);
		}
	} catch (e) {
		err = String(e).slice(0, 160);
	}
	await db.prepare(DEV_UPSERT_SQL).bind(mint, creator, createSig, createTs, buySol, buyTok, shareInit, shareNow, priorN, priorG, priorD, err, now).run();
	return err;
}

// Dev/creator facts at first sight: <= DEV_PER_RUN coins per tick, skipped
// without a Solami key or when the 24h RPC estimate reaches the soft cap.
export async function collectDev(db: D1Database, rpc: RpcFn, hasKey: boolean, now: number): Promise<Record<string, number>> {
	const out: Record<string, number> = { dev_want: 0, dev_ok: 0, dev_err: 0 };
	try {
		if (!hasKey) { out.dev_skip_nokey = 1; return out; }
		const rows = await db.prepare(DEV_PICK_SQL).bind(now - DEV_WINDOW_MS, DEV_PER_RUN).all<{ mint: string; first_seen: number }>();
		const picks = rows.results ?? [];
		out.dev_want = picks.length;
		if (picks.length === 0) return out; // most ticks: skip the budget query too
		const est = await solamiEst24h(db, now);
		if (est.est >= SOLAMI_SOFT_CAP_24H) {
			out.dev_skip_budget = est.est;
			console.log(JSON.stringify({ cron: "dev_skip_budget", est: est.est }));
			return out;
		}
		const res = await Promise.all(picks.map((p) =>
			devForMint(db, rpc, p.mint, Number(p.first_seen), now).catch((e) => "write_" + String(e).slice(0, 60))));
		for (const r of res) { if (r) out.dev_err++; else out.dev_ok++; }
	} catch (e) {
		out.dev_fail = 1;
		console.log(JSON.stringify({ cron: "dev_fail", err: String(e).slice(0, 160) }));
	}
	console.log(JSON.stringify({ cron: "dev", ...out }));
	return out;
}

// Read-only counters for /api/cost (last 24h). Never throws.
export async function collectCounters(db: D1Database, now: number): Promise<Record<string, unknown>> {
	try {
		const dayAgo = now - 24 * 3600 * 1000;
		// Coverage over coins old enough to have had their look window.
		const lk = await db.prepare(
			"SELECT COUNT(*) AS n, "
			+ "SUM(CASE WHEN r.first_seen <= ? AND EXISTS (SELECT 1 FROM snapshots s WHERE s.mint = r.mint AND s.look = 15) THEN 1 ELSE 0 END) AS l15, "
			+ "SUM(CASE WHEN r.first_seen <= ? THEN 1 ELSE 0 END) AS n15, "
			+ "SUM(CASE WHEN r.first_seen <= ? AND EXISTS (SELECT 1 FROM snapshots s WHERE s.mint = r.mint AND s.look = 30) THEN 1 ELSE 0 END) AS l30, "
			+ "SUM(CASE WHEN r.first_seen <= ? THEN 1 ELSE 0 END) AS n30 "
			+ "FROM rounds r WHERE r.first_seen > ?"
		).bind(now - 17 * 60e3, now - 17 * 60e3, now - 32 * 60e3, now - 32 * 60e3, dayAgo).first<Record<string, number>>();
		const dv = await db.prepare(
			"SELECT COUNT(*) AS n, SUM(CASE WHEN err IS NULL THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN creator IS NOT NULL THEN 1 ELSE 0 END) AS with_creator FROM dev_signals WHERE fetched_at > ?"
		).bind(dayAgo).first<Record<string, number>>();
		const est = await solamiEst24h(db, now);
		const r3 = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
		const n15 = Number(lk?.n15 ?? 0), n30 = Number(lk?.n30 ?? 0);
		return {
			look_coverage_24h: {
				look15: { got: Number(lk?.l15 ?? 0), eligible: n15, rate: r3(Number(lk?.l15 ?? 0), n15) },
				look30: { got: Number(lk?.l30 ?? 0), eligible: n30, rate: r3(Number(lk?.l30 ?? 0), n30) },
				dex_calls_per_min_est: 2,
			},
			dev_signals_24h: { fetched: Number(dv?.n ?? 0), ok: Number(dv?.ok ?? 0), err: Number(dv?.n ?? 0) - Number(dv?.ok ?? 0), with_creator: Number(dv?.with_creator ?? 0) },
			solami_extra_rpc_24h_est: est.dev * DEV_RPC_PER_ROW,
			solami_total_rpc_24h_est: est.est,
			solami_soft_cap_24h: SOLAMI_SOFT_CAP_24H,
		};
	} catch (e) {
		return { error: String(e).slice(0, 120) };
	}
}
