"""Build FlagKan's own first-sight table + second-look snapshots from the D1 dump.
Mirrors RETRAIN_SQL_V2 + rowFromDb (radar/src/ml/train.ts) for the 27-dim live set, but over ALL graded
rows (not newest 8000), keyed by rounds.first_seen.
Output: data/flagkan/base.parquet, data/flagkan/trainrows.json (TrainRow shape for the real TS code).
"""
import json, pathlib
import numpy as np
import polars as pl

ROOT = pathlib.Path(__file__).resolve().parents[1]
D = ROOT / "data" / "flagkan"
SIG_FIRST_SIGHT_MS = 10 * 60 * 1000

r = pl.read_parquet(D / "rounds.parquet").drop("rid")
s = pl.read_parquet(D / "snapshots.parquet")
v = pl.read_parquet(D / "verdicts.parquet").drop("rid")
g = pl.read_parquet(D / "signals.parquet").drop("rid")
o = pl.read_parquet(D / "outcomes.parquet").drop("rid")

# first snapshot per mint (ORDER BY ts ASC LIMIT 1; tie -> lowest id)
s = s.sort(["mint", "ts", "rid"])
first = s.group_by("mint", maintain_order=True).first().rename({c: "f_" + c for c in s.columns if c != "mint"})

base = (o.filter(pl.col("dead_v2").is_not_null())
        .join(v.rename({"ts": "v_ts", "source": "v_source"}), on="mint", how="inner")  # RETRAIN_SQL_V2 joins verdicts
        .join(r, on="mint", how="left")
        .join(g.rename({"ts": "sig_ts"}), on="mint", how="left")
        .join(first, on="mint", how="left"))
# rowFromDb: signals recomputed > 10 min after first sight are nulled
sig_cols = ["top1_pct", "top10_pct", "top2_11_pct", "early_buys", "mint_age_min", "pool_suspect",
            "mint_auth_live", "freeze_auth_live", "simpson"]
bad = (pl.col("first_seen").is_not_null() & pl.col("sig_ts").is_not_null()
       & (pl.col("sig_ts") > pl.col("first_seen") + SIG_FIRST_SIGHT_MS))
base = base.with_columns([pl.when(bad).then(None).otherwise(pl.col(c)).alias(c) for c in sig_cols])
base = base.with_columns(t=pl.coalesce("first_seen", "v_ts")).sort("t")
print("graded rows:", base.height, "dead rate:", round(base["dead_v2"].mean(), 4),
      "sig nulled (late):", int(base.select(bad.sum()).item() or 0))

# ---- second look: latest snapshot with 1 < offset <= T min; must NOT be the coin's last snapshot
# (the label reads the last snapshot; requiring a later one keeps the look strictly before the label sample)
s2 = s.join(r.select("mint", "first_seen"), on="mint").with_columns(off=(pl.col("ts") - pl.col("first_seen")) / 60000)
last_ts = s.group_by("mint").agg(pl.col("ts").max().alias("last_ts"))
s2 = s2.join(last_ts, on="mint")
for T in (15, 30, 60, 120):
    cand = s2.filter((pl.col("off") > 1) & (pl.col("off") <= T) & (pl.col("ts") < pl.col("last_ts")))
    look = cand.sort(["mint", "ts"]).group_by("mint", maintain_order=True).last()
    look = look.select(["mint"] + [pl.col(c).alias(f"s{T}_{c}") for c in
                       ["off", "price_usd", "liquidity_usd", "fdv", "txns_5m", "buys_5m", "sells_5m",
                        "price_chg_h1", "vol_h1", "feed"]])
    # count of snapshots taken by T (refresh intensity is itself a live-known fact)
    nsnap = s2.filter(pl.col("off") <= T).group_by("mint").agg(pl.len().alias(f"s{T}_nsnap"))
    base = base.join(look, on="mint", how="left").join(nsnap, on="mint", how="left")
    print(f"+{T}m coverage: {base[f's{T}_off'].is_not_null().sum()} / {base.height}")

base.write_parquet(D / "base.parquet")


def nn(x):
    return None if x is None or (isinstance(x, float) and not np.isfinite(x)) else x


rows = []
for d in base.iter_rows(named=True):
    rows.append({
        "ts": d["t"], "dead": int(d["dead_v2"]), "choice": "yellow",
        "liq": nn(d["f_liquidity_usd"]), "fdv": nn(d["f_fdv"]), "txns": nn(d["f_txns_5m"]),
        "buys": nn(d["f_buys_5m"]), "sells": nn(d["f_sells_5m"]), "chgH1": nn(d["f_price_chg_h1"]),
        "volH1": nn(d["f_vol_h1"]), "pairAge": nn(d["f_pair_age_min"]),
        "top1": nn(d["top1_pct"]), "t211": nn(d["top2_11_pct"]), "early": nn(d["early_buys"]),
        "age": nn(d["mint_age_min"]), "pool": nn(d["pool_suspect"]), "mintLive": nn(d["mint_auth_live"]),
        "freezeLive": nn(d["freeze_auth_live"]), "simpson": nn(d["simpson"]),
        "fWhale": nn(d["f_whale"]), "fSell": nn(d["f_sell"]), "fStruct": nn(d["f_struct"]),
        "src": d["source"], "mint": d["mint"],
    })
(D / "trainrows.json").write_text(json.dumps({"label": "v2", "n": len(rows), "rows": rows}))
print("wrote base.parquet + trainrows.json")
