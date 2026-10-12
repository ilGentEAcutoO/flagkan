"""Walk-forward evaluation: LR vs LightGBM x decision delay x feature set.

  .venv/Scripts/python -I src/train.py            -> out/results_jocry.json
Strict time split: each test block is scored by a model trained only on coins launched
before (block start - 2h embargo, the label horizon). No shuffling across time.
"""
import json, os, sys, time, warnings
import numpy as np, pandas as pd
import lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, average_precision_score

warnings.filterwarnings('ignore')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DER = os.path.join(ROOT, 'data', 'derived')
OUT = os.path.join(ROOT, 'out'); os.makedirs(OUT, exist_ok=True)
LABEL = os.environ.get('LABEL', 'dead_v2')


def engineer(df):
    f = pd.DataFrame(index=df.index)
    p_init = 27.958993476234855e-9 * np.where(df.mayhem, 0.5, 1.0)
    f['age_min'] = (120 + df.delay) / 60.0
    f['ret_since_launch'] = np.log(df.p_now.fillna(df.p_t0_raw) / p_init)
    f['ret_from_t0'] = np.log(df.p_now.fillna(df.p_t0_raw) / df.p_t0_raw)
    f['p_max_ratio'] = np.log(df.p_max.fillna(df.p_t0_raw) / p_init)
    f['drawdown'] = np.log(df.p_now.fillna(df.p_t0_raw) / df.p_max.fillna(df.p_t0_raw))
    f['max_drawdown'] = df.max_drawdown
    f['vol_logret'] = df.vol_logret
    for c in ['n_tx', 'n_buy', 'n_sell', 'u_buyers', 'u_sellers', 'u_wallets', 'n_tx_1m', 'n_tx_5m',
              'n_buy_5m', 'n_sell_5m', 'n_buy_2s', 'n_buy_10s', 'dev_buys', 'dev_sells', 'holders',
              'n_snipers30', 'cr_prior_launches', 'cr_resolved', 'cr_launches_24h', 'sym_prior', 'sym_prior_24h', 'name_prior']:
        f[c] = np.log1p(df[c].fillna(0).clip(lower=0))
    f['buy_sol'] = np.log1p(df.buy_sol.fillna(0)); f['sell_sol'] = np.log1p(df.sell_sol.fillna(0))
    f['vol_5m'] = np.log1p(df.vol_5m.fillna(0)); f['buy_sol_2s'] = np.log1p(df.buy_sol_2s.fillna(0))
    f['net_flow_sol'] = df.buy_sol.fillna(0) - df.sell_sol.fillna(0)
    f['sell_ratio'] = df.n_sell.fillna(0) / df.n_tx.replace(0, np.nan)
    f['sell_ratio_5m'] = df.n_sell_5m.fillna(0) / df.n_tx_5m.replace(0, np.nan)
    f['sell_vol_ratio'] = df.sell_sol.fillna(0) / (df.buy_sol.fillna(0) + df.sell_sol.fillna(0)).replace(0, np.nan)
    f['since_last_tx'] = np.log1p(df.since_last_tx.clip(lower=0))
    f['first_tx_s'] = np.log1p(df.first_tx_s.clip(lower=0))
    f['sys_frac'] = df.sys_frac
    tot_dev = (df.initial_buy_sol.notna() * 0 + df.dev_buy_tok.fillna(0))
    f['dev_sold_any'] = (df.dev_sells.fillna(0) > 0).astype(float)
    f['dev_first_sell_s'] = np.log1p(df.dev_first_sell_s)
    f['dev_share_now'] = df.dev_share_now
    f['dev_buy_pct'] = df.dev_buy_pct
    f['initial_buy_sol'] = df.initial_buy_sol
    for c in ['top1', 'top5', 'top10', 'top2_11', 'held_total', 'hhi', 'sniper5_share']:
        f[c] = df[c]
    f['snp_mean_logprior'] = df.snp_mean_logprior; f['snp_max_prior'] = np.log1p(df.snp_max_prior)
    f['snp_frac_serial'] = df.snp_frac_serial
    f['cr_dead_rate'] = df.cr_dead_rate; f['cr_mean_logmult'] = df.cr_mean_logmult
    f['cr_gap_s'] = np.log1p(df.cr_gap_s)
    f['cr_first_launch'] = (df.cr_prior_launches.fillna(0) == 0).astype(float)
    f['mayhem'] = df.mayhem.astype(float); f['cashback'] = df.cashback.astype(float)
    hr = pd.to_datetime(df.launch + 120 + df.delay, unit='s', utc=True).dt.hour
    f['hour_sin'] = np.sin(2 * np.pi * hr / 24); f['hour_cos'] = np.cos(2 * np.pi * hr / 24)
    f['init_holder_count'] = df.initial_holder_count; f['init_top1'] = df.init_top1; f['init_top10'] = df.init_top10
    f['src_creator_past'] = np.log1p(df.src_creator_past); f['src_creator_rugs_rate'] = df.src_creator_rugs / df.src_creator_past.replace(0, np.nan)
    return f


