"""Pooled live-feasible model (one model for any coin age 2-32 min) + export.

  .venv/Scripts/python -I src/final.py
Writes out/model-live.json, out/model-live-creator.json, out/feature-spec.json, out/results_live.json
"""
import json, os, sys, time
import numpy as np, pandas as pd, lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train import engineer, metrics, best_acc_thr, LRModel

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DER = os.path.join(ROOT, 'data', 'derived'); OUT = os.path.join(ROOT, 'out')
DAY = 86400

# Every feature below is computable live from GeckoTerminal pool + OHLCV and Solana RPC (see feature-spec.json)
LIVE_CORE = ['age_min', 'ret_since_launch', 'p_max_ratio', 'drawdown', 'n_tx', 'n_buy', 'n_sell', 'u_buyers', 'u_sellers',
             'n_tx_5m', 'n_buy_5m', 'n_sell_5m', 'sell_ratio', 'sell_ratio_5m', 'vol_5m', 'vol_total', 'top1', 'top5',
             'top10', 'top2_11', 'dev_share_now', 'dev_buy_pct', 'initial_buy_sol', 'since_last_tx', 'n_tx_1m',
             'hour_sin', 'hour_cos']
LIVE_CREATOR = LIVE_CORE + ['cr_prior_launches', 'cr_launches_24h', 'cr_gap_s', 'cr_first_launch', 'cr_dead_rate']
PARAMS = dict(objective='binary', learning_rate=0.05, num_leaves=31, min_data_in_leaf=300, feature_fraction=0.8,
              bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, verbose=-1, num_threads=4)


def feats(df):
    f = engineer(df)
    f['vol_total'] = np.log1p(df.buy_sol.fillna(0) + df.sell_sol.fillna(0))
    return f


def compact(booster, cols):
    """LightGBM dump -> compact arrays per tree: split feature, threshold, default_left, left, right; leaves negative."""
    d = booster.dump_model(num_iteration=booster.best_iteration or None)
    trees = []
    for t in d['tree_info']:
        F, T, DL, L, R, V = [], [], [], [], [], []

        def walk(n):
            if 'leaf_value' in n:
                V.append(round(n['leaf_value'], 6)); return -len(V)  # leaf k -> -(k+1)
            i = len(F); F.append(n['split_feature']); T.append(float(n['threshold']))
            mt = {'NaN': 0, 'None': 1, 'Zero': 2}[n.get('missing_type') or 'None']
            DL.append((1 if n['default_left'] else 0) + 2 * mt); L.append(None); R.append(None)
            assert n['decision_type'] == '<=' and n.get('missing_type') in ('NaN', 'None', 'Zero', None)
            L[i] = walk(n['left_child']); R[i] = walk(n['right_child']); return i
        root = walk(t['tree_structure'])
        trees.append({'f': F, 't': T, 'dl': DL, 'l': L, 'r': R, 'v': V, 'root': root})
    return {'kind': 'lightgbm-compact-v1', 'features': cols, 'n_trees': len(trees), 'trees': trees,
            'link': 'sigmoid(sum of leaf values)', 'missing': 'dl = default_left + 2*missing_type; missing_type 0=NaN (NaN goes default), 1=None (NaN treated as 0.0, then compared), 2=Zero (NaN or |x|<=1e-35 goes default)',
            'note': 'node index >= 0, leaf k encoded as -(k+1) into v[]'}


def predict_compact(m, X):
    X = np.asarray(X, dtype=float); out = np.zeros(len(X))
    for tr in m['trees']:
        for r in range(len(X)):
            n = tr['root']
            while n >= 0:
                x = X[r, tr['f'][n]]; dl = tr['dl'][n] & 1; mt = tr['dl'][n] >> 1
                if mt == 1 and np.isnan(x): x = 0.0
                if (mt == 0 and np.isnan(x)) or (mt == 2 and (np.isnan(x) or abs(x) <= 1e-35)): go_left = dl == 1
                else: go_left = x <= tr['t'][n]
                n = tr['l'][n] if go_left else tr['r'][n]
            out[r] += tr['v'][-n - 1]
    return 1 / (1 + np.exp(-out))


