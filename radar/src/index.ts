interface Env {
	DB_MAIN: D1Database;
	ASSETS: Fetcher;
	TYPESAFE_API_KEY: string;
	SOLAMI_API_KEY: string;
	ADMIN_KEY: string;
}

import { hardRed, timeSplitValidate, predict, buildFeatures, DEFAULT_MODEL, FEATURES } from "./ml/train";
import type { GoldModel, TrainRow } from "./ml/train";

const DEX = "https://api.dexscreener.com";
const UA = { "User-Agent": "Mozilla/5.0 (radar proof-of-concept)" };
const MAX_MINTS = 20;
const MAX_VERDICTS_PER_DAY = 50;
const RESOLVE_AFTER_MS = 6 * 3600 * 1000;
const BOARD_RETENTION_MS = 7 * 24 * 3600 * 1000;

async function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function jget(url: string, tries = 3): Promise<any> {
	let last = "";
	for (let i = 0; i < tries; i++) {
		const r = await fetch(url, { headers: UA });
		if (r.ok) return r.json();
		last = "dex " + r.status + " " + url.slice(0, 80);
		if (r.status !== 429 && r.status < 500) throw new Error(last);
		await sleep(500 * 2 ** i + Math.random() * 300);
	}
	throw new Error(last);
}

async function jevVerdict(env: Env, state: Record<string, unknown>): Promise<any> {
	const key = (env.TYPESAFE_API_KEY || "").trim();
	const r = await fetch("https://api.typesafe.ai/v1/systemone", {
		method: "POST",
		headers: {
			Authorization: "Bearer " + key,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "jev-latest",
			state,
			questions: {
				verdict: {
					type: "choice",
					instructions: "Which risk light fits this Solana token: yellow or green? RED is handled by a separate rules layer — never output red. Judge strictly by the numbers in state. A high top1_pct alone is NOT alarming: several coins with top1 over 70 survived.",
					criteria: {
						yellow: "Caution, watch closely: the default for new coins. Any doubt, any missing holder data, or any single warning sign means yellow. High sell pressure (sell_ratio_5m over 0.7) means yellow.",
						green: "Looks acceptable: ONLY when ALL of these hold at once: top1_pct under 15, top2_11_pct under 40, liquidity_usd over 100000, mint_age_min over 15, sell_ratio_5m under 0.6. If holder data (top1_pct) is missing, never green.",
					},
				},
				coordinated: {
					type: "noul",
					instructions: "Do the signals suggest coordinated wallets or bot activity?",
				},
				severity: {
					type: "score",
					instructions: "How severe is the risk?",
					criteria: ["Low risk", "Medium risk", "High risk", "Extreme risk"],
				},
			},
		}),
	});
	if (!r.ok) throw new Error("jev " + r.status);
	return ((await r.json()) as any).answers;
}

function applyVerdictOverride(a: any, vstate: Record<string, unknown>, mint: string, tag: string): void {
	const rule = hardRed(vstate);
	const llm = String(a.verdict?.choice ?? "yellow");
	if (rule) {
		a.verdict = {
			...(a.verdict ?? {}),
			choice: "red",
			confidence: 0.95,
			probabilities: { red: 0.95, yellow: 0.05, green: 0 },
		};
		console.log(JSON.stringify({ [tag]: "hard_red", mint, rule }));
	} else if (llm === "red") {
		a.verdict = { ...(a.verdict ?? {}), choice: "yellow" };
		console.log(JSON.stringify({ [tag]: "red_demoted", mint }));
	} else if (llm !== "green" && llm !== "yellow") {
		a.verdict = { ...(a.verdict ?? {}), choice: "yellow" };
	}
}