# ---- feature sets ----------------------------------------------------------------------
TAPE_ONLY = ['ret_since_launch', 'ret_from_t0', 'p_max_ratio', 'drawdown', 'max_drawdown', 'vol_logret', 'n_tx', 'n_buy',
             'n_sell', 'u_buyers', 'u_sellers', 'u_wallets', 'n_tx_1m', 'n_tx_5m', 'n_buy_5m', 'n_sell_5m', 'n_buy_2s',
             'n_buy_10s', 'buy_sol', 'sell_sol', 'vol_5m', 'buy_sol_2s', 'net_flow_sol', 'sell_ratio', 'sell_ratio_5m',
             'sell_vol_ratio', 'since_last_tx', 'first_tx_s', 'sys_frac', 'dev_buys', 'dev_sells', 'dev_sold_any',
             'dev_first_sell_s', 'dev_share_now', 'dev_buy_pct', 'initial_buy_sol', 'top1', 'top5', 'top10', 'top2_11',
             'held_total', 'hhi', 'holders', 'sniper5_share', 'n_snipers30', 'snp_mean_logprior', 'snp_max_prior',
             'snp_frac_serial', 'mayhem', 'cashback', 'hour_sin', 'hour_cos']
HISTORY = ['cr_prior_launches', 'cr_resolved', 'cr_launches_24h', 'cr_dead_rate', 'cr_mean_logmult', 'cr_gap_s',
           'cr_first_launch', 'sym_prior', 'sym_prior_24h', 'name_prior']
# what FlagKan has today (approx.): gecko pool stats + RPC top holders
FLAGKAN_NOW = ['ret_since_launch', 'n_tx_5m', 'n_buy_5m', 'n_sell_5m', 'sell_ratio_5m', 'vol_5m', 'top1', 'top10',
               'top2_11', 'age_min', 'n_tx']
# live-feasible A: gecko pool attrs (price change, txns/buyers/sellers m5+h1, volume) + RPC (top holders,
# curve account flags, creator token balance, last signature time) -- no new providers
LIVE_A = ['ret_since_launch', 'n_tx', 'n_buy', 'n_sell', 'u_buyers', 'u_sellers', 'n_tx_5m', 'n_buy_5m', 'n_sell_5m',
          'sell_ratio', 'sell_ratio_5m', 'vol_5m', 'buy_sol', 'sell_sol', 'sell_vol_ratio', 'top1', 'top5', 'top10',
          'top2_11', 'dev_share_now', 'dev_buy_pct', 'initial_buy_sol', 'since_last_tx', 'n_tx_1m', 'mayhem',
          'cashback', 'hour_sin', 'hour_cos', 'p_max_ratio', 'drawdown']