def main():
    t = time.time()
    df = pd.read_parquet(os.path.join(DER, 'features.parquet'))
    df = df[(df.n_by_t0 > 0) & df.dead_v2.notna()].reset_index(drop=True)
    y = df.dead_v2.astype(int).values; X = feats(df)
    day0 = pd.Timestamp('2026-06-05', tz='UTC').timestamp(); df['day'] = ((df.launch - day0) // DAY).astype(int)
    blocks = [('Jun15-17', 10, 13), ('Jun19-21', 14, 17), ('Jun22-24', 17, 20)]
    res = {}
    for sname, cols in ([] if os.environ.get('EXPORT_ONLY') else [('live_core', LIVE_CORE), ('live_creator', LIVE_CREATOR)]):
        for mname in ['gbm', 'lr']:
            P = np.full(len(df), np.nan); thrs = []
            for bname, lo, hi in blocks:
                ts = day0 + lo * DAY
                tr = df.launch.values < ts - 7200; te = (df.day.values >= lo) & (df.day.values < hi)
                va = tr & (df.launch.values >= df.launch.values[tr].max() - DAY); tr2 = tr & ~va
                if mname == 'gbm':
                    b = lgb.train(PARAMS, lgb.Dataset(X.loc[tr2, cols], y[tr2]), 2000,
                                  valid_sets=[lgb.Dataset(X.loc[va, cols], y[va])], callbacks=[lgb.early_stopping(50, verbose=False)])
                    pv, pt = b.predict(X.loc[va, cols], num_iteration=b.best_iteration), b.predict(X.loc[te, cols], num_iteration=b.best_iteration)
                else:
                    m = LRModel().fit(X.loc[tr2, cols], y[tr2]); pv, pt = m.predict(X.loc[va, cols]), m.predict(X.loc[te, cols])
                thrs.append(best_acc_thr(y[va], pv)); P[te] = pt
            for d in [0, 300, 900, 1800]:
                mm = (~np.isnan(P)) & (df.delay.values == d)
                r = metrics(y[mm], P[mm], float(np.mean(thrs)))
                r['auc_by_block'] = [float(roc_auc_score(y[mm & (df.day.values >= lo) & (df.day.values < hi)],
                                                         P[mm & (df.day.values >= lo) & (df.day.values < hi)])) for _, lo, hi in blocks]
                res[f'{sname}|{mname}|d{d // 60}'] = r
                print(f"{sname}|{mname}|d{d // 60}: auc={r['auc']:.3f} prAlive={r['pr_auc_alive']:.3f} red@20%={r['red_precision_at_cov']['0.2']:.4f} "
                      f"red@50%={r['red_precision_at_cov']['0.5']:.4f} alive@1%={r['alive_precision_at_top']['0.01']:.3f} "
                      f"alive@5%={r['alive_precision_at_top']['0.05']:.3f} ece={r['ece']:.4f} blocks={[round(a, 3) for a in r['auc_by_block']]}", flush=True)
    if res: json.dump(res, open(os.path.join(OUT, 'results_live.json'), 'w'), indent=1)

    # ---- final fit on everything (Jun 5 - Jun 23), early stop on Jun 24, export -------------
    for sname, cols, fn in [('live_core', LIVE_CORE, 'model-live.json'), ('live_creator', LIVE_CREATOR, 'model-live-creator.json')]:
        va = df.day.values == 19; tr = df.launch.values < day0 + 19 * DAY - 7200
        b = lgb.train(PARAMS, lgb.Dataset(X.loc[tr, cols], y[tr]), 2000, valid_sets=[lgb.Dataset(X.loc[va, cols], y[va])],
                      callbacks=[lgb.early_stopping(50, verbose=False)])
        b2 = lgb.train(PARAMS, lgb.Dataset(X.loc[tr | va, cols], y[tr | va]), b.best_iteration)  # refit incl. last day
        m = compact(b2, cols)
        # parity vectors so the JS port can self-test
        idx = np.random.RandomState(0).choice(np.where(va)[0], 25, replace=False)
        Xs = X.loc[idx, cols].values; pl = b2.predict(Xs); pc = predict_compact(m, Xs)
        assert np.max(np.abs(pl - pc)) < 1e-4, np.max(np.abs(pl - pc))
        m['parity'] = [{'x': [None if np.isnan(v) else float(v) for v in row], 'p': float(p)} for row, p in zip(Xs, pl)]
        gi = pd.Series(b2.feature_importance('gain'), index=cols); gi = gi / gi.sum()
        m['gain'] = {k: round(float(v), 4) for k, v in gi.sort_values(ascending=False).items()}
        m['label'] = 'dead_v2 at launch+2h: no trade in [1h,2h] after launch OR price <= 0.1 x price at first sight (launch+2min)'
        m['train'] = {'data': 'jocry/Pumpfun_Memecoin_Corpus trades, launches 2026-06-05..06-24 (non-mayhem)', 'rows': int((tr | va).sum()),
                      'base_dead': float(y[tr | va].mean()), 'rounds': int(b.best_iteration)}
        m['thresholds'] = {'red_p_ge': None, 'green_p_le': None}
        json.dump(m, open(os.path.join(OUT, fn), 'w'), separators=(',', ':'))
        print(fn, 'trees', m['n_trees'], 'bytes', os.path.getsize(os.path.join(OUT, fn)), flush=True)
    print('done', round(time.time() - t), 's')


if __name__ == '__main__':
    main()
