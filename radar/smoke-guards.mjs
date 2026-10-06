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

const GARBAGE = "not-a-real-mint-xyz-123";

await check("run-once without key is forbidden", "POST", "/api/run-once", [403]);
await check("signals-now without key is forbidden", "POST", `/api/signals-now?mint=${GARBAGE}`, [403]);
await check("retrain-now without key is forbidden", "POST", "/api/retrain-now?dry_run=1", [403]);
// Garbage mint must never burn a verdict: 404 (no pair) or 429 (budget out).
// 500 is tolerated: DexScreener 404s unknown mints and the handler surfaces it.
await check("verdict-now garbage mint burns nothing", "POST", `/api/verdict-now?mint=${GARBAGE}`, [404, 429, 500]);
if (KEY) {
	await check("run-once with key runs", "POST", `/api/run-once?key=${encodeURIComponent(KEY)}`, [200]);
} else {
	console.log("SKIP run-once with key runs (set ADMIN_KEY to enable)");
}

if (failures > 0) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("smoke-guards: all green");
