interface Env {
	DB_MAIN: D1Database;
	ASSETS: Fetcher;
	TYPESAFE_API_KEY: string;
	SOLAMI_API_KEY: string;
	ADMIN_KEY: string;
}

import { hardRed, shadowGreen, timeSplitValidate, predict, buildFeatures, parseMintAuthorities, shouldPromote, memoryHit, FEATURES, demoteOneShot, DEMOTE_P_RED } from "./ml/train";
import type { GoldModel, TrainRow, MemVector } from "./ml/train";
import { liqCrash, lateIlliquid, priceCrash, resolveDead, ruleConfidence } from "./ml/upgrade";

const DEX = "https://api.dexscreener.com";
const UA = { "User-Agent": "Mozilla/5.0 (radar proof-of-concept)" };
const MAX_MINTS = 20;
// Full-steam trial (Oct 9): Jev is ~$0.00001/call, so budget is not money —
// every missed verdict is a lost training row. 20000 is a safety rail against
// runaway loops, not a real cap: realistic volume never touches it.
const MAX_VERDICTS_PER_DAY = 20000;
const GECKO_PAGES = 2;
// MAX-VOLUME (Oct 8): the 100-liq dust gate dated from the 200/day budget era
// (cap now 20000). It silently left 88% of intake (2103 rounds/day, 258
// verdicts) unjudged — the most dangerous coins got NO verdict. Gate removed:
// dust judges as R1 red live pre-outcome like everything else (by_rule split
// keeps the cohort mix transparent; dust verdicts are coverage, not
// cherry-picking). Cost watch (/api/cost) guards Solami/Jev spend instead.
const GECKO_MIN_VERDICT_LIQ = 0;
// Bounds round time + subrequests: leftovers roll to the next 5-min round.
const MAX_GECKO_PER_ROUND = 15;
const RESOLVE_AFTER_MS = 6 * 3600 * 1000;
const BOARD_RETENTION_MS = 7 * 24 * 3600 * 1000;

async function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function jget(url: string, tries = 3, label = "dex"): Promise<any> {
	let last = "";
	for (let i = 0; i < tries; i++) {
		const r = await fetch(url, { headers: UA });
		if (r.ok) return r.json();
		last = label + " " + r.status + " " + url.slice(0, 80);
		if (r.status !== 429 && r.status < 500) throw new Error(last);
		if (r.status === 429) {
			// Rate-limited: back off hard (honor Retry-After) instead of
			// hammering — quick retries turn one 429 into a burst of errors.
			const ra = Number(r.headers.get("Retry-After") ?? 0);
			const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 5000 * 2 ** i;
			await sleep(wait + Math.random() * 500);
		} else {
			await sleep(500 * 2 ** i + Math.random() * 300);
		}
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
					instructions: "Which risk light fits this Solana token: yellow or green? RED is handled by a separate layer — never output red. Judge strictly by the numbers in state. A high top1_pct alone is NOT alarming: several coins with top1 over 70 survived. Authority flags (mint_auth_live, freeze_auth_live: 1 = dev still holds it, 0 = renounced, null = unknown), momentum (price_chg_h1 in percent, vol_h1 in USD, pair_age_min) and simpson (0-1 holder diversity over top 20 accounts; under 0.3 means one clique owns it) are in state when available.",
					criteria: {
						yellow: "Caution, watch closely: the default for new coins. Any doubt, any missing holder data, or any single warning sign means yellow. High sell pressure (sell_ratio_5m over 0.7) means yellow. A live mint or freeze authority (either flag is 1) means yellow. A heavy dump (price_chg_h1 under -50) means yellow. Simpson diversity under 0.3 means yellow.",
						green: "Looks acceptable: ONLY when ALL of these hold at once: top1_pct under 15, top2_11_pct under 40, liquidity_usd over 100000, mint_age_min over 15, sell_ratio_5m under 0.6, mint_auth_live is 0, freeze_auth_live is 0. If holder data (top1_pct) or authority data is missing, never green.",
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
				// E5-3-lite: Jev as structured sensor — independent risk factors
				// over the SAME state in ONE call (per TypeSafe guidance), stored
				// and reused as LR features + deterministic policy inputs.
				f_whale: {
					type: "noul",
					instructions: "Do top holders show whale or bundle concentration risk? Weigh top1_pct, top2_11_pct, simpson (under 0.3 means one clique owns it), pool_suspect.",
				},
				f_sell: {
					type: "noul",
					instructions: "Is distribution or dumping underway or imminent? Weigh sell_ratio_5m (over 0.7 means dumping), price_chg_h1 (under -50 means heavy dump), txns_5m, vol_h1.",
				},
				f_struct: {
					type: "noul",
					instructions: "Does the token structure look ruggish? Weigh mint_auth_live and freeze_auth_live (1 means dev still holds it), mint_age_min (minutes-old is raw), liquidity_usd (under 1000 means unbuyable).",
				},
			},
		}),
	});
	if (!r.ok) throw new Error("jev " + r.status);
	return ((await r.json()) as any).answers;
}

// V4 demote (Oct 9, replay-verified on 2619 rows): illiquid/memory one-shot
// reds become calibrated yellows with an audit marker. Runs AFTER every red
// minter (rule override, model promote, memory) and BEFORE insert, so the
// stored row is yellow and stays eligible for upgrade re-RED on measured
// crashes. Shared by cron, verdict-now, signals-now and backfill.
function applyDemote(a: any, vstate: Record<string, unknown>): void {
	if (String(a.verdict?.choice ?? "") !== "red") return;
	const dm = demoteOneShot(redSourceOf(a), hardRed(vstate));
	if (!dm) return;
	const pr = DEMOTE_P_RED[dm] ?? 0.15;
	a.verdict = {
		...(a.verdict ?? {}),
		choice: "yellow",
		confidence: Math.round((1 - pr) * 100) / 100,
		probabilities: { red: pr, yellow: 1 - pr, green: 0 },
	};
	(a.verdict as any).redSource = dm;
}