# live-feasible B: + creator history and copycat counts (needs a creator->launches index: pump.fun / own crawler)
LIVE_B = LIVE_A + ['cr_prior_launches', 'cr_launches_24h', 'cr_dead_rate', 'cr_mean_logmult', 'cr_gap_s',
                   'cr_first_launch', 'sym_prior', 'sym_prior_24h', 'name_prior']
FULL = TAPE_ONLY + HISTORY
SETS = {'flagkan_now': FLAGKAN_NOW, 'live_a': LIVE_A, 'live_b': LIVE_B, 'full': FULL}

DAY = 86400


def ece(y, p, bins=10):
    idx = np.minimum((p * bins).astype(int), bins - 1); e = 0.0
    for b in range(bins):
        m = idx == b
        if m.any(): e += m.mean() * abs(y[m].mean() - p[m].mean())
    return e


def prec_at_cov(y, p, covs, positive=1):
    order = np.argsort(-p if positive == 1 else p)
    ys = (y[order] == positive)
    return {f'{c:g}': float(ys[:max(1, int(len(y) * c))].mean()) for c in covs}


def metrics(y, p, thr=0.5):
    y = y.astype(int)
    return {
        'n': int(len(y)), 'base_dead': float(y.mean()),
        'auc': float(roc_auc_score(y, p)),
        'pr_auc_dead': float(average_precision_score(y, p)),
        'pr_auc_alive': float(average_precision_score(1 - y, 1 - p)),
        'acc_at_0.5': float(((p >= 0.5) == y).mean()),
        'acc_at_thr': float(((p >= thr) == y).mean()), 'thr': float(thr),
        'acc_all_dead': float(y.mean()), 'acc_all_alive': float(1 - y.mean()),
        'brier': float(np.mean((p - y) ** 2)), 'brier_base': float(y.mean() * (1 - y.mean())), 'ece': float(ece(y, p)),
        'red_precision_at_cov': prec_at_cov(y, p, [0.05, 0.1, 0.2, 0.5, 0.8], 1),
        'alive_precision_at_top': prec_at_cov(y, p, [0.01, 0.05, 0.1], 0),
    }


class LRModel:
    def fit(self, X, y):
        self.med = X.median(); Xf = X.fillna(self.med)
        self.mu = Xf.mean(); self.sd = Xf.std().replace(0, 1)
        self.m = LogisticRegression(C=1.0, max_iter=2000).fit(((Xf - self.mu) / self.sd).values, y)
        return self

    def predict(self, X):
        return self.m.predict_proba(((X.fillna(self.med) - self.mu) / self.sd).values)[:, 1]


GBM_PARAMS = dict(objective='binary', learning_rate=0.05, num_leaves=63, min_data_in_leaf=200, feature_fraction=0.8,
                  bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, verbose=-1, num_threads=4)


class GBMModel:
    def fit(self, X, y, Xv=None, yv=None):
        dt = lgb.Dataset(X, y)
        if Xv is not None:
            dv = lgb.Dataset(Xv, yv, reference=dt)
            self.b = lgb.train(GBM_PARAMS, dt, 1500, valid_sets=[dv], callbacks=[lgb.early_stopping(50, verbose=False)])
        else:
            self.b = lgb.train(GBM_PARAMS, dt, 400)
        return self

    def predict(self, X):
        return self.b.predict(X, num_iteration=self.b.best_iteration or None)


def best_acc_thr(y, p):
    ts = np.linspace(0.3, 0.95, 66)
    return float(ts[np.argmax([((p >= t) == y).mean() for t in ts])])


