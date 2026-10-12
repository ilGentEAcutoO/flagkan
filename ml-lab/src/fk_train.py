"""FlagKan own-data study: v8 LR vs LightGBM on label v2 (6h), plus second look at +15/+30/+60/+120 min.
Run after fk_dump.py + fk_build.py, with the compiled radar train.js path:
  ml-lab/.venv/Scripts/python.exe -I -X utf8 ml-lab/src/fk_train.py <tsml>/train.js
Writes data/flagkan/preds.parquet, out/results_flagkan.json, out/flagkan-gbm*.json.
"""
import json, math, pathlib, subprocess, sys
import numpy as np
import polars as pl
import lightgbm as lgb
from sklearn.metrics import roc_auc_score, average_precision_score

ROOT = pathlib.Path(__file__).resolve().parents[1]
D = ROOT / "data" / "flagkan"
OUT = ROOT / "out"
TRAIN_JS = sys.argv[1]
H6 = 6 * 3600 * 1000
RNG = np.random.default_rng(7)

base = pl.read_parquet(D / "base.parquet")
n = base.height
y = base["dead_v2"].to_numpy().astype(int)
t = base["t"].to_numpy()

# ---------------- splits (time order; no shuffling) ----------------
splits = {}
k = int(n * 0.7)
splits["s70"] = {"train": list(range(k)), "test": list(range(k, n))}
b0 = int(n * 0.55)
edges = [b0, b0 + (n - b0) // 3, b0 + 2 * (n - b0) // 3, n]
for b in range(3):
    lo, hi = edges[b], edges[b + 1]
    tr = [i for i in range(lo) if t[i] < t[lo] - H6]  # 6h embargo: labels resolve 6h after first sight
    splits[f"wf{b + 1}"] = {"train": tr, "test": list(range(lo, hi))}
(D / "splits.json").write_text(json.dumps(splits))
subprocess.run(["node", str(ROOT / "src" / "fk_lr.mjs"), TRAIN_JS], check=True)
lr = json.loads((D / "lr_preds.json").read_text())
assert lr["mints"] == base["mint"].to_list()
F27 = lr["features"]
X27 = np.array(lr["X27"], dtype=float)

# ---------------- extra strictly-first-sight features ----------------
def col(c):
    return base[c].cast(pl.Float64).to_numpy()

liq, fdv = col("f_liquidity_usd"), col("f_fdv")
hour = ((t / 3.6e6) % 24)
extra = {
    "top10": col("top10_pct"),                       # signals at first sight (nulled if recomputed >10 min later)
    "coordinated": col("coordinated"),               # Jev first-sight judgments (upgrades never touch these)
    "severity": col("severity"),
    "raw_liq": liq, "raw_fdv": fdv,
    "raw_txns": col("f_txns_5m"), "raw_buys": col("f_buys_5m"), "raw_sells": col("f_sells_5m"),
    "raw_volh1": col("f_vol_h1"), "raw_chgh1": col("f_price_chg_h1"), "raw_pairage": col("f_pair_age_min"),
    "raw_early": col("early_buys"), "raw_age": col("mint_age_min"),
    "first_feed_dex": (base["f_feed"] == "dex").cast(pl.Float64).to_numpy(),
    "hour_sin": np.sin(2 * np.pi * hour / 24), "hour_cos": np.cos(2 * np.pi * hour / 24),
}
# context (cross-coin, strictly past): intake rate in the previous hour, and the dead rate of coins
# whose outcome RESOLVED before this coin's first sight (last 200 resolutions)
fs_all = np.sort(pl.read_parquet(D / "rounds.parquet")["first_seen"].to_numpy())
oc = pl.read_parquet(D / "outcomes.parquet").filter(pl.col("dead_v2").is_not_null()).sort("resolved_at")
ra, rd = oc["resolved_at"].to_numpy(), oc["dead_v2"].to_numpy().astype(float)
cum = np.concatenate([[0], np.cumsum(rd)])
ctx_rate = np.searchsorted(fs_all, t, "left") - np.searchsorted(fs_all, t - 3.6e6, "left")
j = np.searchsorted(ra, t, "left")
lo = np.maximum(0, j - 200)
ctx_dead = np.where(j - lo >= 50, (cum[j] - cum[lo]) / np.maximum(1, j - lo), np.nan)
ctx = {"ctx_intake_1h": ctx_rate.astype(float), "ctx_dead_recent": ctx_dead}

def look(T):
    p0 = col("f_price_usd"); l0 = liq
    pT, lT = col(f"s{T}_price_usd"), col(f"s{T}_liquidity_usd")
    same = (base[f"s{T}_feed"] == base["f_feed"]).cast(pl.Float64).to_numpy()
    buys, sells = col(f"s{T}_buys_5m"), col(f"s{T}_sells_5m")
    with np.errstate(all="ignore"):
        return {
            f"l{T}_has": (~np.isnan(pT)).astype(float),
            f"l{T}_logret": np.log(np.clip(pT, 1e-30, None) / np.clip(p0, 1e-30, None)),
            f"l{T}_logliq": np.where(same == 1, np.log((lT + 1) / (l0 + 1)), np.nan),   # liq only comparable within a feed
            f"l{T}_txns": col(f"s{T}_txns_5m"),
            f"l{T}_sellratio": sells / np.maximum(1, buys + sells),
            f"l{T}_vol_liq": np.log10(1 + col(f"s{T}_vol_h1") / np.maximum(1, lT)),
            f"l{T}_chgh1": col(f"s{T}_price_chg_h1"),
            f"l{T}_samefeed": np.where(np.isnan(pT), np.nan, same),
            f"l{T}_off": col(f"s{T}_off"),
        }

def mat(*dicts):
    names, cols = [], []
    for d in dicts:
        for kk, vv in d.items():
            names.append(kk); cols.append(np.asarray(vv, dtype=float))
    return names, np.column_stack(cols)

f27 = (F27, X27)
names_x, Xx = mat(extra)
names_c, Xc = mat(ctx)
SETS = {
    "f27": (F27, X27),
    "f27x": (F27 + names_x, np.hstack([X27, Xx])),
    "f27xc": (F27 + names_x + names_c, np.hstack([X27, Xx, Xc])),
}
nh = [i for i, nm in enumerate(names_x) if not nm.startswith("hour_")]
SETS["f27x_nohour"] = (F27 + [names_x[i] for i in nh], np.hstack([X27, Xx[:, nh]]))

# ---------------- metrics ----------------
def metrics(yy, p, base_rate):
    yy = np.asarray(yy); p = np.asarray(p)
    o = {"n": int(len(yy)), "base_dead": float(yy.mean())}
    if len(set(yy)) < 2:
        return o
    o["auc"] = float(roc_auc_score(yy, p))
    o["pr_auc_alive"] = float(average_precision_score(1 - yy, 1 - p))
    o["acc_at_0.5"] = float(((p > 0.5) == (yy == 1)).mean())
    o["acc_all_red"] = float(yy.mean())
    o["brier"] = float(np.mean((p - yy) ** 2)); o["brier_base"] = float(np.mean((base_rate - yy) ** 2))
    bins = np.clip((p * 10).astype(int), 0, 9)
    o["ece"] = float(sum(abs(p[bins == b].mean() - yy[bins == b].mean()) * (bins == b).mean() for b in range(10) if (bins == b).any()))
    order = np.argsort(-p, kind="stable")
    o["red_precision_at_cov"] = {str(c): float(yy[order[:max(1, int(round(c * len(yy))))]].mean()) for c in (0.2, 0.5, 0.8)}
    order = np.argsort(p, kind="stable")
    o["alive_precision_at_top"] = {str(c): float(1 - yy[order[:max(1, int(round(c * len(yy))))]].mean()) for c in (0.01, 0.05, 0.1)}
    return o

def boot_auc_diff(yy, pa, pb, reps=1000):
    yy, pa, pb = map(np.asarray, (yy, pa, pb)); d = []
    for _ in range(reps):
        i = RNG.integers(0, len(yy), len(yy))
        if len(set(yy[i])) < 2: continue
        d.append(roc_auc_score(yy[i], pb[i]) - roc_auc_score(yy[i], pa[i]))
    return [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))]

