"""Train directly on the 6h curve label (only days whose tape reaches 6h), test on later long-tape days."""
import os, sys, numpy as np, pandas as pd, lightgbm as lgb
from sklearn.metrics import roc_auc_score, average_precision_score
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train import engineer, FULL, LIVE_A, GBM_PARAMS
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
df = pd.read_parquet(os.path.join(ROOT, 'data', 'derived', 'features.parquet'))
df = df[(df.n_by_t0 > 0) & df.dead_6h_curve.notna()].reset_index(drop=True)
day = pd.to_datetime(df.launch, unit='s', utc=True).dt.strftime('%m-%d')
X = engineer(df); y = df.dead_6h_curve.astype(int).values
tr_days = ['06-12', '06-13', '06-14', '06-15', '06-16', '06-17', '06-19', '06-20']
te_days = ['06-22', '06-23']
out = {}
for d in [0, 900, 1800]:
    m = (df.delay == d).values
    tr = m & day.isin(tr_days).values; te = m & day.isin(te_days).values
    b = lgb.train({**GBM_PARAMS, 'num_leaves': 15, 'min_data_in_leaf': 500}, lgb.Dataset(X.loc[tr, FULL], y[tr]), 200)
    p = b.predict(X.loc[te, FULL])
    o = np.argsort(p); ya = 1 - y[te][o]
    r = dict(n_tr=int(tr.sum()), alive_tr=int((1 - y[tr]).sum()), n_te=int(te.sum()), alive_te=int((1 - y[te]).sum()),
             auc=round(roc_auc_score(y[te], p), 3), pr_alive=round(average_precision_score(1 - y[te], 1 - p), 4),
             alive_top1=round(ya[:len(ya) // 100].mean(), 4))
    out[d] = r; print(d, r, flush=True)
import json; json.dump(out, open(os.path.join(ROOT, 'out', 'results_direct6h.json'), 'w'), indent=1)
gi = pd.Series(b.feature_importance('gain'), index=FULL); print((gi / gi.sum()).sort_values(ascending=False).head(10).round(3).to_dict())
al = te & (y == 0)
print(df.loc[al, ['n_tx', 'u_wallets', 'since_last_tx', 'sys_frac', 'n_last_hour', 'n_last_hour_6h', 's_max', 'grad']].describe().round(2).T[['mean', '50%']])
print(df.loc[te & (y == 1), ['n_tx', 'u_wallets', 'since_last_tx', 'sys_frac', 'n_last_hour', 's_max']].describe().round(2).T[['mean', '50%']])
