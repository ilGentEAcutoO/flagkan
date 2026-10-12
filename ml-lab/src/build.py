"""Build FlagKan-equivalent labels + point-in-time features from the jocry pump.fun tape.

Run (from any dir, isolated):  .venv/Scripts/python -I src/build.py [--shards 0-17]
Output: data/derived/features.parquet  (one row per (mint, delay))

Conventions
  launch   = tokens.detected_at (matches trades.seconds_since_launch to <5 ms)
  T0       = launch + 120 s   (FlagKan median first-sight pool age = 1.76 min, measured on prod D1)
  td       = T0 + delay, delay in {0, 300, 900, 1800} s   (decision time)
  label    = evaluated at T0 + 6 h, relative to price at T0 (same label for all delays)
  Every feature uses only rows with seconds_since_launch <= td - launch (or, for cross-token
  history, events whose own timestamp / resolution time is <= td).
"""
import argparse, os, sys, time
import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, 'data', 'jocry').replace('\\', '/') + '/'
OUT = os.path.join(ROOT, 'data', 'derived')
os.makedirs(OUT, exist_ok=True)

SYS = 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s'  # System Program placeholder wallet (KI 3.3)
T0 = 120
H6 = 6 * 3600
H = 7200 - 120   # main horizon: label at launch+2h (tape complete to ~2h on Jun 5-24 only)
CUTOFF = "2026-06-24 22:00:00+00"  # launches after this have truncated (~20 min) tape
DELAYS = [0, 300, 900, 1800]
K_NORMAL = 30e9 * 1.073e15  # v_sol(lamports) * v_tok(micro) constant product for 1B-supply curves


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shards', default='0-17')
    ap.add_argument('--threads', type=int, default=4)
    a = ap.parse_args()
    lo, hi = [int(x) for x in a.shards.split('-')]
    files = [f"{D}trades/trades-{i:05d}.parquet" for i in range(lo, hi + 1)]
    files = [f for f in files if os.path.exists(f)]
    print('shards', len(files), flush=True)
    c = duckdb.connect(os.path.join(OUT, 'work.duckdb'))
    c.sql("SET TimeZone='UTC'")
    c.sql(f"SET threads={a.threads}")
    c.sql("SET memory_limit='9GB'")
    c.sql(f"SET temp_directory='{OUT.replace(chr(92), '/')}/tmp'")
    flist = '[' + ','.join(f"'{f}'" for f in files) + ']'
    t = time.time()

    def step(name, sql):
        nonlocal t
        c.sql(sql)
        print(f'{name}: {time.time() - t:.1f}s', flush=True)
        t = time.time()

    # ---- tokens -------------------------------------------------------------------------
    step('tokens', f"""
    CREATE OR REPLACE TABLE tok AS
    SELECT mint, creator, epoch(detected_at) AS launch, epoch(graduated_at) AS grad,
           coalesce(is_mayhem_mode, false) AS mayhem, coalesce(is_cashback_enabled, false) AS cashback,
           lower(trim(symbol)) AS sym, lower(trim(name)) AS nm,
           initial_buy_sol, initial_buy_tokens, dev_buy_pct_corrected AS dev_buy_pct,
           initial_holder_count, initial_top1_pct_corrected AS init_top1, initial_top10_pct_corrected AS init_top10,
           initial_gini, coalesce(top10_pct_suspect, false) AS suspect,
           creator_past_tokens AS src_creator_past, creator_past_rugs AS src_creator_rugs,
           CASE WHEN coalesce(is_mayhem_mode,false) THEN 2e9 ELSE 1e9 END AS supply
    FROM '{D}tokens.parquet' WHERE detected_at < TIMESTAMPTZ '{CUTOFF}' AND NOT coalesce(top10_pct_suspect,false)""")

    # ---- trades (cleaned) ---------------------------------------------------------------
    step('trades', f"""
    CREATE OR REPLACE TABLE tr AS
    SELECT t.mint, t.seconds_since_launch AS s, t.is_buy AS b, t.user_wallet AS w,
           t.token_amount AS ta, t.price_sol AS p,
           CASE WHEN t.sol_amount IS NULL OR t.price_sol IS NULL OR t.token_amount IS NULL OR t.token_amount<=0 THEN NULL
                WHEN t.sol_amount/(t.token_amount*t.price_sol) BETWEEN 0.01 AND 100 THEN t.sol_amount
                ELSE t.token_amount*t.price_sol END AS sol
    FROM read_parquet({flist}) t
    WHERE t.seconds_since_launch IS NOT NULL AND t.seconds_since_launch >= 0
      AND t.seconds_since_launch <= {T0 + H6 + 60}  -- keep 6h for the aux label""")
    step('trades_mint_cover', """
    CREATE OR REPLACE TABLE cover AS
    SELECT mint, COUNT(*) n_all, COUNT(p) n_price, MIN(s) s_min FROM tr GROUP BY 1""")

    # ---- labels -------------------------------------------------------------------------
    # price at T0: last priced trade at s<=T0; else the curve's initial price.
    step('labels', f"""
    CREATE OR REPLACE TABLE lab AS
    WITH a AS (
      SELECT mint,
        arg_max(p, s) FILTER (WHERE s <= {T0} AND p IS NOT NULL) AS p_t0,
        arg_max(p, s) FILTER (WHERE s <= {T0 + H} AND p IS NOT NULL) AS p_6h,
        arg_max(p, s) FILTER (WHERE s <= {T0 + H6} AND p IS NOT NULL) AS p_6h_true,
        min(p) FILTER (WHERE s > {T0} AND s <= {T0 + H}) AS p_min_6h,
        max(p) FILTER (WHERE s > {T0} AND s <= {T0 + H}) AS p_max_6h,
        COUNT(*) FILTER (WHERE s > {T0 + H - 3600} AND s <= {T0 + H}) AS n_last_hour,
        COUNT(*) FILTER (WHERE s > {T0 + H6 - 3600} AND s <= {T0 + H6}) AS n_last_hour_6h,
        MAX(s) AS s_max,
        COUNT(*) FILTER (WHERE s <= {T0}) AS n_by_t0
      FROM tr GROUP BY 1)
    SELECT k.mint, k.launch, k.grad,
      coalesce(a.p_t0, 27.958993476234855e-9 * CASE WHEN k.mayhem THEN 0.5 ELSE 1 END) AS p_t0_raw,
      a.p_t0 IS NULL AS p_t0_imputed, a.p_6h, a.p_6h_true, a.p_min_6h, a.p_max_6h, coalesce(a.n_last_hour_6h,0) AS n_last_hour_6h, a.s_max,
      coalesce(a.n_last_hour,0) AS n_last_hour, coalesce(a.n_by_t0,0) AS n_by_t0
    FROM tok k LEFT JOIN a USING(mint)""")

    # graduated within 6h: the curve tape stops; use post-graduation DEX snapshots instead.
    step('grad_labels', f"""
    CREATE OR REPLACE TABLE glab AS
    SELECT l.mint,
      arg_min(g.price_native, abs(epoch(g.snapshot_time) - (l.launch+{T0 + H}))) AS g_price,
      arg_min(coalesce(g.buys_1h,0)+coalesce(g.sells_1h,0), abs(epoch(g.snapshot_time) - (l.launch+{T0 + H}))) AS g_tx1h,
      min(abs(epoch(g.snapshot_time) - (l.launch+{T0 + H}))) AS g_gap
    FROM lab l JOIN '{D}postgard_snapshots.parquet' g USING(mint)
    WHERE l.grad IS NOT NULL AND l.grad <= l.launch + {T0 + H}
      AND epoch(g.snapshot_time) <= l.launch + {T0 + H} + 1800
    GROUP BY 1""")

    step('labels_final', f"""
    CREATE OR REPLACE TABLE labf AS
    SELECT l.*, (l.grad IS NOT NULL AND l.grad <= l.launch + {T0 + H}) AS grad6h,
      g.g_price, g.g_tx1h, g.g_gap,
      CASE WHEN (l.grad IS NOT NULL AND l.grad <= l.launch + {T0 + H}) THEN coalesce(g.g_price, l.p_6h) ELSE l.p_6h END AS p_end
    FROM lab l LEFT JOIN glab g USING(mint)""")
    step('labels_final2', f"""
    CREATE OR REPLACE TABLE labels AS
    SELECT *, p_end / p_t0_raw AS mult,
      CASE WHEN grad6h AND g_tx1h IS NOT NULL THEN (g_tx1h = 0 OR p_end <= 0.1*p_t0_raw)
           ELSE (n_last_hour = 0 OR coalesce(p_end,p_t0_raw) <= 0.1*p_t0_raw) END AS dead_v2,
      coalesce(p_end,p_t0_raw) <= 0.1*p_t0_raw AS loss90,
      coalesce(p_end,p_t0_raw) <= 0.5*p_t0_raw AS loss50,
      coalesce(p_end,p_t0_raw) >= 2.0*p_t0_raw AS win2x,
      CASE WHEN grad IS NOT NULL AND grad <= launch + {T0 + H6} THEN NULL ELSE (n_last_hour_6h = 0 OR coalesce(p_6h_true,p_t0_raw) <= 0.1*p_t0_raw) END AS dead_6h_curve
    FROM labf""")

    # ---- creator history events (point-in-time) ------------------------------------------
    # events: launch (+1 launch) at launch time; resolution (+1 resolved, +dead) at launch+T0+6h.
    # queries at td for each (mint, delay). Ties: events strictly before queries (ord).
    dl = ','.join(f'({d})' for d in DELAYS)
    step('creator_hist', f"""
    CREATE OR REPLACE TABLE chist AS
    WITH q AS (SELECT k.mint, d.d AS delay, k.creator, k.launch + {T0} + d.d AS t FROM tok k, (VALUES {dl}) d(d)),
    ev AS (
      SELECT creator, launch AS t, 0 AS ord, 1 AS dl, 0 AS dr, 0 AS dd, 0.0 AS lm, NULL::VARCHAR AS mint, NULL::INT AS delay FROM tok
      UNION ALL
      SELECT k.creator, k.launch + {T0 + H}, 0, 0, 1, (l.dead_v2)::INT, ln(greatest(coalesce(l.mult,1e-3),1e-3)), NULL, NULL
        FROM tok k JOIN labels l USING(mint)
      UNION ALL
      SELECT creator, t, 1, 0, 0, 0, 0.0, mint, delay FROM q),
    w AS (
      SELECT *, SUM(dl) OVER win AS c_launch, SUM(dr) OVER win AS c_res, SUM(dd) OVER win AS c_dead,
             SUM(lm) OVER win AS c_lm,
             MAX(CASE WHEN dl=1 THEN t END) OVER (PARTITION BY creator ORDER BY t, ord ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS last_launch_t,
             COUNT(*) FILTER (WHERE dl=1) OVER (PARTITION BY creator ORDER BY t RANGE BETWEEN 86400 PRECEDING AND CURRENT ROW) AS c_launch_24h
      FROM ev WINDOW win AS (PARTITION BY creator ORDER BY t, ord ROWS UNBOUNDED PRECEDING))
    SELECT mint, delay, c_launch - 1 AS cr_prior_launches, c_res AS cr_resolved,
           CASE WHEN c_res>0 THEN c_dead::DOUBLE/c_res END AS cr_dead_rate,
           CASE WHEN c_res>0 THEN c_lm/c_res END AS cr_mean_logmult,
           c_launch_24h - 1 AS cr_launches_24h
    FROM w WHERE ord = 1""")
    # time since creator's previous launch (strictly before this launch)
    step('creator_gap', """
    CREATE OR REPLACE TABLE cgap AS
    SELECT mint, launch - lag(launch) OVER (PARTITION BY creator ORDER BY launch) AS cr_gap_s FROM tok""")

    # ---- copycat: prior launches with the same symbol / name --------------------------------
    step('copycat', """
    CREATE OR REPLACE TABLE copy AS
    SELECT mint,
      COUNT(*) OVER (PARTITION BY sym ORDER BY launch ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS sym_prior,
      COUNT(*) OVER (PARTITION BY sym ORDER BY launch RANGE BETWEEN 86400 PRECEDING AND CURRENT ROW) - 1 AS sym_prior_24h,
      COUNT(*) OVER (PARTITION BY nm ORDER BY launch ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS name_prior
    FROM tok""")
    # (copycat counts launches strictly before this launch, all of which are <= td)

    # ---- early tape (<= T0+max delay) -------------------------------------------------------
    smax = T0 + max(DELAYS)
    step('early', f"CREATE OR REPLACE TABLE early AS SELECT * FROM tr WHERE s <= {smax}")

    # serial snipers: wallet's count of distinct earlier mints it bought within 30 s of launch
    step('snipers', """
    CREATE OR REPLACE TABLE snipe AS
    WITH f AS (SELECT e.mint, e.w, MIN(k.launch + e.s) AS ts FROM early e JOIN tok k USING(mint)
               WHERE e.b AND e.s <= 30 AND e.w IS NOT NULL AND e.w <> '""" + SYS + """' GROUP BY 1,2)
    SELECT mint, w, ts, ROW_NUMBER() OVER (PARTITION BY w ORDER BY ts) - 1 AS prior_snipes FROM f""")
    step('snipe_agg', """
    CREATE OR REPLACE TABLE snipe_agg AS
    SELECT mint, COUNT(*) AS n_snipers30, AVG(ln(1+prior_snipes)) AS snp_mean_logprior,
           MAX(prior_snipes) AS snp_max_prior, AVG((prior_snipes>=20)::INT) AS snp_frac_serial
    FROM snipe GROUP BY 1""")

    parts = []
    for d in DELAYS:
        sd = T0 + d
        step(f'feat_{d}', f"""
        CREATE OR REPLACE TABLE f_{d} AS
        WITH e AS (SELECT * FROM early WHERE s <= {sd}),
        k AS (SELECT * FROM tok),
        agg AS (
          SELECT e.mint,
            COUNT(*) AS n_tx, COUNT(*) FILTER (WHERE b) AS n_buy, COUNT(*) FILTER (WHERE NOT b) AS n_sell,
            COUNT(DISTINCT w) FILTER (WHERE b AND w<>'{SYS}') AS u_buyers,
            COUNT(DISTINCT w) FILTER (WHERE NOT b AND w<>'{SYS}') AS u_sellers,
            COUNT(DISTINCT w) FILTER (WHERE w<>'{SYS}') AS u_wallets,
            AVG((w='{SYS}')::INT) AS sys_frac,
            coalesce(SUM(sol) FILTER (WHERE b),0) AS buy_sol, coalesce(SUM(sol) FILTER (WHERE NOT b),0) AS sell_sol,
            COUNT(*) FILTER (WHERE s > {sd} - 60) AS n_tx_1m,
            COUNT(*) FILTER (WHERE s > {sd} - 300) AS n_tx_5m,
            COUNT(*) FILTER (WHERE s > {sd} - 300 AND b) AS n_buy_5m,
            COUNT(*) FILTER (WHERE s > {sd} - 300 AND NOT b) AS n_sell_5m,
            coalesce(SUM(sol) FILTER (WHERE s > {sd} - 300),0) AS vol_5m,
            {sd} - MAX(s) AS since_last_tx,
            MIN(s) AS first_tx_s,
            COUNT(*) FILTER (WHERE s <= 2 AND b) AS n_buy_2s,
            coalesce(SUM(sol) FILTER (WHERE s <= 2 AND b),0) AS buy_sol_2s,
            COUNT(*) FILTER (WHERE s <= 10 AND b) AS n_buy_10s,
            arg_max(p, s) FILTER (WHERE p IS NOT NULL) AS p_now,
            MAX(p) AS p_max, MIN(p) AS p_min,
            COUNT(*) FILTER (WHERE w = k.creator AND b) AS dev_buys,
            COUNT(*) FILTER (WHERE w = k.creator AND NOT b) AS dev_sells,
            coalesce(SUM(ta) FILTER (WHERE w = k.creator AND b),0) AS dev_buy_tok,
            coalesce(SUM(ta) FILTER (WHERE w = k.creator AND NOT b),0) AS dev_sell_tok,
            MIN(s) FILTER (WHERE w = k.creator AND NOT b) AS dev_first_sell_s
          FROM e JOIN k USING(mint) GROUP BY 1),
        vol AS (
          SELECT mint, stddev_samp(lr) AS vol_logret, MIN(dd) AS max_drawdown FROM (
            SELECT mint, ln(p) - lag(ln(p)) OVER (PARTITION BY mint ORDER BY s) AS lr,
                   p / MAX(p) OVER (PARTITION BY mint ORDER BY s ROWS UNBOUNDED PRECEDING) AS dd
            FROM e WHERE p IS NOT NULL AND p > 0) GROUP BY 1),
        hold AS (
          SELECT e.mint, e.w, SUM(CASE WHEN b THEN ta ELSE -ta END) AS net, MIN(CASE WHEN b THEN s END) AS fb
          FROM e WHERE w IS NOT NULL AND w <> '{SYS}' GROUP BY 1,2),
        hold2 AS (
          SELECT h.mint, h.w, h.fb,
            greatest(h.net + CASE WHEN h.w = k.creator THEN coalesce(k.initial_buy_tokens,0) ELSE 0 END, 0) / k.supply AS sh,
            h.w = k.creator AS is_dev
          FROM hold h JOIN k USING(mint)),
        hrank AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY mint ORDER BY sh DESC) AS r FROM hold2),
        hagg AS (
          SELECT mint, MAX(sh) FILTER (WHERE r=1) AS top1, SUM(sh) FILTER (WHERE r<=5) AS top5,
            SUM(sh) FILTER (WHERE r<=10) AS top10, SUM(sh) FILTER (WHERE r BETWEEN 2 AND 11) AS top2_11,
            SUM(sh) AS held_total, SUM(sh*sh) / nullif(SUM(sh)*SUM(sh),0) AS hhi,
            COUNT(*) FILTER (WHERE sh > 1e-6) AS holders,
            SUM(sh) FILTER (WHERE fb <= 5) AS sniper5_share,
            MAX(sh) FILTER (WHERE is_dev) AS dev_share_now
          FROM hrank GROUP BY 1)
        SELECT {d} AS delay, k.mint, a.*, v.vol_logret, v.max_drawdown, h.top1, h.top5, h.top10, h.top2_11,
               h.held_total, h.hhi, h.holders, h.sniper5_share, h.dev_share_now
        FROM k LEFT JOIN agg a USING(mint) LEFT JOIN vol v USING(mint) LEFT JOIN hagg h USING(mint)""")
        parts.append(f'f_{d}')

    union = ' UNION ALL BY NAME '.join(f'SELECT * FROM {p}' for p in parts)
    step('assemble', f"""
    CREATE OR REPLACE TABLE ds AS
    WITH f AS ({union})
    SELECT f.*, k.creator, k.launch, k.mayhem, k.cashback, k.initial_buy_sol, k.dev_buy_pct,
      k.initial_holder_count, k.init_top1, k.init_top10, k.initial_gini, k.suspect,
      k.src_creator_past, k.src_creator_rugs, k.supply,
      l.p_t0_raw, l.p_t0_imputed, l.n_by_t0, l.mult, l.dead_v2, l.loss90, l.loss50, l.win2x, l.grad6h,
      l.n_last_hour, l.grad, l.dead_6h_curve, l.n_last_hour_6h, l.s_max, cv.n_all, cv.n_price,
      ch.cr_prior_launches, ch.cr_resolved, ch.cr_dead_rate, ch.cr_mean_logmult, ch.cr_launches_24h,
      cg.cr_gap_s, cp.sym_prior, cp.sym_prior_24h, cp.name_prior,
      sa.n_snipers30, sa.snp_mean_logprior, sa.snp_max_prior, sa.snp_frac_serial
    FROM f JOIN tok k USING(mint) JOIN labels l USING(mint) LEFT JOIN cover cv USING(mint)
    LEFT JOIN chist ch ON ch.mint=f.mint AND ch.delay=f.delay
    LEFT JOIN cgap cg ON cg.mint=f.mint LEFT JOIN copy cp ON cp.mint=f.mint
    LEFT JOIN snipe_agg sa ON sa.mint=f.mint""")
    # sniper features use s<=30 which is <= T0 for every delay -> no leakage.
    out = os.path.join(OUT, 'features.parquet').replace('\\', '/')
    step('write', f"COPY ds TO '{out}' (FORMAT parquet)")
    print(c.sql("SELECT delay, COUNT(*), AVG(dead_v2::INT) FROM ds WHERE n_by_t0>0 GROUP BY 1 ORDER BY 1").fetchall())


if __name__ == '__main__':
    main()