# ---------------- LightGBM ----------------
GRID = [dict(num_leaves=nl, min_data_in_leaf=md) for nl in (7, 15, 31) for md in (40, 100)]
BASEP = dict(objective="binary", learning_rate=0.03, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1,
             lambda_l2=1.0, verbose=-1, seed=7, deterministic=True, num_threads=4, feature_pre_filter=False)

def fit_gbm(X, yy, idx, min_leaf_cap=None):
    """Tune on a time-ordered validation slice (last 15% of train), refit on all train with best iters."""
    idx = np.asarray(idx); kv = int(len(idx) * 0.85)
    tr, va = idx[:kv], idx[kv:]
    best = None
    for g in GRID:
        prm = {**BASEP, **g}
        if min_leaf_cap: prm["min_data_in_leaf"] = min(prm["min_data_in_leaf"], min_leaf_cap)
        bst = lgb.train(prm, lgb.Dataset(X[tr], yy[tr]), 3000, valid_sets=[lgb.Dataset(X[va], yy[va])],
                        callbacks=[lgb.early_stopping(150, verbose=False)], feval=None)
        pv = bst.predict(X[va], num_iteration=bst.best_iteration)
        a = roc_auc_score(yy[va], pv) if len(set(yy[va])) > 1 else 0
        if best is None or a > best[0]:
            best = (a, prm, max(20, bst.best_iteration))
    a, prm, it = best
    it = int(round(it / 0.85))
    bst = lgb.train(prm, lgb.Dataset(X[idx], yy[idx]), it)
    return bst, {"val_auc": float(a), "num_leaves": prm["num_leaves"], "min_data_in_leaf": prm["min_data_in_leaf"], "iters": it}

