"""Merge all metric files into out/results.json (+ a compact summary table printed to stdout)."""
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out')


def load(n):
    p = os.path.join(OUT, n)
    return json.load(open(p)) if os.path.exists(p) else None


wf = load('results_jocry_dead_v2.json'); live = load('results_live.json')
res = {
    'generated': '2026-10-12',
    'datasets': {
        'jocry': 'jocry/Pumpfun_Memecoin_Corpus (card: MIT in YAML, CC BY 4.0 in body). Trade tape usable Jun 5-24 2026 only; '
                 'tape truncated at ~2h after launch (most days) and ~20 min after launch from Jun 25 -> 2h-horizon label.',
        'loophole': 'loopholetape/pumpfun-launches (CC BY 4.0), Aug 31-Oct 4 2026, no trade tape; rugged/graduated labels.'},
    'label_main': 'dead_v2@2h: no trade in [launch+1h, launch+2h] OR price(launch+2h) <= 0.1 x price(launch+2min); graduated coins via post-graduation DEX snapshots',
    'population': 'jocry coins with >=1 trade by first sight (launch+2min), launched Jun 5-24, non-suspect: 308,041 coins',
    'protocol': 'walk-forward, 3 test blocks (Jun15-17, Jun19-21, Jun22-24), train = all coins launched before block start - 2h; '
                'early stopping + accuracy threshold on the last train day; no shuffling',
    'walk_forward_by_set': wf['by'] if wf else None,
    'live_pooled': live,
    'loophole': load('results_loophole.json'),
    'true_6h_checks': {
        'model_2h_vs_true6h_auc': {'delay0': 0.562, 'delay30': 0.629, 'with_grads_delay0': 0.598},
        'direct_6h_training': load('results_direct6h.json'),
        'verdict': 'REJECTED as label: 6h survivors are coins idle in hour 1-2 that trade again near 5.9h; hour-of-day is a top '
                   'feature -> collector re-scan artifact. Base dead at 6h on curve coins = 99.4%.'},
}
json.dump(res, open(os.path.join(OUT, 'results.json'), 'w'), indent=1)
if wf:
    print('| set | model | delay | AUC | PR-AUC alive | acc (thr) | all-dead | RED prec @20% | @50% | alive prec top1% | top5% | ECE |')
    for k, r in wf['by'].items():
        s, m, d = k.split('|')
        print(f"| {s} | {m} | {d} | {r['auc']:.3f} | {r['pr_auc_alive']:.3f} | {r['acc_at_thr']:.4f} | {r['acc_all_dead']:.4f} | "
              f"{r['red_precision_at_cov']['0.2']:.4f} | {r['red_precision_at_cov']['0.5']:.4f} | {r['alive_precision_at_top']['0.01']:.3f} | "
              f"{r['alive_precision_at_top']['0.05']:.3f} | {r['ece']:.4f} |")
print('bytes', os.path.getsize(os.path.join(OUT, 'results.json')))
