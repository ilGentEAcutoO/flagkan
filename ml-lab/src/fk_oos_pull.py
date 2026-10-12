"""READ-ONLY pull of out-of-sample live verdicts for the GBM-vs-LR replay (W11 / LAB-003).
Same first-sight rowset as RETRAIN_SQL_V2 (radar/src/ml/train.ts): first non-look snapshot,
signals + Jev factors, plus the stored live choice / tier / p_lr_first / p_gbm_first.
Set A: source='live', dead_v2 NOT NULL, rounds.first_seen > GBM training cutoff.
Set B: any verdict with stored p_lr_first AND p_gbm_first (parity check; may be ungraded).
Writes data/flagkan/oos/{oos_rows,parity_rows,models}.json (git-ignored).
Usage: ml-lab/.venv/Scripts/python.exe -I ml-lab/src/fk_oos_pull.py
"""
import json, subprocess, pathlib
import polars as pl

ROOT = pathlib.Path(__file__).resolve().parents[2]
RADAR = ROOT / "radar"
D = ROOT / "ml-lab" / "data" / "flagkan"
OUT = D / "oos"
OUT.mkdir(parents=True, exist_ok=True)


def q(sql: str):
    assert sql.lstrip().upper().startswith("SELECT"), "read-only: SELECT only"
    cmd = f'npx wrangler d1 execute radar-d1-main --remote --json --command "{sql}"'
    raw = subprocess.run(cmd, cwd=RADAR, shell=True, capture_output=True, text=True, encoding="utf-8").stdout
    j = json.loads(raw[raw.index("["): raw.rindex("]") + 1])
    return j[0]["results"]


# GBM training cutoff = max first-sight time in its training dump (trainrows.json is built from base.parquet).
base = pl.read_parquet(D / "base.parquet", columns=["mint", "t"])
CUT = int(base["t"].max())
train_mints = set(base["mint"].to_list())

SNAP = "(SELECT {c} FROM snapshots s WHERE s.mint = v.mint AND s.look IS NULL ORDER BY ts ASC LIMIT 1) AS {a}"
snap = ", ".join(SNAP.format(c=c, a=a) for c, a in [
    ("liquidity_usd", "liq"), ("fdv", "fdv"), ("txns_5m", "txns"), ("buys_5m", "buys"), ("sells_5m", "sells"),
    ("price_chg_h1", "chgH1"), ("vol_h1", "volH1"), ("pair_age_min", "pairAge")])
COLS = ("v.mint AS mint, v.ts AS ts, o.dead_v2 AS dead, v.choice AS choice, v.tier AS tier, v.v_rule AS vRule, "
        "v.red_source AS redSource, v.policy_v AS policyV, v.upgraded_ts AS upTs, v.source AS vsrc, "
        "v.p_lr_first AS pLr, v.p_gbm_first AS pGbm, v.gbm_v AS gbmV, r.first_seen AS seen, g.ts AS sigTs, "
        + snap + ", g.top1_pct AS top1, g.top2_11_pct AS t211, g.early_buys AS early, g.mint_age_min AS age, "
        "g.pool_suspect AS pool, g.mint_auth_live AS mintLive, g.freeze_auth_live AS freezeLive, g.simpson AS simpson, "
        "v.f_whale AS fWhale, v.f_sell AS fSell, v.f_struct AS fStruct, r.source AS src")
FROM = ("FROM verdicts v LEFT JOIN outcomes o ON o.mint = v.mint LEFT JOIN signals g ON g.mint = v.mint "
        "LEFT JOIN rounds r ON r.mint = v.mint")

A = q(f"SELECT {COLS} {FROM} WHERE v.source = 'live' AND o.dead_v2 IS NOT NULL AND r.first_seen > {CUT} ORDER BY r.first_seen")
A = [r for r in A if r["mint"] not in train_mints]
B = q(f"SELECT {COLS} {FROM} WHERE v.p_lr_first IS NOT NULL AND v.p_gbm_first IS NOT NULL ORDER BY v.ts")
M = q("SELECT version, created_at, weights, bias, features, n_train, label_v, promoted FROM models "
      "WHERE label_v = 2 AND promoted = 1 ORDER BY version DESC LIMIT 1")
json.dump({"cutoff": CUT, "n_train_mints": len(train_mints), "rows": A}, open(OUT / "oos_rows.json", "w"))
json.dump({"rows": B}, open(OUT / "parity_rows.json", "w"))
json.dump(M, open(OUT / "models.json", "w"))
print("cutoff", CUT, "A", len(A), "B", len(B), "champ", M[0]["version"], M[0]["n_train"])