function applyVerdictOverride(a: any, vstate: Record<string, unknown>, mint: string, tag: string): void {
	const rule = hardRed(vstate);
	const llm = String(a.verdict?.choice ?? "yellow");
	if (rule) {
		const rc = ruleConfidence(rule);
		a.verdict = {
			...(a.verdict ?? {}),
			choice: "red",
			confidence: rc,
			probabilities: { red: rc, yellow: 1 - rc, green: 0 },
		};
		(a.verdict as any).redSource = "rule:" + rule;
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

// Noul answers arrive as {noul: 0..1}; a missing answer must stay null
// (unknown), never coerce to 0 (confident-no).
function noulOrNull(a: any): number | null {
	const n = Number(a?.noul);
	return Number.isFinite(n) ? n : null;
}

// Audit: which layer called the red. Fallback labels unmarked reds 'rule'
// (the historical common case); live paths always set the marker.
function redSourceOf(a: any): string | null {
	const m = (a?.verdict as any)?.redSource;
	if (typeof m === "string" && m) return m;
	return String(a?.verdict?.choice ?? "") === "red" ? "rule" : null;
}

function memDistOf(a: any): number | null {
	const d = Number((a?.verdict as any)?.memDist);
	return Number.isFinite(d) ? d : null;
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

// Bar for the model to call red on its own: deliberately high so a model
// red means strong measured evidence, not a coin flip. chalChoice in
// train.ts mirrors this exact threshold for honest validation.
const MODEL_RED_P = 0.85;

function liveRowFrom(a: any, vstate: Record<string, unknown>): TrainRow {
	const txns = Number(vstate.txns_5m ?? 0);
	const ratio = Number(vstate.sell_ratio_5m ?? 0.5);
	return {
		ts: Date.now(), dead: 0, choice: String(a.verdict?.choice ?? "yellow"),
		liq: numOrNull(vstate.liquidity_usd), top1: numOrNull(vstate.top1_pct),
		t211: numOrNull(vstate.top2_11_pct), fdv: numOrNull(vstate.fdv),
		early: numOrNull(vstate.early_buys), age: numOrNull(vstate.mint_age_min),
		txns: Number.isFinite(txns) ? txns : null,
		buys: Math.round((1 - ratio) * Math.max(0, txns)), sells: Math.round(ratio * Math.max(0, txns)),
		pool: numOrNull(vstate.pool_suspect), pRed: Number(a.verdict?.probabilities?.red ?? 0.5),
		fWhale: noulOrNull(a.f_whale), fSell: noulOrNull(a.f_sell), fStruct: noulOrNull(a.f_struct),
		src: typeof vstate.source === "string" ? vstate.source : null,
		mintLive: numOrNull(vstate.mint_auth_live), freezeLive: numOrNull(vstate.freeze_auth_live),
		chgH1: numOrNull(vstate.price_chg_h1), volH1: numOrNull(vstate.vol_h1),
		pairAge: numOrNull(vstate.pair_age_min), simpson: numOrNull(vstate.simpson),
	};
}

async function maybeDemoteGreen(env: Env, a: any, vstate: Record<string, unknown>, mint: string, tag: string): Promise<void> {
	if (String(a.verdict?.choice ?? "") !== "green") return;
	try {
		const champ = await loadChampion(env);
		if (!champ) return; // no model yet: gate open, keep the LLM green
		if (predict(champ.model, buildFeatures(liveRowFrom(a, vstate))) >= 0.5) {
			a.verdict = { ...(a.verdict ?? {}), choice: "yellow" };
			console.log(JSON.stringify({ [tag]: "green_gated", mint }));
		}
	} catch { /* gate open on error: keep LLM green */ }
}

async function maybePromoteRed(env: Env, a: any, vstate: Record<string, unknown>, mint: string, tag: string): Promise<void> {
	if (String(a.verdict?.choice ?? "") !== "yellow") return;
	try {
		const champ = await loadChampion(env);
		if (!champ) return; // no model yet: no model reds
		const p = predict(champ.model, buildFeatures(liveRowFrom(a, vstate)));
		if (p >= MODEL_RED_P) {
			a.verdict = {
				...(a.verdict ?? {}),
				choice: "red",
				confidence: Math.round(p * 100) / 100,
				probabilities: { red: p, yellow: 1 - p, green: 0 },
			};
			(a.verdict as any).redSource = "model";
			console.log(JSON.stringify({ [tag]: "model_red", mint, p: Math.round(p * 1000) / 1000 }));
		}
	} catch { /* gate closed on error: keep LLM yellow */ }
}

// Rug memory recall (E3-4): every resolved-dead coin becomes a template vector;
// a newcomer within cosine 0.98 of a known rug is flagged red. Near-duplicate
// bar on purpose: uncalibrated recall must be conservative. Cached per isolate
// (hourly refresh); precision tracked live via /api/proof memory_precision.
const MEM_COS = 0.98;
const MEM_CAP = 500;
const MEM_TTL_MS = 3600 * 1000;
let rugCache: { at: number; vecs: MemVector[] } | null = null;

async function loadRugMemory(env: Env): Promise<MemVector[]> {
	const now = Date.now();
	if (rugCache && now - rugCache.at < MEM_TTL_MS) return rugCache.vecs;
	const qr = await env.DB_MAIN.prepare(
		"SELECT mint, vec FROM rug_vectors ORDER BY resolved_at DESC LIMIT ?"
	).bind(MEM_CAP).all<{ mint: string; vec: string }>();
	const vecs: MemVector[] = [];
	for (const r of qr.results ?? []) {
		try {
			const v = JSON.parse(r.vec);
			// Tolerant across feature growth: pad short (pre-src) vectors with
			// neutral 0.5, truncate long ones, skip garbage.
			if (!Array.isArray(v) || v.length < 10) continue;
			const vv = v.map((x) => { const n = Number(x); return Number.isFinite(n) ? n : 0.5; });
			while (vv.length < FEATURES.length) vv.push(0.5);
			vecs.push({ mint: r.mint, v: vv.slice(0, FEATURES.length) });
		} catch { /* skip corrupt rows */ }
	}
	rugCache = { at: now, vecs };
	return vecs;
}

async function maybeMemoryRed(env: Env, a: any, vstate: Record<string, unknown>, mint: string, tag: string): Promise<void> {
	if (String(a.verdict?.choice ?? "") === "red") return;
	try {
		const mem = await loadRugMemory(env);
		if (mem.length === 0) return;
		const hit = memoryHit(buildFeatures(liveRowFrom(a, vstate)), mem, mint, MEM_COS);
		if (!hit) return;
		const cos = Math.round(hit.cos * 10000) / 10000;
		a.verdict = {
			...(a.verdict ?? {}),
			choice: "red",
			confidence: Math.round(cos * 100) / 100,
			probabilities: { red: cos, yellow: 1 - cos, green: 0 },
		};
		(a.verdict as any).redSource = "memory";
		(a.verdict as any).memDist = Math.round((1 - cos) * 10000) / 10000;
		console.log(JSON.stringify({ [tag]: "memory_red", mint, near: hit.mint.slice(0, 8), cos }));
	} catch { /* memory is best-effort: never break verdicts */ }
}

// Rebuild the 20-dim feature vector from stored first-seen state (first
// snapshot + signals + verdict factors). Same inputs as training rows, so
// memory vectors and live query vectors are directly comparable.
async function vecForMint(env: Env, mint: string): Promise<number[] | null> {
	const first = await env.DB_MAIN.prepare(
		"SELECT liquidity_usd, fdv, txns_5m, buys_5m, sells_5m, price_chg_h1, vol_h1, pair_age_min FROM snapshots WHERE mint = ? ORDER BY ts ASC LIMIT 1"
	).bind(mint).first<any>();
	if (!first) return null;
	const sig = await env.DB_MAIN.prepare(
		"SELECT top1_pct, top2_11_pct, pool_suspect, early_buys, mint_age_min, mint_auth_live, freeze_auth_live, simpson FROM signals WHERE mint = ?"
	).bind(mint).first<any>();
	const v = await env.DB_MAIN.prepare(
		"SELECT choice, p_red, f_whale, f_sell, f_struct FROM verdicts WHERE mint = ?"
	).bind(mint).first<any>();
	const rd = await env.DB_MAIN.prepare(
		"SELECT source FROM rounds WHERE mint = ?"
	).bind(mint).first<any>();
	const row: TrainRow = {
		ts: Date.now(), dead: 1, choice: String(v?.choice ?? "yellow"),
		liq: numOrNull(first.liquidity_usd), top1: numOrNull(sig?.top1_pct),
		t211: numOrNull(sig?.top2_11_pct), fdv: numOrNull(first.fdv),
		early: numOrNull(sig?.early_buys), age: numOrNull(sig?.mint_age_min),
		txns: numOrNull(first.txns_5m), buys: numOrNull(first.buys_5m), sells: numOrNull(first.sells_5m),
		pool: numOrNull(sig?.pool_suspect), pRed: numOrNull(v?.p_red),
		mintLive: numOrNull(sig?.mint_auth_live), freezeLive: numOrNull(sig?.freeze_auth_live),
		chgH1: numOrNull(first.price_chg_h1), volH1: numOrNull(first.vol_h1),
		pairAge: numOrNull(first.pair_age_min), simpson: numOrNull(sig?.simpson),
		fWhale: numOrNull(v?.f_whale), fSell: numOrNull(v?.f_sell), fStruct: numOrNull(v?.f_struct),
		src: typeof rd?.source === "string" ? rd.source : null,
	};
	return buildFeatures(row).map((x) => Math.round(x * 10000) / 10000);
}

// Streaming re-verdict (E5-2, feed-aware since E5-1): upgrade-only
// yellow/green → red on refresh. Triggers mirror the offline backtest on
// 289 resolved rows: liq crash 50% (72.2%, same-feed only), fresh
// illiquidity (12/12 dead, same-feed only), price crash 70% (66.7%,
// feed-agnostic — the trigger dex-batch refresh drives for gecko
// long-tail), or champion p>=0.85 on the latest tape. Never downgrades,
// never fires post-resolution — proof counts the final pre-outcome call.
const UPGRADE_P = 0.72;
const PRICE_CRASH_P = 0.67;

async function maybeUpgrade(env: Env, mint: string, m: Market, now: number, feed: string): Promise<void> {
	try {
		const v = await env.DB_MAIN.prepare(
			"SELECT choice, p_red FROM verdicts WHERE mint = ?"
		).bind(mint).first<{ choice: string; p_red: number }>();
		if (!v || v.choice === "red") return;
		const r = await env.DB_MAIN.prepare(
			"SELECT first_seen, source FROM rounds WHERE mint = ?"
		).bind(mint).first<{ first_seen: number; source: string | null }>();
		const seen = Number(r?.first_seen ?? 0);
		if (!seen || now - seen < 5 * 60 * 1000 || now - seen > RESOLVE_AFTER_MS) return;
		const o = await env.DB_MAIN.prepare("SELECT mint FROM outcomes WHERE mint = ?").bind(mint).first();
		if (o) return;
		const first = await env.DB_MAIN.prepare(
			"SELECT liquidity_usd AS l, price_usd AS p FROM snapshots WHERE mint = ? ORDER BY ts ASC LIMIT 1"
		).bind(mint).first<{ l: number; p: number }>();
		const liq1 = Number(first?.l ?? 0);
		const px1 = Number(first?.p ?? 0);
		const feedFirst = r?.source ?? null;
		let why: string | null = null;
		let p = UPGRADE_P;
		if (liqCrash(feed, feedFirst, liq1, m.liq)) why = "liq_crash";
		else if (lateIlliquid(feed, feedFirst, liq1, m.liq)) { why = "late_illiquid"; p = 0.85; }
		else if (priceCrash(px1, m.price)) { why = "price_crash"; p = PRICE_CRASH_P; }
		if (!why) {
			try {
				const champ = await loadChampion(env);
				if (champ) {
					const sig = await env.DB_MAIN.prepare(
						"SELECT top1_pct, top2_11_pct, pool_suspect, early_buys, mint_age_min, mint_auth_live, freeze_auth_live, simpson FROM signals WHERE mint = ?"
					).bind(mint).first<any>();
					const vs = marketToVstate(mint, m, (sig ?? {}) as Record<string, unknown>, r?.source ?? null);
					const stub = { verdict: { probabilities: { red: Number(v.p_red ?? 0.5) } } };
					const mp = predict(champ.model, buildFeatures(liveRowFrom(stub, vs)));
					if (mp >= MODEL_RED_P) { why = "model"; p = mp; }
				}
			} catch { /* model upgrade best-effort */ }
		}
		if (!why) return;
		await env.DB_MAIN.prepare(
			"UPDATE verdicts SET choice = 'red', confidence = ?, p_red = ?, p_yellow = ?, p_green = 0, upgraded_from = ?, upgraded_ts = ?, red_source = 'upgrade', upgrade_why = ?, mem_dist = NULL WHERE mint = ?"
		).bind(Math.round(p * 100) / 100, p, 1 - p, String(v.choice), now, String(why), mint).run();
		console.log(JSON.stringify({ upgrade: why, mint, from: String(v.choice), p: Math.round(p * 1000) / 1000, feed }));
	} catch { /* upgrades never break the snapshot path */ }
}

async function retrain(env: Env, dryRun: boolean): Promise<Record<string, unknown>> {
	const now = Date.now();
	const qr = await env.DB_MAIN.prepare(
		"SELECT v.ts AS ts, o.dead AS dead, v.choice AS choice, "
		+ "(SELECT liquidity_usd FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS liq, "
		+ "(SELECT fdv FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS fdv, "
		+ "(SELECT txns_5m FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS txns, "
		+ "(SELECT txns_5m FROM snapshots s WHERE s.mint = v.mint ORDER BY ts DESC LIMIT 1) AS txnsLast, o.mult AS mult, "
		+ "(SELECT buys_5m FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS buys, "
		+ "(SELECT sells_5m FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS sells, "
		+ "(SELECT price_chg_h1 FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS chgH1, "
		+ "(SELECT vol_h1 FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS volH1, "
		+ "(SELECT pair_age_min FROM snapshots s WHERE s.mint = v.mint ORDER BY ts ASC LIMIT 1) AS pairAge, "
		+ "g.top1_pct AS top1, g.top2_11_pct AS t211, g.early_buys AS early, g.mint_age_min AS age, "
		+ "g.pool_suspect AS pool, g.mint_auth_live AS mintLive, g.freeze_auth_live AS freezeLive, "
		+ "g.simpson AS simpson, v.p_red AS pRed, "
		+ "v.f_whale AS fWhale, v.f_sell AS fSell, v.f_struct AS fStruct, r.source AS src FROM verdicts v "
		+ "JOIN outcomes o ON o.mint = v.mint LEFT JOIN signals g ON g.mint = v.mint LEFT JOIN rounds r ON r.mint = v.mint "
		+ "ORDER BY v.ts DESC LIMIT 5000"
	).all<any>();
	const rows: TrainRow[] = (qr.results ?? []).map((r: any) => ({
		ts: Number(r.ts), dead: Number(r.dead) === 1 ? 1 : 0, choice: String(r.choice ?? "yellow"),
		liq: numOrNull(r.liq), top1: numOrNull(r.top1), t211: numOrNull(r.t211), fdv: numOrNull(r.fdv),
		early: numOrNull(r.early), age: numOrNull(r.age), txns: numOrNull(r.txns),
		buys: numOrNull(r.buys), sells: numOrNull(r.sells), pool: numOrNull(r.pool), pRed: numOrNull(r.pRed),
		mintLive: numOrNull(r.mintLive), freezeLive: numOrNull(r.freezeLive),
		chgH1: numOrNull(r.chgH1), volH1: numOrNull(r.volH1), pairAge: numOrNull(r.pairAge),
		simpson: numOrNull(r.simpson),
		fWhale: numOrNull(r.fWhale), fSell: numOrNull(r.fSell), fStruct: numOrNull(r.fStruct),
		src: typeof r.src === "string" ? r.src : null,
		// E2-2: zombie = price exactly frozen with zero trading at both ends
		// (mirrors resolveDead: null txns count as traded, never zombie).
		zombie: Number(r.mult) === 1 && Number(r.txns) === 0 && Number(r.txnsLast) === 0
			&& r.txns != null && r.txnsLast != null && r.mult != null,
	}));
	if (rows.length < 30) return { ok: false, reason: "not_enough_data", n: rows.length };
	const res = timeSplitValidate(rows);
	if (res.nSilentTrain < 30) return { ok: false, reason: "not_enough_silent", n: res.n, nSilentTrain: res.nSilentTrain };
	const out: Record<string, unknown> = { ok: true, dryRun, n: res.n, nTrain: res.nTrain, nTest: res.nTest, champAcc: res.champAcc, chalAcc: res.chalAcc, champRedP: res.champRedP, chalRedP: res.chalRedP, nSilentTrain: res.nSilentTrain, nSilentTest: res.nSilentTest, chalAccSilent: res.chalAccSilent, chalRedPSilent: res.chalRedPSilent, chalRedSilent: res.chalRedSilent, nZombieDropped: res.nZombieDropped, promoted: false, version: null };
	const promotable = res.chalAcc != null && res.champAcc != null
		&& shouldPromote({ acc: res.champAcc, redP: res.champRedP }, { acc: res.chalAcc, redP: res.chalRedP });
	if (!dryRun && promotable) {
		await env.DB_MAIN.prepare("UPDATE models SET promoted = 0 WHERE promoted = 1").run();
		const ins = await env.DB_MAIN.prepare(
			"INSERT INTO models (created_at, weights, bias, features, n_train, test_acc, test_n, champ_acc, promoted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
		).bind(now, JSON.stringify(res.model.weights), res.model.bias, JSON.stringify(res.model.features), res.nTrain, res.chalAcc, res.nTest, res.champAcc).run();
		out.promoted = true;
		out.version = Number((ins.meta as any)?.last_row_id ?? 0);
	}
	console.log(JSON.stringify({ cron: "retrain", n: res.n, nSilentTrain: res.nSilentTrain, champAcc: res.champAcc, chalAcc: res.chalAcc, champRedP: res.champRedP, chalRedP: res.chalRedP, chalRedPSilent: res.chalRedPSilent, chalRedSilent: res.chalRedSilent, promoted: out.promoted }));
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
	mint_auth_live: number | null;
	freeze_auth_live: number | null;
	simpson: number | null;
}> {
	const [supplyR, largeR, sigsR, acctR] = await Promise.all([
		solamiRpc(env, "getTokenSupply", [mint]),
		solamiRpc(env, "getTokenLargestAccounts", [mint]),
		solamiRpc(env, "getSignaturesForAddress", [mint, { limit: 1000 }]),
		// Mint account for authority flags; rides free in the same batch.
		solamiRpc(env, "getAccountInfo", [mint, { encoding: "base64" }]).catch(() => null),
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
	const auth = parseMintAuthorities(acctR?.value?.data?.[0]);
	// Simpson diversity (E3-7): 1 - sum(pi^2) over top-20 holder shares.
	// Catches split-wallet bundles that dodge the top1>50 pool_suspect bit.
	let simpson: number | null = null;
	if (supply > 0 && amts.length > 0) {
		let s = 0;
		for (const a of amts) { const p = a / supply; s += p * p; }
		simpson = Math.round((1 - s) * 10000) / 10000;
	}
	return {
		top1_pct: r2(top1),
		top10_pct: r2(top10),
		top2_11_pct: r2(top2_11),
		pool_suspect: poolSuspect,
		early_buys: early,
		mint_age_min: r2(age),
		mint_auth_live: auth ? auth.mintLive : null,
		freeze_auth_live: auth ? auth.freezeLive : null,
		simpson,
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

interface Market {
	price: number;
	liq: number;
	fdv: number;
	buys5: number;
	sells5: number;
	tx5: number;
	sellRatio: number;
	name: string;
	pair: string;
	chgH1: number | null;
	volH1: number | null;
	pairAgeMin: number | null;
}

function pairAgeFromMs(createdMs: number): number | null {
	if (!Number.isFinite(createdMs) || createdMs <= 0) return null;
	const age = (Date.now() - createdMs) / 60000;
	return age >= 0 && Number.isFinite(age) ? Math.round(age * 100) / 100 : null;
}

function dexPairToMarket(p: any): Market | null {
	if (!p) return null;
	const buys5 = Number(p.txns?.m5?.buys ?? 0);
	const sells5 = Number(p.txns?.m5?.sells ?? 0);
	const tx5 = buys5 + sells5;
	return {
		price: Number(p.priceUsd ?? 0),
		liq: Number(p.liquidity?.usd ?? 0),
		fdv: Number(p.fdv ?? 0),
		buys5,
		sells5,
		tx5,
		sellRatio: sells5 / Math.max(1, tx5),
		name: String(p.baseToken?.name ?? "").slice(0, 80),
		pair: String(p.pairAddress ?? ""),
		chgH1: numOrNull(p?.priceChange?.h1),
		volH1: numOrNull(p?.volume?.h1),
		pairAgeMin: pairAgeFromMs(Number(p?.pairCreatedAt ?? 0)),
	};
}

async function dexMarket(mint: string): Promise<Market | null> {
	const pairs = await jget(DEX + "/tokens/v1/solana/" + mint);
	return dexPairToMarket(pickPair(pairs));
}

// E5-1: ONE DexScreener call refreshes up to 30 mints (measured 29/30
// coverage on gecko long-tail). Replaces per-coin gecko detail calls, which
// 429-wall after ~5 (proven: 1358/1358 single-snapshot coins were gecko).
// Paced gecko detail (MAX-VOLUME): 2 calls per full round (0.4/min, burst 2)
// on top-p0 gecko coins. Detail bucket measured: burst ~5, refill >=1/min,
// and intake list calls survived the old 20/min detail hammer — separate
// buckets, so paced detail cannot starve intake. tries=1: fail fast on 429
// (next round retries) so backoff never blows the 30s waitUntil budget.
// Kill-switch: skipped whenever intake failed this round (bucket stress),
// and the daily monitor alerts if rounds/24h drops >50%.
async function geckoMarket(pool: string, tries = 1): Promise<Market | null> {
	const j: any = await jget("https://api.geckoterminal.com/api/v2/networks/solana/pools/" + pool, tries, "gecko");
	return geckoMarketFrom(j?.data?.attributes, pool);
}

async function dexBatchMarkets(mints: string[]): Promise<Map<string, Market>> {
	const out = new Map<string, Market>();
	const uniq = [...new Set(mints.filter(Boolean))].slice(0, 30);
	if (uniq.length === 0) return out;
	const pairs = await jget(DEX + "/tokens/v1/solana/" + uniq.join(","));
	if (!Array.isArray(pairs)) return out;
	const byMint = new Map<string, any[]>();
	for (const p of pairs) {
		const addr = String(p?.baseToken?.address ?? "");
		if (!addr || !uniq.includes(addr)) continue;
		const arr = byMint.get(addr) ?? [];
		arr.push(p);
		byMint.set(addr, arr);
	}
	for (const [addr, arr] of byMint) {
		const m = dexPairToMarket(pickPair(arr));
		if (m) out.set(addr, m);
	}
	return out;
}

function geckoMarketFrom(a: any, pool: string): Market | null {
	if (!a) return null;
	const buys5 = Number(a.transactions?.m5?.buys ?? 0);
	const sells5 = Number(a.transactions?.m5?.sells ?? 0);
	const tx5 = buys5 + sells5;
	const nm = String(a.name ?? "");
	const createdRaw = a.pool_created_at != null ? Date.parse(String(a.pool_created_at)) : NaN;
	return {
		price: Number(a.base_token_price_usd ?? 0),
		liq: Number(a.reserve_in_usd ?? 0),
		fdv: Number(a.fdv_usd ?? 0),
		buys5,
		sells5,
		tx5,
		sellRatio: sells5 / Math.max(1, tx5),
		name: nm.split(" / ")[0].slice(0, 80),
		pair: pool,
		chgH1: numOrNull(a?.price_change_percentage?.h1),
		volH1: numOrNull(a?.volume_usd?.h1),
		pairAgeMin: pairAgeFromMs(createdRaw),
	};
}

// Single builder for judge state: market tape + on-chain signals together,
// so cron, verdict-now, signals-now and backfill all judge the same state.
function marketToVstate(mint: string, m: Market, sig: Record<string, unknown>, src: string | null = null): Record<string, unknown> {
	return {
		mint,
		source: src,
		price_usd: m.price,
		liquidity_usd: m.liq,
		fdv: m.fdv,
		txns_5m: m.tx5,
		sell_ratio_5m: m.sellRatio,
		price_chg_h1: m.chgH1,
		vol_h1: m.volH1,
		pair_age_min: m.pairAgeMin,
		...sig,
	};
}

interface GeckoCandidate { mint: string; pool: string; m: Market }

async function geckoNewMints(pages = GECKO_PAGES): Promise<GeckoCandidate[]> {
	const out: GeckoCandidate[] = [];
	const seenM = new Set<string>();
	for (let pg = 1; pg <= pages; pg++) {
		let j: any;
		try {
			j = await jget("https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=" + pg, 3, "gecko");
		} catch (e) {
			console.log(JSON.stringify({ cron: "gecko_page_fail", page: pg, err: String(e).slice(0, 120) }));
			continue; // keep earlier pages
		}
		for (const d of (Array.isArray(j?.data) ? j.data : [])) {
			const id = String(d?.relationships?.base_token?.data?.id ?? "");
			if (!id.startsWith("solana_")) continue;
			const mint = id.slice("solana_".length);
			if (!mint || seenM.has(mint)) continue;
			seenM.add(mint);
			const pool = String(d?.attributes?.address ?? "");
			if (!pool) continue;
			// List items already carry price/liq/fdv/txns: snapshot straight
			// from the list, no detail call per pool (the list rotates faster
			// than detail calls can keep up, and detail 429s throttled intake).
			const m = geckoMarketFrom(d?.attributes, pool);
			if (!m) continue;
			out.push({ mint, pool, m });
			if (out.length >= MAX_MINTS * pages) break;
		}
	}
	return out;
}

async function recordMint(
	env: Env,
	mint: string,
	m: Market,
	source: string,
	now: number,
	doVerdict: { budget: number }
): Promise<"snap"> {
	const seen = await env.DB_MAIN.prepare("SELECT mint FROM rounds WHERE mint = ?")
		.bind(mint)
		.first();
	if (!seen) {
		await env.DB_MAIN.prepare(
			"INSERT INTO rounds (mint, first_seen, pair_address, name, source) VALUES (?, ?, ?, ?, ?)"
		)
			.bind(mint, now, m.pair, m.name, source)
			.run();
		const wantVerdict = doVerdict.budget > 0 && Boolean(env.TYPESAFE_API_KEY)
			&& (source !== "gecko" || m.liq >= GECKO_MIN_VERDICT_LIQ);
		if (wantVerdict) {
			// E4-2: gecko list rows lack momentum — one Dex lookup backfills
			// real h1 change/volume before Jev + LR see the coin.
			if (m.chgH1 == null || m.volH1 == null) {
				try {
					const dm = dexPairToMarket(pickPair(await jget(DEX + "/tokens/v1/solana/" + mint, 2, "dex")));
					if (dm) {
						if (m.chgH1 == null) m.chgH1 = dm.chgH1;
						if (m.volH1 == null) m.volH1 = dm.volH1;
						if (m.pairAgeMin == null) m.pairAgeMin = dm.pairAgeMin;
					}
				} catch { /* momentum stays null: judges handle unknown */ }
			}
			try {
				let sig: Record<string, unknown> = {};
				try {
					const s = await computeSignals(env, mint);
					sig = s as unknown as Record<string, unknown>;
					await env.DB_MAIN.prepare(
						"INSERT OR REPLACE INTO signals (mint, ts, top1_pct, top10_pct, top2_11_pct, pool_suspect, early_buys, mint_age_min, mint_auth_live, freeze_auth_live, simpson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
					)
						.bind(mint, now, s.top1_pct, s.top10_pct, s.top2_11_pct, s.pool_suspect, s.early_buys, s.mint_age_min, s.mint_auth_live, s.freeze_auth_live, s.simpson)
						.run();
				} catch (e) {
					console.log(JSON.stringify({ cron: "signals_fail", mint, err: String(e).slice(0, 120) }));
				}
				const vstate = marketToVstate(mint, m, sig, source);
				const a = await jevVerdict(env, vstate);
				applyVerdictOverride(a, vstate, mint, "cron");
				await maybeDemoteGreen(env, a, vstate, mint, "cron");
				await maybePromoteRed(env, a, vstate, mint, "cron");
				await maybeMemoryRed(env, a, vstate, mint, "cron");
				applyDemote(a, vstate);
				const shadow = shadowGreen(vstate) && String(a.verdict?.choice ?? "") !== "green" ? "green" : null;
				await env.DB_MAIN.prepare(
					"INSERT OR REPLACE INTO verdicts (mint, ts, choice, confidence, p_red, p_yellow, p_green, coordinated, severity, shadow, f_whale, f_sell, f_struct, red_source, mem_dist, v_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
						Number(a.severity?.score ?? 0),
						shadow,
						noulOrNull(a.f_whale),
						noulOrNull(a.f_sell),
						noulOrNull(a.f_struct),
						redSourceOf(a),
						memDistOf(a),
						hardRed(vstate)
					)
					.run();
				doVerdict.budget--;
			} catch (e) {
				console.log(JSON.stringify({ cron: "verdict_fail", mint, err: String(e).slice(0, 120) }));
			}
		}
	}
	await env.DB_MAIN.prepare(
		"INSERT INTO snapshots (mint, ts, price_usd, liquidity_usd, fdv, txns_5m, buys_5m, sells_5m, price_chg_h1, vol_h1, pair_age_min, feed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)
		.bind(mint, now, m.price, m.liq, m.fdv, m.tx5, m.buys5, m.sells5, m.chgH1, m.volH1, m.pairAgeMin, source)
		.run();
	if (seen) await maybeUpgrade(env, mint, m, now, source);
	return "snap";
}

async function snapshotMint(
	env: Env,
	mint: string,
	now: number,
	doVerdict: { budget: number }
): Promise<"snap" | "skip" | "fail"> {
	try {
		const m = await dexMarket(mint);
		if (!m) return "skip";

		return await recordMint(env, mint, m, "dex", now, doVerdict);
	} catch (e) {
		console.log(JSON.stringify({ cron: "mint_fail", mint, err: String(e).slice(0, 120) }));
		return "fail";
	}
}

async function ingest(env: Env, forceRefresh = false): Promise<Record<string, number>> {
	const now = Date.now();
	const stats = { mints: 0, snapshots: 0, verdicts: 0, resolved: 0, errors: 0, refreshed: 0, gecko: 0 };
	let geckoIntakeOk = true;
	const fullRound = forceRefresh || new Date(now).getUTCMinutes() % 5 === 0;
	let mints: string[] = [];
	if (fullRound) {
		const dayStart = now - 24 * 3600 * 1000;
		const vcount = await env.DB_MAIN.prepare(
			"SELECT COUNT(*) AS n FROM verdicts WHERE ts > ?"
		)
			.bind(dayStart)
			.first<{ n: number }>();
		const vb = { budget: 0, start: 0 };
		vb.budget = vb.start = MAX_VERDICTS_PER_DAY - Number(vcount?.n ?? 0);
		// Primary discovery: boosts (curated) + gecko new_pools (volume).
		// Each source is fenced so one outage never starves the other.
		try {
			const boosts = await jget(DEX + "/token-boosts/top/v1");
			mints = (Array.isArray(boosts) ? boosts : [])
				.filter((b) => b?.chainId === "solana" && b?.tokenAddress)
				.slice(0, MAX_MINTS)
				.map((b) => b.tokenAddress);
		} catch (e) {
			stats.errors++;
			console.log(JSON.stringify({ cron: "boosts_fail", err: String(e).slice(0, 160) }));
		}
		let gm: GeckoCandidate[] = [];
		try {
			gm = await geckoNewMints();
		} catch (e) {
			stats.errors++;
			geckoIntakeOk = false;
			console.log(JSON.stringify({ cron: "gecko_fail", err: String(e).slice(0, 160) }));
		}
		stats.mints = mints.length;
		for (const mint of mints) {
			const r = await snapshotMint(env, mint, now, vb);
			if (r === "snap") stats.snapshots++;
			else if (r === "fail") stats.errors++;
		}
		// Gecko: snapshot unseen mints only (seen ones refresh via the
		// oldest-first rotation below). Boosts keep verdict priority.
		const boostSet = new Set(mints);
		const fresh = gm.filter((g) => !boostSet.has(g.mint));
		if (fresh.length > 0) {
			const known = await env.DB_MAIN.prepare(
				`SELECT mint FROM rounds WHERE mint IN (${fresh.map(() => "?").join(",")})`
			).bind(...fresh.map((g) => g.mint)).all<{ mint: string }>();
			const knownSet = new Set((known.results ?? []).map((r) => r.mint));
			let n = 0;
			for (const g of fresh) {
				if (knownSet.has(g.mint)) continue;
				if (n >= MAX_GECKO_PER_ROUND) break; // rest rolls to the next round
				n++;
				try {
					await recordMint(env, g.mint, g.m, "gecko", now, vb);
					stats.snapshots++; stats.gecko++;
				} catch (e) {
					stats.errors++;
					console.log(JSON.stringify({ cron: "mint_fail", mint: g.mint, err: String(e).slice(0, 120) }));
				}
			}
		}
		stats.verdicts = Math.max(0, vb.start - vb.budget);
	}

	if (fullRound) { // full rounds only. E5-1: split slots so the priority
		// set can never starve the tail again (proven: single LIMIT 20 with
		// priority-first ordering left 1358 gecko coins at exactly 1
		// snapshot), and refresh via ONE dex batch call instead of
		// 429-walled per-coin gecko detail calls. Coins seen <5min ago are
		// skipped: maybeUpgrade's 5min guard would void them anyway.
		const boostSet = new Set(mints);
		const p0 = await env.DB_MAIN.prepare(
			"SELECT r.mint AS mint FROM rounds r LEFT JOIN outcomes o ON o.mint = r.mint LEFT JOIN verdicts v ON v.mint = r.mint WHERE o.mint IS NULL AND v.choice IS NOT NULL AND v.choice != 'red' AND r.first_seen > ? AND r.first_seen < ? ORDER BY (SELECT MAX(ts) FROM snapshots s WHERE s.mint = r.mint) ASC LIMIT 15"
		)
			.bind(now - RESOLVE_AFTER_MS, now - 5 * 60 * 1000)
			.all<{ mint: string }>();
		const p0set = new Set((p0.results ?? []).map((r) => r.mint));
		const p1 = await env.DB_MAIN.prepare(
			"SELECT r.mint AS mint FROM rounds r LEFT JOIN outcomes o ON o.mint = r.mint LEFT JOIN verdicts v ON v.mint = r.mint WHERE o.mint IS NULL AND (v.choice IS NULL OR v.choice != 'red') AND r.first_seen > ? AND r.first_seen < ? ORDER BY (SELECT MAX(ts) FROM snapshots s WHERE s.mint = r.mint) ASC LIMIT 30"
		)
			.bind(now - 24 * 3600 * 1000, now - 5 * 60 * 1000)
			.all<{ mint: string }>();
		const want: string[] = [];
		for (const r of p0.results ?? []) {
			if (!boostSet.has(r.mint)) want.push(r.mint);
			if (want.length >= 30) break;
		}
		for (const r of p1.results ?? []) {
			if (want.length >= 30) break;
			if (!boostSet.has(r.mint) && !p0set.has(r.mint)) want.push(r.mint);
		}
		if (want.length > 0) {
			try {
				const markets = await dexBatchMarkets(want);
				for (const mint of want) {
					const m = markets.get(mint);
					if (!m) continue;
					try {
						await recordMint(env, mint, m, "dex", now, { budget: 0 });
						stats.refreshed++;
					} catch (e) {
						stats.errors++;
						console.log(JSON.stringify({ cron: "refresh_fail", mint, err: String(e).slice(0, 120) }));
					}
				}
			} catch (e) {
				stats.errors++;
				console.log(JSON.stringify({ cron: "batch_fail", err: String(e).slice(0, 160) }));
			}
		}
		// Paced gecko detail: same-feed liq refresh unlocks liq_crash (72%)
		// + late-illiquid (100%) on gecko long-tail. Skipped on intake
		// failure (kill-switch: bucket stress -> protect intake first).
		if (geckoIntakeOk) {
			try {
				const paced = await env.DB_MAIN.prepare(
					"SELECT r.mint AS mint, r.pair_address AS pair FROM rounds r LEFT JOIN outcomes o ON o.mint = r.mint LEFT JOIN verdicts v ON v.mint = r.mint WHERE o.mint IS NULL AND r.source = 'gecko' AND r.pair_address IS NOT NULL AND v.choice IS NOT NULL AND v.choice != 'red' AND r.first_seen > ? AND r.first_seen < ? ORDER BY (SELECT MAX(ts) FROM snapshots s WHERE s.mint = r.mint) ASC LIMIT 2"
				)
					.bind(now - RESOLVE_AFTER_MS, now - 5 * 60 * 1000)
					.all<{ mint: string; pair: string }>();
				for (const prow of paced.results ?? []) {
					try {
						const pm = await geckoMarket(prow.pair, 1);
						if (!pm) continue;
						await recordMint(env, prow.mint, pm, "gecko", now, { budget: 0 });
						stats.refreshed++;
					} catch (e) {
						stats.errors++;
						console.log(JSON.stringify({ cron: "paced_fail", mint: prow.mint, err: String(e).slice(0, 120) }));
					}
				}
			} catch (e) {
				stats.errors++;
				console.log(JSON.stringify({ cron: "paced_batch_fail", err: String(e).slice(0, 160) }));
			}
		}
	}

	const stale = await env.DB_MAIN.prepare(
		"SELECT r.mint AS mint, r.source AS source, (SELECT MAX(ts) FROM snapshots s WHERE s.mint = r.mint) AS last_ts FROM rounds r LEFT JOIN outcomes o ON o.mint = r.mint WHERE o.mint IS NULL AND r.first_seen < ? LIMIT 20"
	)
		.bind(now - RESOLVE_AFTER_MS)
		.all<{ mint: string; source: string | null; last_ts: number | null }>();
	// E5-1: ONE dex batch for all stale samples (the old per-coin gecko
	// detail loop was the 429 hammer that starved refresh AND sampling).
	const needSample = (stale.results ?? []).filter((row) => row.last_ts == null || now - row.last_ts > 30 * 60 * 1000);
	if (needSample.length > 0) {
		try {
			const markets = await dexBatchMarkets(needSample.map((row) => row.mint));
			for (const row of needSample) {
				const m = markets.get(row.mint);
				if (!m) continue;
				try {
					await recordMint(env, row.mint, m, "dex", now, { budget: 0 });
				} catch (e) {
					stats.errors++;
					console.log(JSON.stringify({ cron: "sample_fail", mint: row.mint, err: String(e).slice(0, 120) }));
				}
			}
		} catch (e) {
			stats.errors++;
			console.log(JSON.stringify({ cron: "sample_batch_fail", err: String(e).slice(0, 160) }));
		}
	}
	for (const row of stale.results ?? []) {
		try {
			const first = await env.DB_MAIN.prepare(
				"SELECT price_usd AS p, txns_5m AS t FROM snapshots WHERE mint = ? ORDER BY ts ASC LIMIT 1"
			)
				.bind(row.mint)
				.first<{ p: number; t: number }>();
			const last = await env.DB_MAIN.prepare(
				"SELECT price_usd AS p, liquidity_usd AS l, txns_5m AS t, feed FROM snapshots WHERE mint = ? ORDER BY ts DESC LIMIT 1"
			)
				.bind(row.mint)
				.first<{ p: number; l: number; t: number; feed: string | null }>();
			const fp = Number(first?.p ?? 0);
			const lp = Number(last?.p ?? 0);
			if (fp <= 0) continue;
			const mult = lp / fp;
			// Feed-aware outcome: the <1000 liq clause needs same-feed liq
			// (dex reports structural 0 for ungraduated coins — without the
			// guard every healthy pump coin would resolve dead).
			const { dead } = resolveDead(mult, last?.l ?? null, last?.feed ?? null, row.source, first?.t ?? null, last?.t ?? null);
			await env.DB_MAIN.prepare(
				"INSERT OR REPLACE INTO outcomes (mint, resolved_at, first_price, last_price, mult, dead) VALUES (?, ?, ?, ?, ?, ?)"
			)
				.bind(row.mint, now, fp, lp, mult, dead)
				.run();
			if (dead === 1) {
				// Every rug becomes a memory template immediately — the system
				// literally learns a new pattern the moment it resolves.
				try {
					const vec = await vecForMint(env, row.mint);
					if (vec) {
						await env.DB_MAIN.prepare(
							"INSERT OR IGNORE INTO rug_vectors (mint, resolved_at, vec) VALUES (?, ?, ?)"
						).bind(row.mint, now, JSON.stringify(vec)).run();
						if (rugCache) {
							rugCache.vecs.unshift({ mint: row.mint, v: vec });
							if (rugCache.vecs.length > MEM_CAP) rugCache.vecs.length = MEM_CAP;
						}
					}
				} catch { /* memory fill never breaks resolution */ }
			}
			stats.resolved++;
		} catch (e) {
			stats.errors++;
			console.log(JSON.stringify({ cron: "resolve_fail", mint: row.mint, err: String(e).slice(0, 120) }));
		}
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
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 100);
			const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
			// resolved=1 serves the proof table: newest SETTLED coins. The board
			// mix is newest-first, which post-flood is all unresolved.
			const resFlag = url.searchParams.get("resolved") === "1" ? 1 : 0;
			const fromWhere = `FROM rounds r LEFT JOIN verdicts v ON v.mint = r.mint LEFT JOIN outcomes o ON o.mint = r.mint LEFT JOIN signals g ON g.mint = r.mint
				WHERE (o.mint IS NULL OR o.resolved_at > ?) AND (? = 0 OR o.mint IS NOT NULL)`;
			const orderTail = resFlag ? "o.resolved_at DESC, r.mint ASC" : "r.first_seen DESC, r.mint ASC";
			const rows = await env.DB_MAIN.prepare(
				`SELECT r.mint, r.first_seen, r.name, v.choice, v.confidence, o.mult, o.dead,
				(SELECT price_usd FROM snapshots s WHERE s.mint = r.mint ORDER BY ts DESC LIMIT 1) AS last_price,
				(SELECT liquidity_usd FROM snapshots s WHERE s.mint = r.mint ORDER BY ts DESC LIMIT 1) AS last_liq,
				g.top1_pct AS top1, o.resolved_at AS resolved_at
				${fromWhere} ORDER BY ${orderTail} LIMIT ? OFFSET ?`
			)
				.bind(Date.now() - BOARD_RETENTION_MS, resFlag, limit, offset)
				.all();
			const tot = await env.DB_MAIN.prepare(`SELECT COUNT(*) AS n ${fromWhere}`)
				.bind(Date.now() - BOARD_RETENTION_MS, resFlag)
				.first<{ n: number }>();
			return json({ rounds: rows.results ?? [], total: Number(tot?.n ?? 0) });
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
				SUM(CASE WHEN v.choice = 'red' AND o.dead = 1 THEN 1 ELSE 0 END) AS red_dead,
				SUM(CASE WHEN v.choice = 'green' THEN 1 ELSE 0 END) AS greens,
				SUM(CASE WHEN v.choice = 'green' AND o.dead = 0 THEN 1 ELSE 0 END) AS green_ok,
				SUM(CASE WHEN v.upgraded_from IS NOT NULL THEN 1 ELSE 0 END) AS upgrades,
				SUM(CASE WHEN v.upgraded_from IS NOT NULL AND o.dead = 1 THEN 1 ELSE 0 END) AS up_dead,
				SUM(CASE WHEN v.shadow = 'green' THEN 1 ELSE 0 END) AS shadows,
				SUM(CASE WHEN v.shadow = 'green' AND o.dead = 0 THEN 1 ELSE 0 END) AS shadow_ok,
				SUM(CASE WHEN v.red_source = 'memory' THEN 1 ELSE 0 END) AS mems,
				SUM(CASE WHEN v.red_source = 'memory' AND o.dead = 1 THEN 1 ELSE 0 END) AS mem_dead,
				SUM(CASE WHEN v.red_source LIKE 'demoted:%' THEN 1 ELSE 0 END) AS demoted,
				SUM(CASE WHEN v.red_source LIKE 'demoted:%' AND o.dead = 1 THEN 1 ELSE 0 END) AS dem_dead
				FROM verdicts v JOIN outcomes o ON o.mint = v.mint WHERE v.source = 'live'`
			).first<{ n: number; correct: number; reds: number; red_dead: number; greens: number; green_ok: number; upgrades: number; up_dead: number; shadows: number; shadow_ok: number; mems: number; mem_dead: number; demoted: number; dem_dead: number }>();
			const n = Number(row?.n ?? 0);
			const ups = Number(row?.upgrades ?? 0);
			const shs = Number(row?.shadows ?? 0);
			const mems = Number(row?.mems ?? 0);
			const dems = Number(row?.demoted ?? 0);
			const grns = Number(row?.greens ?? 0);
			// E4-1 gate: per-rule red precision, forward-only via v_rule
			// (NULL for pre-audit rows, excluded by construction).
			const byRuleQ = await env.DB_MAIN.prepare(
				`SELECT v.v_rule AS rule, COUNT(*) AS n, SUM(CASE WHEN o.dead = 1 THEN 1 ELSE 0 END) AS dead
				FROM verdicts v JOIN outcomes o ON o.mint = v.mint
				WHERE v.source = 'live' AND v.choice = 'red' AND v.v_rule IS NOT NULL GROUP BY v.v_rule`
			).all<{ rule: string; n: number; dead: number }>();
			const byRule = (byRuleQ.results ?? []).map((r) => ({ rule: r.rule, n: Number(r.n), precision: Number(r.n) ? Number(r.dead) / Number(r.n) : null }));
			// E4-2 gate: per-trigger upgrade precision via upgrade_why.
			const byWhyQ = await env.DB_MAIN.prepare(
				`SELECT v.upgrade_why AS why, COUNT(*) AS n, SUM(CASE WHEN o.dead = 1 THEN 1 ELSE 0 END) AS dead
				FROM verdicts v JOIN outcomes o ON o.mint = v.mint
				WHERE v.source = 'live' AND v.upgraded_from IS NOT NULL GROUP BY v.upgrade_why`
			).all<{ why: string | null; n: number; dead: number }>();
			const byWhy = (byWhyQ.results ?? []).map((r) => ({ why: r.why, n: Number(r.n), precision: Number(r.n) ? Number(r.dead) / Number(r.n) : null }));
			// E1-7 support: accuracy/redP split by discovery source.
			const bySrcQ = await env.DB_MAIN.prepare(
				`SELECT r.source AS src, COUNT(*) AS n,
				SUM(CASE WHEN (v.choice = 'red' AND o.dead = 1) OR (v.choice != 'red' AND o.dead = 0) THEN 1 ELSE 0 END) AS correct,
				SUM(CASE WHEN v.choice = 'red' THEN 1 ELSE 0 END) AS reds,
				SUM(CASE WHEN v.choice = 'red' AND o.dead = 1 THEN 1 ELSE 0 END) AS red_dead
				FROM verdicts v JOIN outcomes o ON o.mint = v.mint LEFT JOIN rounds r ON r.mint = v.mint
				WHERE v.source = 'live' GROUP BY r.source`
			).all<{ src: string | null; n: number; correct: number; reds: number; red_dead: number }>();
			const bySource = (bySrcQ.results ?? []).map((r) => ({
				source: r.src, n: Number(r.n),
				accuracy: Number(r.n) ? Number(r.correct) / Number(r.n) : null,
				red_precision: Number(r.reds) ? Number(r.red_dead) / Number(r.reds) : null,
			}));
			// E2-1 panel: Brier + ECE of stated confidence vs correctness.
			// confidence means P(choice-is-right) on every path (rule 0.95,
			// model p, Jev p, upgrade p), so (conf - correct)^2 is the Brier.
			const confQ = await env.DB_MAIN.prepare(
				`SELECT v.choice AS choice, v.confidence AS conf, o.dead AS dead
				FROM verdicts v JOIN outcomes o ON o.mint = v.mint WHERE v.source = 'live'`
			).all<{ choice: string; conf: number | null; dead: number }>();
			const buckets: Array<{ n: number; acc: number; conf: number }> = [];
			for (let i = 0; i < 10; i++) buckets.push({ n: 0, acc: 0, conf: 0 });
			let brierSum = 0, brierN = 0;
			for (const r of confQ.results ?? []) {
				const c = typeof r.conf === "number" && Number.isFinite(r.conf) ? Math.min(Math.max(r.conf, 0), 1) : null;
				if (c === null) continue;
				const ok = (r.choice === "red" && r.dead === 1) || (r.choice !== "red" && r.dead === 0) ? 1 : 0;
				brierSum += (c - ok) * (c - ok);
				brierN++;
				const b = buckets[Math.min(9, Math.floor(c * 10))];
				b.n++; b.acc += ok; b.conf += c;
			}
			let ece = 0;
			const deciles = buckets.map((b, i) => {
				const acc = b.n ? b.acc / b.n : null;
				const avg = b.n ? b.conf / b.n : null;
				if (acc !== null && avg !== null && brierN) ece += (b.n / brierN) * Math.abs(avg - acc);
				return { lo: i / 10, n: b.n, accuracy: acc, avg_confidence: avg };
			});
			const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
			return json({
				resolved_with_verdict: n,
				correct: Number(row?.correct ?? 0),
				accuracy: n ? Number(row?.correct ?? 0) / n : null,
				red_precision: Number(row?.reds ?? 0) ? Number(row?.red_dead ?? 0) / Number(row?.reds) : null,
				greens: grns,
				green_precision: grns ? Number(row?.green_ok ?? 0) / grns : null,
				upgrades: ups,
				upgrade_precision: ups ? Number(row?.up_dead ?? 0) / ups : null,
				shadow_greens: shs,
				shadow_green_survival: shs ? Number(row?.shadow_ok ?? 0) / shs : null,
				memory_reds: mems,
				memory_precision: mems ? Number(row?.mem_dead ?? 0) / mems : null,
				demoted: dems,
				demoted_dead_rate: dems ? Number(row?.dem_dead ?? 0) / dems : null,
				by_rule: byRule.map((r) => ({ ...r, precision: r3(r.precision) })),
				by_upgrade_why: byWhy.map((r) => ({ ...r, precision: r3(r.precision) })),
				by_source: bySource.map((r) => ({ ...r, accuracy: r3(r.accuracy), red_precision: r3(r.red_precision) })),
				brier: brierN ? r3(brierSum / brierN) : null,
				ece: brierN ? r3(ece) : null,
				conf_n: brierN,
				conf_deciles: deciles.map((d) => ({ ...d, accuracy: r3(d.accuracy), avg_confidence: r3(d.avg_confidence) })),
				note: n < 50 ? "warming up: need 50+ resolved rounds" : "ready",
			});
		}

		if (url.pathname === "/api/cost") {
			// Cost watch across every resource, computed from live tables.
			// No secrets: counts x public rates only.
			const dayAgo = Date.now() - 24 * 3600 * 1000;
			const q1 = await env.DB_MAIN.prepare(
				`SELECT COUNT(*) AS v_all, SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) AS v_24,
				SUM(CASE WHEN source = 'live' AND ts > ? THEN 1 ELSE 0 END) AS v_live24 FROM verdicts`
			).bind(dayAgo, dayAgo).first<{ v_all: number; v_24: number; v_live24: number }>();
			const q2 = await env.DB_MAIN.prepare(
				`SELECT COUNT(*) AS s_all, SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) AS s_24 FROM signals`
			).bind(dayAgo).first<{ s_all: number; s_24: number }>();
			const q3 = await env.DB_MAIN.prepare(
				`SELECT COUNT(*) AS r_all, SUM(CASE WHEN first_seen > ? THEN 1 ELSE 0 END) AS r_24 FROM rounds`
			).bind(dayAgo).first<{ r_all: number; r_24: number }>();
			const q4 = await env.DB_MAIN.prepare(
				`SELECT (SELECT COUNT(*) FROM snapshots) AS snaps, (SELECT COUNT(*) FROM outcomes) AS outs,
				(SELECT COUNT(*) FROM rug_vectors) AS mems, (SELECT COUNT(*) FROM models) AS mods`
			).first<{ snaps: number; outs: number; mems: number; mods: number }>();
			const JEV_USD = 0.00001; // measured plan rate per Jev call
			const jevAll = Number(q1?.v_all ?? 0);
			const jev24 = Number(q1?.v_24 ?? 0);
			// Solami: 4 RPCs per computeSignals (supply+largest+sigs+acct).
			// Lower bound: verdict-now recomputes overwrite the same row.
			const solAll = Number(q2?.s_all ?? 0) * 4;
			const sol24 = Number(q2?.s_24 ?? 0) * 4;
			const r24 = Number(q3?.r_24 ?? 0);
			const alerts: string[] = [];
			if (r24 < 500) alerts.push(`intake_drop: rounds/24h=${r24} (<500, pipeline or gecko-list trouble)`);
			if (jev24 * JEV_USD > 0.5) alerts.push(`jev_spend: 24h=$${(jev24 * JEV_USD).toFixed(2)} (>$0.50)`);
			if (sol24 > 50000) alerts.push(`solami_volume: ${sol24} RPCs/24h (trial watch)`);
			return json({
				jev: { calls_all: jevAll, calls_24h: jev24, usd_all: Math.round(jevAll * JEV_USD * 1000) / 1000, usd_24h: Math.round(jev24 * JEV_USD * 1000) / 1000, note: "1 call/verdict; backfill ts=first_seen skews 24h down" },
				solami: { rpc_est_all: solAll, rpc_est_24h: sol24, usd: 0, note: "4 RPCs/signal-row; lower bound (recomputes overwrite); trial" },
				dexscreener: { est_calls_24h: 288 * 3, usd: 0, note: "~1 list + ~2 batch per 5min round; free 300/min" },
				geckoterminal: { est_calls_24h: 288 * 2 + 288 * 2, usd: 0, note: "2 list + 2 paced-detail per 5min; keyless micro-bucket" },
				cloudflare: { usd_month: 5, note: "workers paid flat; D1 within included quota" },
				d1_rows: { rounds: Number(q3?.r_all ?? 0), snapshots: Number(q4?.snaps ?? 0), verdicts: jevAll, outcomes: Number(q4?.outs ?? 0), signals: Number(q2?.s_all ?? 0), rug_vectors: Number(q4?.mems ?? 0), models: Number(q4?.mods ?? 0) },
				intake_24h: { rounds: r24, live_verdicts_24h: Number(q1?.v_live24 ?? 0) },
				alerts,
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
			const vcount = await env.DB_MAIN.prepare("SELECT COUNT(*) AS n FROM verdicts WHERE ts > ?").bind(Date.now() - 24 * 3600 * 1000).first<{ n: number }>();
			if (Number(vcount?.n ?? 0) >= MAX_VERDICTS_PER_DAY) return json({ error: "daily budget exhausted" }, 429);
			try {
				const now = Date.now();
				const pairs = await jget(DEX + "/tokens/v1/solana/" + mint);
				const m = dexPairToMarket(pickPair(pairs));
				if (!m) return json({ error: "no pair data" }, 404);
				await env.DB_MAIN.prepare(
					"INSERT OR IGNORE INTO rounds (mint, first_seen, pair_address, name, source) VALUES (?, ?, ?, ?, 'dex')"
				)
					.bind(mint, now, m.pair, m.name)
					.run();
				let sig: Record<string, unknown> = {};
				try {
					const s = await computeSignals(env, mint);
					sig = s as unknown as Record<string, unknown>;
					await env.DB_MAIN.prepare(
						"INSERT OR REPLACE INTO signals (mint, ts, top1_pct, top10_pct, top2_11_pct, pool_suspect, early_buys, mint_age_min, mint_auth_live, freeze_auth_live, simpson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
					)
						.bind(mint, now, s.top1_pct, s.top10_pct, s.top2_11_pct, s.pool_suspect, s.early_buys, s.mint_age_min, s.mint_auth_live, s.freeze_auth_live, s.simpson)
						.run();
				} catch {
					/* verdict falls back to market data only */
				}
				// First-seen snapshot: on-demand verdicts resolve like cron ones.
				try {
					await env.DB_MAIN.prepare(
						"INSERT INTO snapshots (mint, ts, price_usd, liquidity_usd, fdv, txns_5m, buys_5m, sells_5m, price_chg_h1, vol_h1, pair_age_min, feed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dex')"
					)
						.bind(mint, now, m.price, m.liq, m.fdv, m.tx5, m.buys5, m.sells5, m.chgH1, m.volH1, m.pairAgeMin)
						.run();
				} catch { /* resolution sampling stays best-effort */ }
				const rsrc = await env.DB_MAIN.prepare("SELECT source FROM rounds WHERE mint = ?").bind(mint).first<{ source: string | null }>();
				const state = marketToVstate(mint, m, sig, rsrc?.source ?? null);
				const a = await jevVerdict(env, state);
				applyVerdictOverride(a, state, mint, "verdict_now");
				await maybeDemoteGreen(env, a, state, mint, "verdict_now");
				await maybePromoteRed(env, a, state, mint, "verdict_now");
				await maybeMemoryRed(env, a, state, mint, "verdict_now");
				applyDemote(a, state);
				await env.DB_MAIN.prepare(
					"INSERT OR REPLACE INTO verdicts (mint, ts, choice, confidence, p_red, p_yellow, p_green, coordinated, severity, f_whale, f_sell, f_struct, red_source, mem_dist, v_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
						Number(a.severity?.score ?? 0),
						noulOrNull(a.f_whale),
						noulOrNull(a.f_sell),
						noulOrNull(a.f_struct),
						redSourceOf(a),
						memDistOf(a),
						hardRed(state)
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
			const akey = url.searchParams.get("key") ?? "";
			if (!env.ADMIN_KEY || akey !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403);
			try {
				const s = await computeSignals(env, mint);
				const now = Date.now();
				await env.DB_MAIN.prepare(
					"INSERT OR REPLACE INTO signals (mint, ts, top1_pct, top10_pct, top2_11_pct, pool_suspect, early_buys, mint_age_min, mint_auth_live, freeze_auth_live, simpson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
				)
					.bind(mint, now, s.top1_pct, s.top10_pct, s.top2_11_pct, s.pool_suspect, s.early_buys, s.mint_age_min, s.mint_auth_live, s.freeze_auth_live, s.simpson)
					.run();
				const pairs = await jget(DEX + "/tokens/v1/solana/" + mint);
				const m = dexPairToMarket(pickPair(pairs)) ?? {
					price: 0, liq: 0, fdv: 0, buys5: 0, sells5: 0, tx5: 0, sellRatio: 0,
					name: "", pair: "", chgH1: null, volH1: null, pairAgeMin: null,
				};
				const rsrc3 = await env.DB_MAIN.prepare("SELECT source FROM rounds WHERE mint = ?").bind(mint).first<{ source: string | null }>();
				const vstate3 = marketToVstate(mint, m, s as unknown as Record<string, unknown>, rsrc3?.source ?? null);
				const a = await jevVerdict(env, vstate3);
				applyVerdictOverride(a, vstate3, mint, "signals_now");
				await maybeDemoteGreen(env, a, vstate3, mint, "signals_now");
				await maybePromoteRed(env, a, vstate3, mint, "signals_now");
				await maybeMemoryRed(env, a, vstate3, mint, "signals_now");
				applyDemote(a, vstate3);
				await env.DB_MAIN.prepare(
					"INSERT OR REPLACE INTO verdicts (mint, ts, choice, confidence, p_red, p_yellow, p_green, coordinated, severity, f_whale, f_sell, f_struct, red_source, mem_dist, v_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
						Number(a.severity?.score ?? 0),
						noulOrNull(a.f_whale),
						noulOrNull(a.f_sell),
						noulOrNull(a.f_struct),
						redSourceOf(a),
						memDistOf(a),
						hardRed(vstate3)
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
				if (r.ok && j && Array.isArray(j.data) && j.data.length > 0) {
					const pool = String(j.data[0]?.attributes?.address ?? "");
					const rd = await fetch("https://api.geckoterminal.com/api/v2/networks/solana/pools/" + pool, { headers: { ...UA, Accept: "application/json" } });
					const jd: any = rd.ok ? await rd.json() : null;
					const at = jd?.data?.attributes;
					out.gecko_detail = { ok: rd.ok, status: rd.status, hasPrice: at?.base_token_price_usd != null, hasLiq: at?.reserve_in_usd != null };
				}
			} catch (e) {
				out.gecko = { ok: false, err: String(e).slice(0, 120) };
			}
			return json(out);
		}

		if (url.pathname === "/api/backfill-now" && request.method === "POST") {
			// Backfill verdicts for resolved coins that missed their live verdict
			// (daily budget ran out when they were new). Credibility rules:
			// - state comes ONLY from the stored FIRST snapshot (+ stored signals
			//   if present): Jev never sees the outcome, same as a live decision.
			// - verdict ts = first_seen, so time-split validation puts these rows
			//   in the TRAIN split, never the test split.
			// - source = 'backfill': /api/proof counts live verdicts only.
			// Admin-initiated and capped per call, so it intentionally bypasses
			// the rolling daily verdict budget (which guards the cron path).
			const akey = url.searchParams.get("key") ?? "";
			if (!env.ADMIN_KEY || akey !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403);
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 5), 1), 8);
			const cands = await env.DB_MAIN.prepare(
				"SELECT o.mint AS mint, r.first_seen AS first_seen FROM outcomes o "
				+ "JOIN rounds r ON r.mint = o.mint LEFT JOIN verdicts v ON v.mint = o.mint "
				+ "WHERE v.mint IS NULL ORDER BY r.first_seen ASC LIMIT ?"
			).bind(limit).all<{ mint: string; first_seen: number }>();
			const results: Array<Record<string, unknown>> = [];
			for (const c of cands.results ?? []) {
				try {
					const first = await env.DB_MAIN.prepare(
						"SELECT price_usd, liquidity_usd, fdv, txns_5m, buys_5m, sells_5m, price_chg_h1, vol_h1, pair_age_min FROM snapshots WHERE mint = ? ORDER BY ts ASC LIMIT 1"
					).bind(c.mint).first<any>();
					if (!first) { results.push({ mint: c.mint, skipped: "no_snapshot" }); continue; }
					const sig = await env.DB_MAIN.prepare(
						"SELECT top1_pct, top10_pct, top2_11_pct, pool_suspect, early_buys, mint_age_min, mint_auth_live, freeze_auth_live, simpson FROM signals WHERE mint = ?"
					).bind(c.mint).first<any>();
					const buys = Number(first.buys_5m ?? 0);
					const sells = Number(first.sells_5m ?? 0);
					const bsrc = await env.DB_MAIN.prepare("SELECT source FROM rounds WHERE mint = ?").bind(c.mint).first<{ source: string | null }>();
					const vstate: Record<string, unknown> = {
						mint: c.mint,
						price_usd: Number(first.price_usd ?? 0),
						liquidity_usd: Number(first.liquidity_usd ?? 0),
						fdv: Number(first.fdv ?? 0),
						txns_5m: Number(first.txns_5m ?? 0),
						sell_ratio_5m: sells / Math.max(1, buys + sells),
						price_chg_h1: first.price_chg_h1 == null ? null : Number(first.price_chg_h1),
						vol_h1: first.vol_h1 == null ? null : Number(first.vol_h1),
						pair_age_min: first.pair_age_min == null ? null : Number(first.pair_age_min),
						source: bsrc?.source ?? null,
					};
					if (sig) {
						for (const k of ["top1_pct", "top10_pct", "top2_11_pct", "pool_suspect", "early_buys", "mint_age_min", "mint_auth_live", "freeze_auth_live", "simpson"]) {
							// Preserve null: unknown must reach the judge as
							// unknown, never as a flattering zero.
							vstate[k] = (sig as any)[k] == null ? null : Number((sig as any)[k]);
						}
					}
					const a = await jevVerdict(env, vstate);
					applyVerdictOverride(a, vstate, c.mint, "backfill");
					await maybeDemoteGreen(env, a, vstate, c.mint, "backfill");
					await maybePromoteRed(env, a, vstate, c.mint, "backfill");
					await maybeMemoryRed(env, a, vstate, c.mint, "backfill");
					applyDemote(a, vstate);
					await env.DB_MAIN.prepare(
						"INSERT OR REPLACE INTO verdicts (mint, ts, choice, confidence, p_red, p_yellow, p_green, coordinated, severity, source, f_whale, f_sell, f_struct, red_source, mem_dist, v_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill', ?, ?, ?, ?, ?, ?)"
					)
						.bind(
							c.mint,
							Number(c.first_seen),
							String(a.verdict?.choice ?? "yellow"),
							Number(a.verdict?.confidence ?? 0),
							Number(a.verdict?.probabilities?.red ?? 0),
							Number(a.verdict?.probabilities?.yellow ?? 0),
							Number(a.verdict?.probabilities?.green ?? 0),
							Number(a.coordinated?.noul ?? 0),
							Number(a.severity?.score ?? 0),
							noulOrNull(a.f_whale),
							noulOrNull(a.f_sell),
							noulOrNull(a.f_struct),
							redSourceOf(a),
							memDistOf(a),
							hardRed(vstate)
						)
						.run();
					results.push({ mint: c.mint, choice: String(a.verdict?.choice ?? "yellow") });
				} catch (e) {
					results.push({ mint: c.mint, error: String(e).slice(0, 120) });
				}
			}
			const ok = results.filter((r) => !r.error && !r.skipped).length;
			return json({ backfilled: ok, results });
		}

		if (url.pathname === "/api/memory-fill" && request.method === "POST") {
			const akey = url.searchParams.get("key") ?? "";
			if (!env.ADMIN_KEY || akey !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403);
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 50);
			const cands = await env.DB_MAIN.prepare(
				"SELECT o.mint AS mint FROM outcomes o LEFT JOIN rug_vectors r ON r.mint = o.mint WHERE o.dead = 1 AND r.mint IS NULL LIMIT ?"
			).bind(limit).all<{ mint: string }>();
			let filled = 0, skipped = 0;
			for (const c of cands.results ?? []) {
				try {
					const vec = await vecForMint(env, c.mint);
					if (!vec) { skipped++; continue; }
					await env.DB_MAIN.prepare(
						"INSERT OR IGNORE INTO rug_vectors (mint, resolved_at, vec) VALUES (?, ?, ?)"
					).bind(c.mint, Date.now(), JSON.stringify(vec)).run();
					filled++;
				} catch { skipped++; }
			}
			rugCache = null;
			return json({ filled, skipped });
		}

		if (url.pathname === "/api/run-once" && request.method === "POST") {
			const akey = url.searchParams.get("key") ?? "";
			if (!env.ADMIN_KEY || akey !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403);
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
