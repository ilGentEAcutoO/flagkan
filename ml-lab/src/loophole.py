"""Study 2: loopholetape pump.fun launches (Aug 31 - Oct 4 2026, 1.23M launches).

No trade tape -> no 6h price path. Used for: (a) creator-history value at full-population
scale on recent data, (b) a <=60 s launch model. Targets: rugged (dev dump / drain, the
dataset's rule) and graduated (true survivor). Train Sep 27 - Oct 1, test Oct 2 - Oct 4.

  .venv/Scripts/python -I src/loophole.py   -> out/results_loophole.json
"""
import json, os, time
import duckdb, numpy as np, pandas as pd
import lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, average_precision_score

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, 'data', 'loophole', 'data').replace('\\', '/')
OUT = os.path.join(ROOT, 'out')


def build():
    c = duckdb.connect(); c.sql("SET threads=4")
    c.sql(f"""CREATE TABLE L AS SELECT * FROM read_parquet(['{D}/launches_legacy/*.parquet','{D}/launches/*.parquet'], union_by_name=true)""")
    # resolution time of each launch's outcome, for point-in-time creator history
    c.sql("""CREATE TABLE ev AS SELECT mint, creator, t0, lower(trim(symbol)) sym, lower(trim(name)) nm,
        rugged, graduated, peak_rs,
        CASE WHEN rugged=1 THEN t0 + rug_dt_s
             WHEN graduated=1 THEN t0 + coalesce(migrate_dt_s, 86400)
             ELSE t0 + 86400 END AS t_res
      FROM L""")
    c.sql("""CREATE TABLE q AS SELECT mint, creator, t0 + 60 AS t FROM L WHERE decoder_complete = 1""")
    c.sql("""CREATE TABLE hist AS
      WITH e AS (
        SELECT creator, t0 AS t, 0 ord, 1 dl, 0 dr, 0 drug, 0 dgrad, 0.0 dpk, NULL::VARCHAR mint FROM ev
        UNION ALL SELECT creator, t_res, 0, 0, 1, coalesce(rugged,0), coalesce(graduated,0), ln(1+coalesce(peak_rs,0)), NULL FROM ev
          WHERE rugged IS NOT NULL OR graduated IS NOT NULL
        UNION ALL SELECT creator, t, 1, 0, 0, 0, 0, 0.0, mint FROM q),
      w AS (SELECT *, SUM(dl) OVER win cl, SUM(dr) OVER win cr, SUM(drug) OVER win crug, SUM(dgrad) OVER win cg, SUM(dpk) OVER win cpk,
              COUNT(*) FILTER (WHERE dl=1) OVER (PARTITION BY creator ORDER BY t RANGE BETWEEN 86400 PRECEDING AND CURRENT ROW) c24
            FROM e WINDOW win AS (PARTITION BY creator ORDER BY t, ord ROWS UNBOUNDED PRECEDING))
      SELECT mint, cl - 1 AS cr_prior, cr AS cr_res, CASE WHEN cr>0 THEN crug::DOUBLE/cr END cr_rug_rate,
             CASE WHEN cr>0 THEN cg::DOUBLE/cr END cr_grad_rate, CASE WHEN cr>0 THEN cpk/cr END cr_mean_logpeak, c24 - 1 AS cr_24h
      FROM w WHERE ord=1""")
    # cl counts the launch itself (its launch event at t0 <= t0+60) -> minus 1
    c.sql("""CREATE TABLE cp AS SELECT mint,
        COUNT(*) OVER (PARTITION BY sym ORDER BY t0 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) sym_prior,
        COUNT(*) OVER (PARTITION BY sym ORDER BY t0 RANGE BETWEEN 86400 PRECEDING AND CURRENT ROW) - 1 sym_24h,
        COUNT(*) OVER (PARTITION BY nm ORDER BY t0 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) name_prior,
        t0 - lag(t0) OVER (PARTITION BY creator ORDER BY t0) cr_gap_s FROM ev""")
    return c.sql("""SELECT L.*, h.* EXCLUDE (mint), cp.* EXCLUDE (mint) FROM L JOIN hist h USING(mint) JOIN cp USING(mint)
      WHERE L.decoder_complete = 1 AND L.quote_asset = 'sol'""").df()


