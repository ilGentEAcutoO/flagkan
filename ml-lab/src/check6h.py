"""Sanity: does the 2h-horizon model rank the true 6h outcome (curve coins, days with long tracking)?"""
import os, duckdb, numpy as np, pandas as pd
from sklearn.metrics import roc_auc_score
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DER = os.path.join(ROOT, 'data', 'derived').replace(chr(92), '/')
c = duckdb.connect()
print(c.sql(f"SELECT mayhem, quantile_cont(p_t0_raw,0.01), COUNT(*) FROM '{DER}/features.parquet' WHERE delay=0 GROUP BY 1").fetchall())
d = c.sql(f"""SELECT p.*, f.dead_6h_curve, f.s_max, f.launch, f.dead_v2 FROM '{DER}/preds_dead_v2.parquet' p
  JOIN '{DER}/features.parquet' f ON f.mint=p.mint AND f.delay=p.delay WHERE p.set='full'""").df()
d['day'] = pd.to_datetime(d.launch, unit='s', utc=True).dt.strftime('%m-%d')
long = d[d.day.isin(['06-15', '06-16', '06-17', '06-23']) & d.dead_6h_curve.notna()]
for dl in [0, 1800]:
    x = long[long.delay == dl]
    y6 = x.dead_6h_curve.astype(int)
    print('delay', dl, 'n', len(x), 'base dead6h', round(y6.mean(), 4), 'AUC vs 6h', round(roc_auc_score(y6, x.p), 3),
          'P(alive6h|alive2h)', round(((1 - y6)[x.dead_v2 == 0]).mean(), 3), 'P(alive6h|dead2h)', round(((1 - y6)[x.dead_v2 == 1]).mean(), 4))

# full 6h label incl. graduated coins (post-graduation DEX snapshots, txns in last hour + price)
J = os.path.join(ROOT, 'data', 'jocry').replace(chr(92), '/')
g = c.sql(f"""SELECT f.mint,
  arg_min(coalesce(g.buys_1h,0)+coalesce(g.sells_1h,0), abs(epoch(g.snapshot_time)-(f.launch+21720))) tx1h,
  arg_min(g.price_native, abs(epoch(g.snapshot_time)-(f.launch+21720))) px,
  min(abs(epoch(g.snapshot_time)-(f.launch+21720))) gap
  FROM '{DER}/features.parquet' f JOIN '{J}/postgard_snapshots.parquet' g USING(mint)
  WHERE f.delay=0 AND f.grad IS NOT NULL AND f.grad <= f.launch+21720 GROUP BY 1""").df()
x = d[d.delay == 0].merge(g, on='mint', how='left').merge(
    c.sql(f"SELECT mint, p_t0_raw, grad FROM '{DER}/features.parquet' WHERE delay=0").df(), on='mint')
gr = x.grad.notna() & (x.grad <= x.launch + 21720)
x["dead6"] = pd.Series(np.where(gr & x.gap.lt(3600), ((x.tx1h == 0) | (x.px <= 0.1 * x.p_t0_raw)).astype(float), x.dead_6h_curve.astype(float)), index=x.index).astype(float)
x6 = x[x.day.isin(['06-15', '06-16', '06-17', '06-23']) & x.dead6.notna()]
print('full6h n', len(x6), 'grads', int(gr[x6.index].sum()), 'base dead6', round(x6.dead6.mean(), 4), 'AUC', round(roc_auc_score(x6.dead6.astype(int), x6.p), 3))
xa = x[x.dead6.notna()]
print('all test days n', len(xa), 'base', round(xa.dead6.mean(), 4), 'AUC', round(roc_auc_score(xa.dead6.astype(int), xa.p), 3), 'grads alive@6h', int(((xa.dead6 == 0) & gr[xa.index]).sum()))