def main():
    t = time.time()
    df = pd.read_parquet(os.path.join(DER, 'features.parquet'))
    df = df[(df.n_by_t0 > 0) & df[LABEL].notna()].reset_index(drop=True)
    y_all = df[LABEL].astype(int).values
    X_all = engineer(df)
    day0 = pd.Timestamp('2026-06-05', tz='UTC').timestamp()
    df['day'] = ((df.launch - day0) // DAY).astype(int)
    print('rows', len(df), 'load', round(time.time() - t, 1), flush=True)
    # walk-forward blocks (day index: 0 = Jun 5). Jun 18 missing in the corpus.
    blocks = [('Jun15-17', 10, 13), ('Jun19-21', 14, 17), ('Jun22-24', 17, 20)]
    res = {'label': LABEL, 'blocks': [b[0] for b in blocks], 'by': {}}
    preds_store = []
    for delay in [0, 300, 900, 1800]:
        md = (df.delay == delay).values
        for sname, cols in SETS.items():
            for mname in ['lr', 'gbm']:
                ys, ps, thrs, per_day, imps = [], [], [], [], []
                for bname, d_lo, d_hi in blocks:
                    test_start = day0 + d_lo * DAY
                    tr = md & (df.launch.values < test_start - 7200)
                    te = md & (df.day.values >= d_lo) & (df.day.values < d_hi)
                    # inner validation = last 24h of train (for early stopping + threshold)
                    tmax = df.launch.values[tr].max()
                    va = tr & (df.launch.values >= tmax - DAY)
                    tr2 = tr & ~va
                    Xtr, Xva, Xte = X_all.loc[tr2, cols], X_all.loc[va, cols], X_all.loc[te, cols]
                    if mname == 'lr':
                        m = LRModel().fit(Xtr, y_all[tr2])
                    else:
                        m = GBMModel().fit(Xtr, y_all[tr2], Xva, y_all[va])
                        imps.append(pd.Series(m.b.feature_importance('gain'), index=cols))
                    thr = best_acc_thr(y_all[va], m.predict(Xva))
                    p = m.predict(Xte)
                    ys.append(y_all[te]); ps.append(p); thrs.append(thr)
                    for dd in sorted(set(df.day.values[te])):
                        mm = df.day.values[te] == dd
                        if mm.sum() > 500 and 0 < y_all[te][mm].mean() < 1:
                            per_day.append({'day': int(dd), 'n': int(mm.sum()), 'auc': float(roc_auc_score(y_all[te][mm], p[mm])),
                                            'base_dead': float(y_all[te][mm].mean())})
                    if sname in ('live_b', 'full') and mname == 'gbm':
                        preds_store.append(pd.DataFrame({'mint': df.mint.values[te], 'delay': delay, 'set': sname,
                                                         'p': p, 'y': y_all[te]}))
                y = np.concatenate(ys); p = np.concatenate(ps)
                r = metrics(y, p, float(np.mean(thrs)))
                r['per_day'] = per_day
                r['auc_by_block'] = [float(roc_auc_score(a, b)) for a, b in zip(ys, ps)]
                if imps:
                    gi = sum(imps) / len(imps)
                    r['gain_top'] = {k: float(v) for k, v in (gi / gi.sum()).sort_values(ascending=False).head(15).items()}
                key = f'{sname}|{mname}|d{delay // 60}'
                res['by'][key] = r
                print(f"{key:28s} auc={r['auc']:.3f} prA={r['pr_auc_alive']:.3f} acc={r['acc_at_thr']:.4f} "
                      f"(all-dead {r['acc_all_dead']:.4f}) red@50%={r['red_precision_at_cov']['0.5']:.4f} "
                      f"alive@1%={r['alive_precision_at_top']['0.01']:.3f} alive@5%={r['alive_precision_at_top']['0.05']:.3f} "
                      f"ece={r['ece']:.4f} blocks={[round(a, 3) for a in r['auc_by_block']]}  {time.time() - t:.0f}s", flush=True)
    with open(os.path.join(OUT, f'results_jocry_{LABEL}.json'), 'w') as fh:
        json.dump(res, fh, indent=1)
    pd.concat(preds_store).to_parquet(os.path.join(DER, f'preds_{LABEL}.parquet'))


if __name__ == '__main__':
    main()