res = {"generated": "2026-10-12", "data": {}, "first_sight": {}, "second_look": {}, "notes": {}}
res["data"] = {
    "source": "radar-d1-main (read-only SELECT dump), label outcomes.dead_v2 (6h)",
    "n_graded": int(n), "base_dead": float(y.mean()),
    "period_utc": [str(base["t"].min()), str(base["t"].max())],
    "splits": {kk: {"n_train": len(v["train"]), "n_test": len(v["test"])} for kk, v in splits.items()},
    "coverage": {f"+{T}m": int(base[f"s{T}_off"].is_not_null().sum()) for T in (15, 30, 60, 120)},
}
res["validator_check"] = lr["validator"]

preds = {"mint": base["mint"].to_list()}
store = {}
for sp, S in splits.items():
    tr, te = np.array(S["train"]), np.array(S["test"])
    br = float(y[tr].mean())
    out = {}
    p_lr = np.array(lr["preds"][sp]); store[(sp, "lr_f27")] = p_lr
    out["lr_f27 (v8 code)"] = metrics(y[te], p_lr, br)
    for sname, (names, X) in SETS.items():
        bst, info = fit_gbm(X, y, tr)
        p = bst.predict(X[te]); store[(sp, "gbm_" + sname)] = p
        m = metrics(y[te], p, br); m["tuning"] = info
        if sp == "s70":
            gain = bst.feature_importance("gain"); gain = gain / gain.sum()
            m["top_gain"] = {names[i]: round(float(gain[i]), 3) for i in np.argsort(-gain)[:10]}
            m["auc_diff_vs_lr_ci95"] = boot_auc_diff(y[te], p_lr, p)
        out["gbm_" + sname] = m
    res["first_sight"][sp] = out
    print(sp, {kk: round(v.get("auc", float("nan")), 4) for kk, v in out.items()}, flush=True)

