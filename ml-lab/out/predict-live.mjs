// Zero-dependency evaluator for out/model-live*.json (lightgbm-compact-v1). Drop into the Worker as-is.
//   node out/predict-live.mjs out/model-live.json   -> runs the embedded parity vectors
export function predictCompact(model, x) {
	// x: array of numbers in model.features order; null/undefined/NaN = missing
	let s = 0;
	for (const tr of model.trees) {
		let n = tr.root;
		while (n >= 0) {
			let v = x[tr.f[n]];
			const dl = tr.dl[n] & 1, mt = tr.dl[n] >> 1; // mt: 0=NaN, 1=None (missing->0), 2=Zero
			let miss = v === null || v === undefined || Number.isNaN(v);
			if (mt === 1 && miss) { v = 0; miss = false; }
			if (mt === 2 && !miss && Math.abs(v) <= 1e-35) miss = true;
			const left = miss && mt !== 1 ? dl === 1 : v <= tr.t[n];
			n = left ? tr.l[n] : tr.r[n];
		}
		s += tr.v[-n - 1];
	}
	return 1 / (1 + Math.exp(-s)); // P(dead_v2)
}

export function vectorize(model, feats) {
	return model.features.map((k) => (feats[k] === undefined ? null : feats[k]));
}

if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("predict-live.mjs")) {
	const fs = await import("node:fs");
	const m = JSON.parse(fs.readFileSync(process.argv[2] ?? new URL("./model-live.json", import.meta.url), "utf8"));
	let worst = 0;
	for (const c of m.parity) worst = Math.max(worst, Math.abs(predictCompact(m, c.x) - c.p));
	console.log(`trees=${m.n_trees} parity_n=${m.parity.length} max_abs_err=${worst.toExponential(2)} ${worst < 1e-4 ? "OK" : "FAIL"}`);
	process.exit(worst < 1e-4 ? 0 : 1);
}
