// Guard rails smoke test: no framework, plain node.
// Usage: node smoke-guards.mjs [BASE]
//   BASE defaults to https://flag.sornkan.com (or $BASE).
//   Set ADMIN_KEY env to also exercise the authenticated positive path.
// Fails (exit 1) on any unexpected status.
const BASE = (process.argv[2] || process.env.BASE || "https://flag.sornkan.com").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "";

let failures = 0;
async function check(name, method, path, okStatuses) {
	let status;
	try {
		const r = await fetch(BASE + path, { method });
		status = r.status;
		await r.text().catch(() => {});
	} catch (e) {
		status = "ERR:" + String((e && e.cause && e.cause.code) || e).slice(0, 40);
	}
	const pass = okStatuses.includes(status);
	if (!pass) failures++;
	console.log(`${pass ? "PASS" : "FAIL"} ${name}: got ${status}, want one of [${okStatuses.join(",")}]`);
}

async function checkJson(name, path, want) {
	let body = null;
	try {
		const r = await fetch(BASE + path);
		body = r.ok ? await r.json() : null;
	} catch { body = null; }
	const pass = want(body);
	if (!pass) failures++;
	console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(body).slice(0, 160)}`);
}

const GARBAGE = "not-a-real-mint-xyz-123";

await checkJson("discovery sources live", "/api/source-test", (j) => Boolean(j && j.dexscreener?.ok && j.gecko?.ok));

await check("run-once without key is forbidden", "POST", "/api/run-once", [403]);
await check("signals-now without key is forbidden", "POST", `/api/signals-now?mint=${GARBAGE}`, [403]);
await check("retrain-now without key is forbidden", "POST", "/api/retrain-now?dry_run=1", [403]);
await check("backfill-now without key is forbidden", "POST", "/api/backfill-now", [403]);
// Garbage mint must never burn a verdict: 404 (no pair) or 429 (budget out).
// 500 is tolerated: DexScreener 404s unknown mints and the handler surfaces it.
await check("verdict-now garbage mint burns nothing", "POST", `/api/verdict-now?mint=${GARBAGE}`, [404, 429, 500]);
if (KEY) {
	await check("run-once with key runs", "POST", `/api/run-once?key=${encodeURIComponent(KEY)}`, [200]);
} else {
	console.log("SKIP run-once with key runs (set ADMIN_KEY to enable)");
}

await checkJson("rounds paginates with total", "/api/rounds?limit=5", (j) => Array.isArray(j?.rounds) && j.rounds.length <= 5 && typeof j?.total === "number" && j.total >= j.rounds.length);
await checkJson("rounds resolved-only lists settled coins", "/api/rounds?limit=5&resolved=1", (j) => Array.isArray(j?.rounds) && j.rounds.length > 0 && j.rounds.every((r) => r.resolved_at != null && r.dead != null));
{
	// Pages must agree on total and stay newest-first ordered (no overlap
	// assert: live inserts between fetches can legitimately shift offsets).
	let p1 = null, p2 = null;
	try {
		p1 = await (await fetch(`${BASE}/api/rounds?limit=5&offset=0`)).json();
		p2 = await (await fetch(`${BASE}/api/rounds?limit=5&offset=5`)).json();
	} catch { /* fall through to FAIL */ }
	const ordered = (p) => Array.isArray(p?.rounds) && p.rounds.every((r, i, a) => i === 0 || (a[i - 1].first_seen > r.first_seen || (a[i - 1].first_seen === r.first_seen && a[i - 1].mint <= r.mint)));
	const pass = Boolean(p1 && p2) && p1.total === p2.total && ordered(p1) && ordered(p2);
	if (!pass) failures++;
	console.log(`${pass ? "PASS" : "FAIL"} rounds pages stable: total=${p1?.total}/${p2?.total}`);
}

if (failures > 0) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("smoke-guards: all green");