FEATS_LAUNCH = ['dev_buy_sol', 'dev_share', 'mayhem', 'holder_reward', 'creator_fee_bps',
                'f10_dev_share', 'f10_insider_share', 'f10_bundle_wallets', 'f10_rs', 'f10_n_buys',
                'f60_rs', 'f60_insider_share', 'hour_sin', 'hour_cos']
FEATS_HIST = ['cr_prior', 'cr_res', 'cr_rug_rate', 'cr_grad_rate', 'cr_mean_logpeak', 'cr_24h', 'cr_gap_s',
              'sym_prior', 'sym_24h', 'name_prior']


def prec_at(y, p, covs):
    o = np.argsort(-p); ys = y[o]
    return {f'{c:g}': float(ys[:max(1, int(len(y) * c))].mean()) for c in covs}


def main():
    t = time.time()
    df = build()
    print('rows', len(df), round(time.time() - t, 1), flush=True)
    hr = pd.to_datetime(df.t0, unit='s', utc=True).dt.hour
    df['hour_sin'] = np.sin(2 * np.pi * hr / 24); df['hour_cos'] = np.cos(2 * np.pi * hr / 24)
    for c in ['cr_prior', 'cr_res', 'cr_24h', 'sym_prior', 'sym_24h', 'name_prior', 'cr_gap_s']:
        df[c] = np.log1p(df[c].astype(float))
    # only rows whose early features are trustworthy (capture lag <= 1 s, no stream silence)
    df = df[(df.features_basis == 'tape_replay') & (df.silence_60s.fillna(0) == 0)].copy()
    n0 = len(df)
    # honest population: outcome NOT already visible at the decision time (t0+60 s)
    df = df[(df.rug_dt_s.isna() | (df.rug_dt_s > 60)) & (df.migrate_dt_s.isna() | (df.migrate_dt_s > 60))].copy()
    print('undecided at 60s:', len(df), 'of', n0, flush=True)
    cut = pd.Timestamp('2026-10-02', tz='UTC').timestamp()
    res = {}
    for target in ['rugged', 'graduated']:
        d = df[df[target].notna()].copy()
        y = d[target].astype(int).values
        tr = d.t0.values < cut - 86400  # 24h embargo (outcome resolution)
        te = d.t0.values >= cut
        for sname, cols in [('launch', FEATS_LAUNCH), ('launch+history', FEATS_LAUNCH + FEATS_HIST), ('history_only', FEATS_HIST + ['mayhem'])]:
            X = d[cols].astype(float)
            for mname in ['lr', 'gbm']:
                if mname == 'gbm':
                    dt = lgb.Dataset(X[tr], y[tr])
                    b = lgb.train(dict(objective='binary', learning_rate=0.05, num_leaves=63, min_data_in_leaf=200,
                                       feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, verbose=-1, num_threads=4), dt, 400)
                    p = b.predict(X[te])
                    gi = pd.Series(b.feature_importance('gain'), index=cols); gi = gi / gi.sum()
                else:
                    med = X[tr].median(); Xf = X.fillna(med); mu, sd = Xf[tr].mean(), Xf[tr].std().replace(0, 1)
                    m = LogisticRegression(max_iter=2000).fit(((Xf[tr] - mu) / sd).values, y[tr])
                    p = m.predict_proba(((Xf[te] - mu) / sd).values)[:, 1]; gi = None
                yt = y[te]
                r = {'n_train': int(tr.sum()), 'n_test': int(te.sum()), 'base': float(yt.mean()),
                     'auc': float(roc_auc_score(yt, p)), 'pr_auc_pos': float(average_precision_score(yt, p)),
                     'pr_auc_neg': float(average_precision_score(1 - yt, 1 - p)),
                     'prec_pos_at_top': prec_at(yt, p, [0.01, 0.05, 0.1, 0.2, 0.5]),
                     'brier': float(np.mean((p - yt) ** 2))}
                if gi is not None:
                    r['gain_top'] = {k: float(v) for k, v in gi.sort_values(ascending=False).head(12).items()}
                key = f'{target}|{sname}|{mname}'; res[key] = r
                print(key, {k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items() if k not in ('gain_top',)}, flush=True)
    json.dump(res, open(os.path.join(OUT, 'results_loophole.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