function numOrNull(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function loadChampion(env: Env): Promise<{ model: GoldModel; version: number } | null> {
	const row = await env.DB_MAIN.prepare(
		"SELECT version, weights, bias FROM models WHERE promoted = 1 ORDER BY version DESC LIMIT 1"
	).first<{ version: number; weights: string; bias: number }>();
	if (!row) return null;
	try {
		const w = JSON.parse(row.weights);
		if (!Array.isArray(w) || w.length !== FEATURES.length) return null;
		return { model: { weights: w.map(Number), bias: Number(row.bias), features: [...FEATURES] }, version: Number(row.version) };
	} catch { return null; }
}

async function maybeDemoteGreen(env: Env, a: any, vstate: Record<string, unknown>, mint: string, tag: string): Promise<void> {
	if (String(a.verdict?.choice ?? "") !== "green") return;
	try {
		const champ = await loadChampion(env);
		const m = champ ? champ.model : DEFAULT_MODEL;
		const txns = Number(vstate.txns_5m ?? 0);
		const ratio = Number(vstate.sell_ratio_5m ?? 0.5);
		const row: TrainRow = {
			ts: Date.now(), dead: 0, choice: "green",
			liq: numOrNull(vstate.liquidity_usd), top1: numOrNull(vstate.top1_pct),
			t211: numOrNull(vstate.top2_11_pct), fdv: numOrNull(vstate.fdv),
			early: numOrNull(vstate.early_buys), age: numOrNull(vstate.mint_age_min),
			txns: Number.isFinite(txns) ? txns : null,
			buys: Math.round((1 - ratio) * Math.max(0, txns)), sells: Math.round(ratio * Math.max(0, txns)),
			pool: numOrNull(vstate.pool_suspect), pRed: Number(a.verdict?.probabilities?.red ?? 0.5),
		};
		if (predict(m, buildFeatures(row)) >= 0.5) {
			a.verdict = { ...(a.verdict ?? {}), choice: "yellow" };
			console.log(JSON.stringify({ [tag]: "green_gated", mint }));
		}
	} catch { /* gate open on error: keep LLM green */ }
}

async function retrain(env: Env, dryRun: boolean): Promise<Record<string, unknown>> {
	const now = Date.now();
	const qr = await env.DB_MAIN.prepare(
		"SELECT v.ts AS ts, o.dead AS dead, v.choice AS choice, "
		+ "(SELECT liquidity_usd FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS liq, "
		+ "(SELECT fdv FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS fdv, "
		+ "(SELECT txns_5m FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS txns, "
		+ "(SELECT buys_5m FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS buys, "
		+ "(SELECT sells_5m FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS sells, "
		+ "g.top1_pct AS top1, g.top2_11_pct AS t211, g.early_buys AS early, g.mint_age_min AS age, "
		+ "g.pool_suspect AS pool, v.p_red AS pRed FROM verdicts v "
		+ "JOIN outcomes o ON o.mint = v.mint LEFT JOIN signals g ON g.mint = v.mint "
		+ "ORDER BY v.ts DESC LIMIT 5000"
	).all<any>();
	const rows: TrainRow[] = (qr.results ?? []).map((r: any) => ({
		ts: Number(r.ts), dead: Number(r.dead) === 1 ? 1 : 0, choice: String(r.choice ?? "yellow"),
		liq: numOrNull(r.liq), top1: numOrNull(r.top1), t211: numOrNull(r.t211), fdv: numOrNull(r.fdv),
		early: numOrNull(r.early), age: numOrNull(r.age), txns: numOrNull(r.txns),
		buys: numOrNull(r.buys), sells: numOrNull(r.sells), pool: numOrNull(r.pool), pRed: numOrNull(r.pRed),
	}));
	if (rows.length < 30) return { ok: false, reason: "not_enough_data", n: rows.length };
	const res = timeSplitValidate(rows);
	const out: Record<string, unknown> = { ok: true, dryRun, n: res.n, nTrain: res.nTrain, nTest: res.nTest, champAcc: res.champAcc, chalAcc: res.chalAcc, promoted: false, version: null };
	if (!dryRun && res.chalAcc != null && res.champAcc != null && res.chalAcc > res.champAcc) {
		await env.DB_MAIN.prepare("UPDATE models SET promoted = 0 WHERE promoted = 1").run();
		const ins = await env.DB_MAIN.prepare(
			"INSERT INTO models (created_at, weights, bias, features, n_train, test_acc, test_n, champ_acc, promoted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
		).bind(now, JSON.stringify(res.model.weights), res.model.bias, JSON.stringify(res.model.features), res.nTrain, res.chalAcc, res.nTest, res.champAcc).run();
		out.promoted = true;
		out.version = Number((ins.meta as any)?.last_row_id ?? 0);
	}
	console.log(JSON.stringify({ cron: "retrain", n: res.n, champAcc: res.champAcc, chalAcc: res.chalAcc, promoted: out.promoted }));
	return out;
}

async function solamiRpc(env: Env, method: string, params: unknown[]): Promise<any> {
	const key = (env.SOLAMI_API_KEY || "").trim();
	const r = await fetch("https://rpc.solami.dev/sol?api_key=" + key, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	if (!r.ok) throw new Error("solami " + r.status);
	const j: any = await r.json();
	if (j.error) throw new Error("solami " + JSON.stringify(j.error).slice(0, 120));
	return j.result;
}

async function computeSignals(
	env: Env,
	mint: string
): Promise<{
	top1_pct: number;
	top10_pct: number;
	top2_11_pct: number;
	pool_suspect: number;
	early_buys: number;
	mint_age_min: number;
}> {
	const [supplyR, largeR, sigsR] = await Promise.all([
		solamiRpc(env, "getTokenSupply", [mint]),
		solamiRpc(env, "getTokenLargestAccounts", [mint]),
		solamiRpc(env, "getSignaturesForAddress", [mint, { limit: 1000 }]),
	]);
	const supply = Number(supplyR?.value?.uiAmount ?? 0);
	const tops: Array<{ uiAmountString?: string }> = Array.isArray(largeR?.value) ? largeR.value : [];
	const amts = tops.map((t) => Number(t?.uiAmountString ?? 0));
	const top1 = supply > 0 ? ((amts[0] ?? 0) / supply) * 100 : 0;
	const top10 = supply > 0 ? (amts.slice(0, 10).reduce((a, b) => a + b, 0) / supply) * 100 : 0;
	const top2_11 = supply > 0 ? (amts.slice(1, 11).reduce((a, b) => a + b, 0) / supply) * 100 : 0;
	const poolSuspect = top1 > 50 ? 1 : 0;
	const times: number[] = (Array.isArray(sigsR) ? sigsR : [])
		.map((s) => Number(s?.blockTime ?? 0))
		.filter((t) => t > 0);
	const oldest = times.length ? Math.min(...times) : 0;
	const early = oldest ? times.filter((t) => t <= oldest + 60).length : 0;
	const age = oldest ? (Date.now() / 1000 - oldest) / 60 : 0;
	const r2 = (n: number) => Math.round(n * 100) / 100;
	return {
		top1_pct: r2(top1),
		top10_pct: r2(top10),
		top2_11_pct: r2(top2_11),
		pool_suspect: poolSuspect,
		early_buys: early,
		mint_age_min: r2(age),
	};
}

function pickPair(pairs: any[]): any | null {
	if (!Array.isArray(pairs) || pairs.length === 0) return null;
	let best = pairs[0];
	let bestLiq = Number(best?.liquidity?.usd ?? 0);
	for (const p of pairs) {
		const liq = Number(p?.liquidity?.usd ?? 0);
		if (liq > bestLiq) {
			best = p;
			bestLiq = liq;
		}
	}
	return best;
}

async function snapshotMint(
	env: Env,
	mint: string,
	now: number,
	doVerdict: { budget: number }
): Promise<"snap" | "skip" | "fail"> {
	try {
		const pairs = await jget(DEX + "/tokens/v1/solana/" + mint);
		const p = pickPair(pairs);
		if (!p) return "skip";
		const price = Number(p.priceUsd ?? 0);
		const liq = Number(p.liquidity?.usd ?? 0);
		const fdv = Number(p.fdv ?? 0);
		const buys5 = Number(p.txns?.m5?.buys ?? 0);
		const sells5 = Number(p.txns?.m5?.sells ?? 0);
		const tx5 = buys5 + sells5;
		const sellRatio = sells5 / Math.max(1, tx5);
		const name = String(p.baseToken?.name ?? "").slice(0, 80);
		const pair = String(p.pairAddress ?? "");

		const seen = await env.DB_MAIN.prepare("SELECT mint FROM rounds WHERE mint = ?")
			.bind(mint)
			.first();
		if (!seen) {
			await env.DB_MAIN.prepare(
				"INSERT INTO rounds (mint, first_seen, pair_address, name) VALUES (?, ?, ?, ?)"
			)
				.bind(mint, now, pair, name)
				.run();
			if (doVerdict.budget > 0 && env.TYPESAFE_API_KEY) {
				try {
					let sig: Record<string, number> = {};
					try {
						const s = await computeSignals(env, mint);
						sig = s as unknown as Record<string, number>;
						await env.DB_MAIN.prepare(
							"INSERT OR REPLACE INTO signals (mint, ts, top1_pct, top10_pct, top2_11_pct, pool_suspect, early_buys, mint_age_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
						)
							.bind(mint, now, s.top1_pct, s.top10_pct, s.top2_11_pct, s.pool_suspect, s.early_buys, s.mint_age_min)
							.run();
					} catch (e) {
						console.log(JSON.stringify({ cron: "signals_fail", mint, err: String(e).slice(0, 120) }));
					}
					const vstate = {
						mint,
						price_usd: price,
						liquidity_usd: liq,
						fdv,
						txns_5m: tx5,
						sell_ratio_5m: sellRatio,
						...sig,
					};
					const a = await jevVerdict(env, vstate);
					applyVerdictOverride(a, vstate, mint, "cron");
					await maybeDemoteGreen(env, a, vstate, mint, "cron");
					await env.DB_MAIN.prepare(
						"INSERT OR REPLACE INTO verdicts (mint, ts, choice, confidence, p_red, p_yellow, p_green, coordinated, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
					)
						.bind(
							mint,
							now,
							String(a.verdict?.choice ?? "yellow"),
							Number(a.verdict?.confidence ?? 0),
							Number(a.verdict?.probabilities?.red ?? 0),
							Number(a.verdict?.probabilities?.yellow ?? 0),
							Number(a.verdict?.probabilities?.green ?? 0),
							Number(a.coordinated?.noul ?? 0),
							Number(a.severity?.score ?? 0)
						)
						.run();
					doVerdict.budget--;
				} catch (e) {
					console.log(JSON.stringify({ cron: "verdict_fail", mint, err: String(e).slice(0, 120) }));
				}
			}
		}
		await env.DB_MAIN.prepare(
			"INSERT INTO snapshots (mint, ts, price_usd, liquidity_usd, fdv, txns_5m, buys_5m, sells_5m) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
		)
			.bind(mint, now, price, liq, fdv, tx5, buys5, sells5)
			.run();
		return "snap";
	} catch (e) {
		console.log(JSON.stringify({ cron: "mint_fail", mint, err: String(e).slice(0, 120) }));
		return "fail";
	}
}

async function ingest(env: Env, forceRefresh = false): Promise<Record<string, number>> {
	const now = Date.now();
	const stats = { mints: 0, snapshots: 0, verdicts: 0, resolved: 0, errors: 0, refreshed: 0 };
	const fullRound = forceRefresh || new Date(now).getUTCMinutes() % 5 === 0;
	let mints: string[] = [];
	if (fullRound) {
		try {
			const boosts = await jget(DEX + "/token-boosts/top/v1");
			mints = (Array.isArray(boosts) ? boosts : [])
				.filter((b) => b?.chainId === "solana" && b?.tokenAddress)
				.slice(0, MAX_MINTS)
				.map((b) => b.tokenAddress);
			stats.mints = mints.length;

			const dayStart = now - 24 * 3600 * 1000;
			const vcount = await env.DB_MAIN.prepare(
				"SELECT COUNT(*) AS n FROM verdicts WHERE ts > ?"
			)
				.bind(dayStart)
				.first<{ n: number }>();
			const vb = { budget: 0, start: 0 };
			vb.budget = vb.start = MAX_VERDICTS_PER_DAY - Number(vcount?.n ?? 0);

			for (const mint of mints) {
				const r = await snapshotMint(env, mint, now, vb);
				if (r === "snap") stats.snapshots++;
				else if (r === "fail") stats.errors++;
			}
			stats.verdicts = Math.max(0, vb.start - vb.budget);
		} catch (e) {
			stats.errors++;
			console.log(JSON.stringify({ cron: "boosts_fail", err: String(e).slice(0, 160) }));
		}
	}

	if (fullRound) { // full rounds only: oldest-first rotation keeps snapshot gaps small
		const tracked = await env.DB_MAIN.prepare(
			"SELECT r.mint AS mint FROM rounds r LEFT JOIN outcomes o ON o.mint = r.mint WHERE o.mint IS NULL AND r.first_seen > ? ORDER BY (SELECT MAX(ts) FROM snapshots s WHERE s.mint = r.mint) ASC LIMIT 8"
		)
			.bind(now - 24 * 3600 * 1000)
			.all<{ mint: string }>();
		const boostSet = new Set(mints);
		for (const row of tracked.results ?? []) {
			if (boostSet.has(row.mint)) continue;
			const r = await snapshotMint(env, row.mint, now, { budget: 0 });
			if (r === "snap") stats.refreshed++;
		}
	}

	const stale = await env.DB_MAIN.prepare(
		"SELECT r.mint AS mint FROM rounds r LEFT JOIN outcomes o ON o.mint = r.mint WHERE o.mint IS NULL AND r.first_seen < ? LIMIT 20"
	)
		.bind(now - RESOLVE_AFTER_MS)
		.all<{ mint: string }>();
	for (const row of stale.results ?? []) {
		const first = await env.DB_MAIN.prepare(
			"SELECT price_usd AS p FROM snapshots WHERE mint = ? ORDER BY ts ASC LIMIT 1"
		)
			.bind(row.mint)
			.first<{ p: number }>();
		const last = await env.DB_MAIN.prepare(
			"SELECT price_usd AS p, liquidity_usd AS l FROM snapshots WHERE mint = ? ORDER BY ts DESC LIMIT 1"
		)
			.bind(row.mint)
			.first<{ p: number; l: number }>();
		const fp = Number(first?.p ?? 0);
		const lp = Number(last?.p ?? 0);
		if (fp <= 0) continue;
		const mult = lp / fp;
		const dead = mult <= 0.1 || Number(last?.l ?? 0) < 1000 ? 1 : 0;
		await env.DB_MAIN.prepare(
			"INSERT OR REPLACE INTO outcomes (mint, resolved_at, first_price, last_price, mult, dead) VALUES (?, ?, ?, ?, ?, ?)"
		)
			.bind(row.mint, now, fp, lp, mult, dead)
			.run();
		stats.resolved++;
	}
	return stats;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		if (controller.cron !== "* * * * *") { // any non-minutely trigger = weekly retrain
			ctx.waitUntil((async () => {
				try { await retrain(env, false); }
				catch (e) { console.log(JSON.stringify({ cron: "retrain_fail", err: String(e).slice(0, 200) })); }
			})());
			return;
		}
		ctx.waitUntil(
			(async () => {
				try {
					const stats = await ingest(env);
					console.log(JSON.stringify({ cron: "ok", ...stats }));
				} catch (e) {
					console.log(JSON.stringify({ cron: "fail", err: String(e).slice(0, 200) }));
				}
			})()
		);
	},

	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") return json({ ok: true, now: Date.now() });

		if (url.pathname === "/api/rounds") {
			const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
			const rows = await env.DB_MAIN.prepare(
				`SELECT r.mint, r.first_seen, r.name, v.choice, v.confidence, o.mult, o.dead,
				(SELECT price_usd FROM snapshots s WHERE s.mint = r.mint ORDER BY ts DESC LIMIT 1) AS last_price,
				(SELECT liquidity_usd FROM snapshots s WHERE s.mint = r.mint ORDER BY ts DESC LIMIT 1) AS last_liq,
				g.top1_pct AS top1, o.resolved_at AS resolved_at
				FROM rounds r LEFT JOIN verdicts v ON v.mint = r.mint LEFT JOIN outcomes o ON o.mint = r.mint LEFT JOIN signals g ON g.mint = r.mint
				WHERE o.mint IS NULL OR o.resolved_at > ? ORDER BY r.first_seen DESC LIMIT ?`
			)
				.bind(Date.now() - BOARD_RETENTION_MS, limit)
				.all();
			return json({ rounds: rows.results ?? [] });
		}

		if (url.pathname === "/api/coin") {
			const mint = url.searchParams.get("mint") ?? "";
			if (!mint) return json({ error: "missing mint" }, 400);
			const round = await env.DB_MAIN.prepare("SELECT * FROM rounds WHERE mint = ?")
				.bind(mint)
				.first();
			if (!round) return json({ error: "not tracked" }, 404);
			const sig = await env.DB_MAIN.prepare("SELECT * FROM signals WHERE mint = ?")
				.bind(mint)
				.first();
			const v = await env.DB_MAIN.prepare("SELECT * FROM verdicts WHERE mint = ?")
				.bind(mint)
				.first();
			const o = await env.DB_MAIN.prepare("SELECT * FROM outcomes WHERE mint = ?")
				.bind(mint)
				.first();
			const hist = await env.DB_MAIN.prepare(
				"SELECT ts, price_usd, liquidity_usd, fdv, txns_5m FROM snapshots WHERE mint = ? ORDER BY ts DESC LIMIT 200"
			)
				.bind(mint)
				.all<{ ts: number; price_usd: number; liquidity_usd: number }>();
			const last = hist.results?.[0] ?? null;
			return json({
				coin: round,
				signals: sig,
				verdict: v,
				outcome: o,
				last,
				history: (hist.results ?? []).slice().reverse(),
			});
		}

		if (url.pathname === "/api/verdict") {
			const mint = url.searchParams.get("mint") ?? "";
			if (!mint) return json({ error: "missing mint" }, 400);
			const v = await env.DB_MAIN.prepare("SELECT * FROM verdicts WHERE mint = ?")
				.bind(mint)
				.first();
			if (!v) return json({ error: "no verdict yet" }, 404);
			return json({ verdict: v });
		}

		if (url.pathname === "/api/proof") {
			const row = await env.DB_MAIN.prepare(
				`SELECT COUNT(*) AS n,
				SUM(CASE WHEN (v.choice = 'red' AND o.dead = 1) OR (v.choice != 'red' AND o.dead = 0) THEN 1 ELSE 0 END) AS correct,
				SUM(CASE WHEN v.choice = 'red' THEN 1 ELSE 0 END) AS reds,
				SUM(CASE WHEN v.choice = 'red' AND o.dead = 1 THEN 1 ELSE 0 END) AS red_dead
				FROM verdicts v JOIN outcomes o ON o.mint = v.mint`
			).first<{ n: number; correct: number; reds: number; red_dead: number }>();
			const n = Number(row?.n ?? 0);
			return json({
				resolved_with_verdict: n,
				correct: Number(row?.correct ?? 0),
				accuracy: n ? Number(row?.correct ?? 0) / n : null,
				red_precision: Number(row?.reds ?? 0) ? Number(row?.red_dead ?? 0) / Number(row?.reds) : null,
				note: n < 50 ? "warming up: need 50+ resolved rounds" : "ready",
			});
		}

		if (url.pathname === "/api/diag") {
			let model: unknown = null;
			try {
				const m = await env.DB_MAIN.prepare("SELECT version, test_acc, n_train, created_at FROM models WHERE promoted = 1 ORDER BY version DESC LIMIT 1").first<{ version: number; test_acc: number; n_train: number; created_at: number }>();
				if (m) model = { version: m.version, testAcc: m.test_acc, nTrain: m.n_train, createdAt: m.created_at };
			} catch { /* diag stays up without model info */ }
			return json({
				hasKey: Boolean(env.TYPESAFE_API_KEY),
				keyLen: (env.TYPESAFE_API_KEY || "").length,
				now: Date.now(),
				model,
			});
		}

		if (url.pathname === "/api/retrain-now" && request.method === "POST") {
			const key = url.searchParams.get("key") ?? "";
			if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403);
			const dry = url.searchParams.get("dry_run") === "1";
			try {
				return json(await retrain(env, dry));
			} catch (e) {
				return json({ ok: false, error: String(e).slice(0, 200) }, 500);
			}
		}

		if (url.pathname === "/api/verdict-now" && request.method === "POST") {
			const mint = url.searchParams.get("mint") ?? "";
			if (!mint) return json({ error: "missing mint" }, 400);
			try {
				const pairs = await jget(DEX + "/tokens/v1/solana/" + mint);
				const p = pickPair(pairs);
				if (!p) return json({ error: "no pair data" }, 404);
				await env.DB_MAIN.prepare(
					"INSERT OR IGNORE INTO rounds (mint, first_seen, pair_address, name) VALUES (?, ?, ?, ?)"
				)
					.bind(mint, Date.now(), String(p.pairAddress ?? ""), String(p.baseToken?.name ?? "").slice(0, 80))
					.run();
				let sig: Record<string, number> = {};
				try {
					const s = await computeSignals(env, mint);
					sig = s as unknown as Record<string, number>;
					await env.DB_MAIN.prepare(
						"INSERT OR REPLACE INTO signals (mint, ts, top1_pct, top10_pct, top2_11_pct, pool_suspect, early_buys, mint_age_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
					)
						.bind(mint, Date.now(), s.top1_pct, s.top10_pct, s.top2_11_pct, s.pool_suspect, s.early_buys, s.mint_age_min)
						.run();
				} catch {
					/* verdict falls back to market data only */
				}
				const state = {
					mint,
					price_usd: Number(p.priceUsd ?? 0),
					liquidity_usd: Number(p.liquidity?.usd ?? 0),
					fdv: Number(p.fdv ?? 0),
					txns_5m: Number(p.txns?.m5?.buys ?? 0) + Number(p.txns?.m5?.sells ?? 0),
					sell_ratio_5m: Number(p.txns?.m5?.sells ?? 0) / Math.max(1, Number(p.txns?.m5?.buys ?? 0) + Number(p.txns?.m5?.sells ?? 0)),
					...sig,
				};
				const a = await jevVerdict(env, state);
				applyVerdictOverride(a, state, mint, "verdict_now");
				await maybeDemoteGreen(env, a, state, mint, "verdict_now");
				await env.DB_MAIN.prepare(
					"INSERT OR REPLACE INTO verdicts (mint, ts, choice, confidence, p_red, p_yellow, p_green, coordinated, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
				)
					.bind(
						mint,
						Date.now(),
						String(a.verdict?.choice ?? "yellow"),
						Number(a.verdict?.confidence ?? 0),
						Number(a.verdict?.probabilities?.red ?? 0),
						Number(a.verdict?.probabilities?.yellow ?? 0),
						Number(a.verdict?.probabilities?.green ?? 0),
						Number(a.coordinated?.noul ?? 0),
						Number(a.severity?.score ?? 0)
					)
					.run();
				return json({ mint, state, answers: a });
			} catch (e) {
				return json({ mint, error: String(e).slice(0, 200) }, 500);
			}
		}

		if (url.pathname === "/api/signals-now" && request.method === "POST") {
			const mint = url.searchParams.get("mint") ?? "";
			if (!mint) return json({ error: "missing mint" }, 400);
			try {
				const s = await computeSignals(env, mint);
				const now = Date.now();
				await env.DB_MAIN.prepare(
					"INSERT OR REPLACE INTO signals (mint, ts, top1_pct, top10_pct, top2_11_pct, pool_suspect, early_buys, mint_age_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
				)
					.bind(mint, now, s.top1_pct, s.top10_pct, s.top2_11_pct, s.pool_suspect, s.early_buys, s.mint_age_min)
					.run();
				const pairs = await jget(DEX + "/tokens/v1/solana/" + mint);
				const p = pickPair(pairs);
				const vstate3 = {
					mint,
					price_usd: Number(p?.priceUsd ?? 0),
					liquidity_usd: Number(p?.liquidity?.usd ?? 0),
					fdv: Number(p?.fdv ?? 0),
					txns_5m: Number(p?.txns?.m5?.buys ?? 0) + Number(p?.txns?.m5?.sells ?? 0),
					sell_ratio_5m: Number(p?.txns?.m5?.sells ?? 0) / Math.max(1, Number(p?.txns?.m5?.buys ?? 0) + Number(p?.txns?.m5?.sells ?? 0)),
					...s,
				};
				const a = await jevVerdict(env, vstate3);
				applyVerdictOverride(a, vstate3, mint, "signals_now");
				await maybeDemoteGreen(env, a, vstate3, mint, "signals_now");
				await env.DB_MAIN.prepare(
					"INSERT OR REPLACE INTO verdicts (mint, ts, choice, confidence, p_red, p_yellow, p_green, coordinated, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
				)
					.bind(
						mint,
						now,
						String(a.verdict?.choice ?? "yellow"),
						Number(a.verdict?.confidence ?? 0),
						Number(a.verdict?.probabilities?.red ?? 0),
						Number(a.verdict?.probabilities?.yellow ?? 0),
						Number(a.verdict?.probabilities?.green ?? 0),
						Number(a.coordinated?.noul ?? 0),
						Number(a.severity?.score ?? 0)
					)
					.run();
				return json({ mint, signals: s, answers: a });
			} catch (e) {
				return json({ mint, error: String(e).slice(0, 200) }, 500);
			}
		}

		if (url.pathname === "/api/source-test") {
			const out: Record<string, unknown> = {};
			try {
				const r = await fetch(
					"https://frontend-api.pump.fun/coins?offset=0&limit=1&sort=created_timestamp&order=DESC",
					{ headers: UA }
				);
				out.pumpfun = { ok: r.ok, status: r.status };
			} catch (e) {
				out.pumpfun = { ok: false, err: String(e).slice(0, 120) };
			}
			try {
				const b = await jget(DEX + "/token-boosts/top/v1");
				out.dexscreener = { ok: true, boosts: Array.isArray(b) ? b.length : 0 };
			} catch (e) {
				out.dexscreener = { ok: false, err: String(e).slice(0, 120) };
			}
			try {
				const slot = await solamiRpc(env, "getSlot", []);
				out.solami = { ok: true, slot };
			} catch (e) {
				out.solami = { ok: false, err: String(e).slice(0, 120) };
			}
			try {
				const r = await fetch("https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1", { headers: { ...UA, Accept: "application/json" } });
				const j: any = r.ok ? await r.json() : null;
				out.gecko = { ok: r.ok, status: r.status, pools: r.ok && j && Array.isArray(j.data) ? j.data.length : 0 };
			} catch (e) {
				out.gecko = { ok: false, err: String(e).slice(0, 120) };
			}
			return json(out);
		}

		if (url.pathname === "/api/run-once" && request.method === "POST") {
			try {
				const stats = await ingest(env, url.searchParams.get("refresh") === "1");
				return json({ ran: true, ...stats });
			} catch (e) {
				return json({ ran: false, err: String(e).slice(0, 200) }, 500);
			}
		}

		return env.ASSETS.fetch(request);
	},
};