# walk-forward pooled + per-block stability
pooled = {}
wf_te = np.concatenate([splits[f"wf{b}"]["test"] for b in (1, 2, 3)])
for name in ["lr_f27", "gbm_f27", "gbm_f27x", "gbm_f27xc", "gbm_f27x_nohour"]:
    p = np.concatenate([store[(f"wf{b}", name)] for b in (1, 2, 3)])
    m = metrics(y[wf_te], p, float(y[splits["wf1"]["train"]].mean()))
    m["auc_by_block"] = [res["first_sight"][f"wf{b}"][name if name != "lr_f27" else "lr_f27 (v8 code)"].get("auc") for b in (1, 2, 3)]
    pooled[name] = m
res["first_sight"]["wf_pooled"] = pooled

# ---------------- second look ----------------
# A = first-sight GBM (best set); B = same GBM features + look features at +T (NaN when no snapshot by T).
# Evaluated on the COVERED test rows only (both models score the same rows), pooled over the 3 WF blocks + s70 shown separately.
best_set = "f27x"
for T in ((15, 30, 60, 120) if "--no-look" not in sys.argv else ()):
    names_l, Xl = mat(look(T))
    nB, XB = SETS[best_set][0] + names_l, np.hstack([SETS[best_set][1], Xl])
    cov = ~np.isnan(Xl[:, 1])
    rT = {"coverage_all": int(cov.sum()), "coverage_dead_rate": float(y[cov].mean()) if cov.any() else None}
    for grp, sps in (("s70", ["s70"]), ("wf_pooled", ["wf1", "wf2", "wf3"])):
        ys, pa, pb, pb_cov = [], [], [], []
        for sp in sps:
            tr, te = np.array(splits[sp]["train"]), np.array(splits[sp]["test"])
            bstB, _ = fit_gbm(XB, y, tr)
            # B2: trained ONLY on covered train rows (the population that actually has a look)
            trc = tr[cov[tr]]
            tec = te[cov[te]]
            if len(tec) == 0: continue
            ys.append(y[tec]); pa.append(store[(sp, "gbm_" + best_set)][cov[te]]); pb.append(bstB.predict(XB[tec]))
            if len(trc) >= 80 and len(set(y[trc])) > 1:
                bstC, _ = fit_gbm(XB, y, trc, min_leaf_cap=20)
                pb_cov.append(bstC.predict(XB[tec]))
            else:
                pb_cov.append(np.full(len(tec), np.nan))
        if not ys: continue
        ys, pa, pb, pc = map(np.concatenate, (ys, pa, pb, pb_cov))
        e = {"n_covered_test": int(len(ys)), "dead_rate": float(ys.mean()),
             "A_first_sight": metrics(ys, pa, ys.mean()), "B_look_all_train": metrics(ys, pb, ys.mean())}
        if len(set(ys)) > 1:
            e["auc_lift_B_minus_A_ci95"] = boot_auc_diff(ys, pa, pb)
            if not np.isnan(pc).any():
                e["C_look_covered_train"] = metrics(ys, pc, ys.mean())
                e["auc_lift_C_minus_A_ci95"] = boot_auc_diff(ys, pa, pc)
        rT[grp] = e
        print(f"+{T}m {grp}: n={len(ys)} A={e['A_first_sight'].get('auc')} B={e['B_look_all_train'].get('auc')} C={e.get('C_look_covered_train', {}).get('auc')}", flush=True)
    res["second_look"][f"+{T}m"] = rT

if "--no-look" in sys.argv:
    old = json.loads((OUT / "results_flagkan.json").read_text())
    res["second_look"] = old.get("second_look", {})

