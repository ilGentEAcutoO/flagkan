"""READ-ONLY dump of FlagKan production D1 (radar-d1-main) for offline research.
SELECT statements only. Writes parquet under ml-lab/data/flagkan/ (git-ignored).
Usage (from repo root): ml-lab/.venv/Scripts/python.exe -I ml-lab/src/fk_dump.py
"""
import json, subprocess, sys, pathlib
import polars as pl

ROOT = pathlib.Path(__file__).resolve().parents[2]
RADAR = ROOT / "radar"
OUT = ROOT / "ml-lab" / "data" / "flagkan"
OUT.mkdir(parents=True, exist_ok=True)


def q(sql: str):
    assert sql.lstrip().upper().startswith("SELECT"), "read-only: SELECT only"
    cmd = f'npx wrangler d1 execute radar-d1-main --remote --json --command "{sql}"'
    raw = subprocess.run(cmd, cwd=RADAR, shell=True, capture_output=True, text=True, encoding="utf-8").stdout
    j = json.loads(raw[raw.index("["): raw.rindex("]") + 1])
    return j[0]["results"]


# Column lists: verdicts deliberately excludes columns that upgrades overwrite
# (choice, confidence, p_red, p_yellow, p_green, tier, red_source, mem_dist, upgrade_why).
TABLES = {
    "rounds": ("rowid", "rowid AS rid, mint, first_seen, source"),
    "snapshots": ("id", "id AS rid, mint, ts, price_usd, liquidity_usd, fdv, txns_5m, buys_5m, sells_5m, price_chg_h1, vol_h1, pair_age_min, feed"),
    "verdicts": ("rowid", "rowid AS rid, mint, ts, source, coordinated, severity, f_whale, f_sell, f_struct, v_rule, p_red_first, policy_v, upgraded_ts"),
    "signals": ("rowid", "rowid AS rid, mint, ts, top1_pct, top10_pct, top2_11_pct, pool_suspect, early_buys, mint_age_min, mint_auth_live, freeze_auth_live, simpson"),
    "outcomes": ("rowid", "rowid AS rid, mint, resolved_at, dead_v2, idle"),
}
PAGE = 15000

for name, (key, cols) in TABLES.items():
    rows, last = [], -1
    while True:
        page = q(f"SELECT {cols} FROM {name} WHERE {key} > {last} ORDER BY {key} LIMIT {PAGE}")
        rows += page
        if len(page) < PAGE:
            break
        last = page[-1]["rid"]
    df = pl.DataFrame(rows, infer_schema_length=None)
    df.write_parquet(OUT / f"{name}.parquet")
    print(name, df.shape, flush=True)
