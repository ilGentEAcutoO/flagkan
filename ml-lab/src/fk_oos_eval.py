"""Metrics for the OOS replay (GBM challenger vs live LR champion vs v8 gold) + stored-score parity.
Reads data/flagkan/oos/scored.json (fk_oos_score.mjs); writes out/results_oos_replay.json.
Usage: ml-lab/.venv/Scripts/python.exe -I ml-lab/src/fk_oos_eval.py
"""
import json, pathlib, datetime as dt
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
S = json.load(open(ROOT / "data" / "flagkan" / "oos" / "scored.json"))
rows = S["oos"]
y = np.array([r["dead"] for r in rows], dtype=float)
n, base = len(y), float(y.mean())
T_SURE = 0.996
iso = lambda ms: dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def auc(p, y):
    from scipy.stats import rankdata
    r = rankdata(p); npos = y.sum(); nneg = len(y) - npos
    return float((r[y == 1].sum() - npos * (npos + 1) / 2) / (npos * nneg)) if npos and nneg else None


def boot_ci(p, y, B=2000, seed=7):
    rng = np.random.default_rng(seed); out = []
    for _ in range(B):
        i = rng.integers(0, len(y), len(y)); a = auc(p[i], y[i])
        if a is not None: out.append(a)
    return [round(float(np.percentile(out, 2.5)), 4), round(float(np.percentile(out, 97.5)), 4)]


def red_prec_at_cov(p, y, cov):
    k = max(1, int(round(cov * len(y)))); idx = np.argsort(-p, kind="stable")[:k]
    return {"k": k, "precision": round(float(y[idx].mean()), 4)}


def survivor(p, y, frac):
    k = max(1, int(round(frac * len(y)))); idx = np.argsort(p, kind="stable")[:k]
    return {"k": k, "alive": int((1 - y[idx]).sum()), "alive_rate": round(float((1 - y[idx]).mean()), 4)}


def model_block(key):
    p = np.array([r[key] for r in rows], dtype=float)
    red = p > 0.5
    sure = p >= T_SURE
    return {
        "auc": round(auc(p, y), 4), "auc_ci95": boot_ci(p, y),
        "acc_p05": round(float(((red & (y == 1)) | (~red & (y == 0))).mean()), 4), "n_red_p05": int(red.sum()),
        "red_precision_p05": round(float(y[red].mean()), 4) if red.any() else None,
        "brier": round(float(((p - y) ** 2).mean()), 4),
        "red_prec_cov50": red_prec_at_cov(p, y, 0.5), "red_prec_cov80": red_prec_at_cov(p, y, 0.8),
        "survivor_low5": survivor(p, y, 0.05), "survivor_low10": survivor(p, y, 0.10),
        "red_sure_0996": {"n": int(sure.sum()), "dead": int(y[sure].sum()),
                          "precision": round(float(y[sure].mean()), 4) if sure.any() else None},
        "mean_p": round(float(p.mean()), 4),
    }


def lights(choices):
    c = np.array(choices); red = c == "red"
    return {"acc": round(float(((red & (y == 1)) | (~red & (y == 0))).mean()), 4),
            "red": int(red.sum()), "yellow": int((c == "yellow").sum()), "green": int((c == "green").sum()),
            "red_precision": round(float(y[red].mean()), 4) if red.any() else None,
            "green_alive_rate": round(float((1 - y[c == "green"]).mean()), 4) if (c == "green").any() else None}


def simple(key):
    out = []
    for r in rows:
        p = r[key]; out.append("red" if p > 0.5 else "green" if p <= 0.3 else "yellow")
    return out


seen = [r["seen"] for r in rows]
res = {
    "what": "Out-of-sample replay: coins first seen AFTER the GBM training dump cutoff, never in its training set",
    "gbm_v": S["gbm_v"], "lr_champion": S["champ"], "v8_gold": S["gold"],
    "gbm_train_cutoff_first_seen": S["cutoff"], "gbm_train_cutoff_iso": iso(S["cutoff"]),
    "n": n, "first_seen_range": [iso(min(seen)), iso(max(seen))], "dead_rate": round(base, 4),
    "all_red_acc": round(base, 4), "base_rate_brier": round(base * (1 - base), 4),
    "models": {"gbm": model_block("pGbm"), "lr_v9": model_block("pLr"), "gold_v8": model_block("pGold")},
    "policy_replay": {
        "note": "simple = RED if P>0.5, GREEN if P<=0.3, else YELLOW (no rules); policyV2_rules = policyV2(p, hardRed(row), jev=null); "
                "stored_live = verdicts.choice (includes hard rules, Jev green lift and later upgrades, so not first-sight-only). "
                "acc counts RED correct iff dead, YELLOW/GREEN correct iff alive.",
        "gbm_simple": lights(simple("pGbm")), "lr_v9_simple": lights(simple("pLr")),
        "gbm_policyV2_rules": lights([r["polGbm"] for r in rows]), "lr_v9_policyV2_rules": lights([r["polLr"] for r in rows]),
        "stored_live": lights([r["choice"] for r in rows]),
        "stored_live_upgraded_n": int(sum(1 for r in rows if r["upTs"] is not None)),
        "gbm_vs_lr_simple_disagree": int(sum(a != b for a, b in zip(simple("pGbm"), simple("pLr")))),
    },
}
# parity: rebuilt offline scores vs stored live p_lr_first / p_gbm_first
P = S["parity"]
dl = [abs(r["pLr"] - r["storedLr"]) for r in P]; dg = [abs(r["pGbm"] - r["storedGbm"]) for r in P]
res["parity"] = {
    "n": len(P), "graded": int(sum(1 for r in P if r["dead"] is not None)),
    "lr_max_abs": round(max(dl), 6) if dl else None, "lr_within_1e-6": int(sum(d < 1e-6 for d in dl)),
    "gbm_max_abs": round(max(dg), 6) if dg else None, "gbm_within_1e-6": int(sum(d < 1e-6 for d in dg)),
    "lr_within_1e-3": int(sum(d < 1e-3 for d in dl)), "gbm_within_1e-3": int(sum(d < 1e-3 for d in dg)),
    "lr_median_abs": round(float(np.median(dl)), 6) if dl else None, "gbm_median_abs": round(float(np.median(dg)), 6) if dg else None,
}
(ROOT / "out" / "results_oos_replay.json").write_text(json.dumps(res, indent=1))
print(json.dumps(res, indent=1))