# ---------------- export live-feasible first-sight GBMs ----------------
def compact(bst, cols):
    d = bst.dump_model()
    trees = []
    for tt in d["tree_info"]:
        F, Tt, DL, L, R, V = [], [], [], [], [], []
        def walk(nd):
            if "leaf_value" in nd:
                V.append(float(nd["leaf_value"])); return -len(V)
            i = len(F); F.append(nd["split_feature"]); Tt.append(float(nd["threshold"]))
            assert nd["decision_type"] == "<=" and nd.get("missing_type") in ("NaN", "None", "Zero", None)
            mt = {"NaN": 0, "None": 1, "Zero": 2}[nd.get("missing_type") or "None"]
            DL.append((1 if nd["default_left"] else 0) + 2 * mt); L.append(None); R.append(None)
            L[i] = walk(nd["left_child"]); R[i] = walk(nd["right_child"]); return i
        root = walk(tt["tree_structure"])
        trees.append({"f": F, "t": Tt, "dl": DL, "l": L, "r": R, "v": V, "root": root})
    return {"kind": "lightgbm-compact-v1", "features": cols, "n_trees": len(trees), "trees": trees,
            "link": "sigmoid(sum of leaf values)",
            "missing": "dl = default_left + 2*missing_type; missing_type 0=NaN, 1=None (NaN->0.0), 2=Zero"}

def predict_compact(m, X):
    out = np.zeros(len(X))
    for tr in m["trees"]:
        for r_ in range(len(X)):
            nd = tr["root"]
            while nd >= 0:
                x = X[r_, tr["f"][nd]]; dl = tr["dl"][nd] & 1; mt = tr["dl"][nd] >> 1
                if mt == 1 and np.isnan(x): x = 0.0
                if (mt == 0 and np.isnan(x)) or (mt == 2 and (np.isnan(x) or abs(x) <= 1e-35)): left = dl == 1
                else: left = x <= tr["t"][nd]
                nd = tr["l"][nd] if left else tr["r"][nd]
            out[r_] += tr["v"][-nd - 1]
    return 1 / (1 + np.exp(-out))

res["export"] = {}
# f27x_nohour ties f27 (the f27x gain was hour-of-day = regime risk on 6 days), so only the drop-in f27 model ships.
for fname, sname, desc in (("flagkan-gbm.json", "f27", "drop-in: input = buildFeatures(row) (27 dims, radar/src/ml/train.ts FEATURES order)"),):
    names, X = SETS[sname]
    tun = res["first_sight"]["s70"]["gbm_" + sname]["tuning"]
    prm = {**BASEP, "num_leaves": tun["num_leaves"], "min_data_in_leaf": tun["min_data_in_leaf"]}
    bst = lgb.train(prm, lgb.Dataset(X, y), int(round(tun["iters"] * n / len(splits["s70"]["train"]))))
    m = compact(bst, names)
    idx = np.arange(n - 200, n)
    p_lgb = bst.predict(X[idx]); p_cmp = predict_compact(m, X[idx])
    m["parity"] = [{"x": [None if np.isnan(v) else float(v) for v in X[i]], "p": float(pp)} for i, pp in zip(idx, p_lgb)]
    m["trained_on"] = {"n": int(n), "label": "outcomes.dead_v2", "period": res["data"]["period_utc"], "params": prm, "iters": m["n_trees"], "note": desc}
    (OUT / fname).write_text(json.dumps(m))
    js = subprocess.run(["node", str(ROOT / "src" / "fk_parity.mjs"), str(OUT / fname)], capture_output=True, text=True)
    res["export"][fname] = {"set": sname, "n_trees": m["n_trees"], "py_compact_vs_lightgbm_max_abs": float(np.max(np.abs(p_lgb - p_cmp))),
                            "js_parity": js.stdout.strip(), "bytes": (OUT / fname).stat().st_size}
    print(fname, res["export"][fname], flush=True)

(OUT / "results_flagkan.json").write_text(json.dumps(res, indent=1))
json.dump({f"{a}|{b}": v.tolist() for (a, b), v in store.items()} | {"splits": splits}, open(D / "preds.json", "w"))
print("wrote out/results_flagkan.json")
