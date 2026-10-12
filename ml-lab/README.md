# FlagKan ML lab

Offline research on predicting which new pump.fun coins die. Everything runs locally (Windows, CPU).
Results live in `out/results.json`. The deployable model is `out/model-live.json`, its inputs are in
`out/feature-spec.json`, and `out/predict-live.mjs` is a zero-dependency evaluator for the Worker.

## Reproduce

```bash
cd ml-lab
python -m venv .venv
.venv/Scripts/python -m pip install duckdb polars pyarrow pandas pytz lightgbm scikit-learn huggingface_hub
# data (untrusted downloads, parquet only, no dataset code is executed): ~7 GB + 0.2 GB
.venv/Scripts/python -I -c "from huggingface_hub import snapshot_download as s; s('jocry/Pumpfun_Memecoin_Corpus', repo_type='dataset', local_dir='data/jocry', allow_patterns=['*.parquet','*.md'])"
.venv/Scripts/python -I -c "from huggingface_hub import snapshot_download as s; s('loopholetape/pumpfun-launches', repo_type='dataset', local_dir='data/loophole', allow_patterns=['data/**/*.parquet','*.md'])"
.venv/Scripts/python -I src/build.py          # labels + point-in-time features -> data/derived/features.parquet (~9 min)
.venv/Scripts/python -I src/train.py          # walk-forward LR vs LightGBM x delay x feature set (~17 min)
.venv/Scripts/python -I src/final.py          # pooled live model, export out/model-live*.json (~15 min)
.venv/Scripts/python -I src/loophole.py       # study 2: creator history at population scale (~1 min)
.venv/Scripts/python -I src/check6h.py        # true-6h sanity check
.venv/Scripts/python -I src/direct6h.py       # direct 6h training (shows the collector artifact)
.venv/Scripts/python -I src/report.py         # merge -> out/results.json
node out/predict-live.mjs out/model-live.json # JS parity self-test
```

`data/` and `.venv/` are git-ignored. `src/peek3.py` and `src/peek5.py` are the tape-coverage audits.

## Data: what each dataset can and cannot support

| | jocry/Pumpfun_Memecoin_Corpus | loopholetape/pumpfun-launches |
|---|---|---|
| period | Jun 5 to Jul 14 2026 (Jul 3 missing) | Aug 31 to Oct 4 2026 |
| size | 798k launches, 33.6M wallet-level trades, 6.7 GB | 1.23M launches, 43 cols, 170 MB |
| licence | card is inconsistent: MIT in the YAML, CC BY 4.0 in the body (both permissive) | CC BY 4.0 |
| trade tape | yes, but **truncated**: about 2h after launch on Jun 5 to 24, about **20 min** from Jun 25 (0 trades after 1h on any coin) | none; only f10 (<10 s) and f60 (<60 s) snapshots |
| supports | v2-style labels at a **2h** horizon (Jun 5 to 24), and every tape feature at T0 to T0+30m | rugged/graduated labels, creator history across the whole population, a launch (<=60 s) model |
| cannot | a true 6h label (see below); mayhem coins (none before the cutoff); funder clustering (no transfers) | 6h price path, FlagKan's v2 label, FlagKan's T0 (2 min) features |

More quirks: 14% of trades come from the System Program placeholder wallet, so wallet features exclude it.
3.4% of `sol_amount` values are corrupt, so they are recomputed as token x price. The token table's
`creator_past_rugs` field increments within minutes, so it looks like a leak and is not used; creator history
is recomputed point-in-time instead. In loopholetape, half of all launches already rugged or graduated by
60 s. Including them makes graduation look 100% predictable, so those launches are excluded.

## Labels (they mimic FlagKan)

* First sight T0 = launch + 2 min. On production D1, the median pool age at FlagKan's first sight is
  1.76 min (p10 0.8, p90 8.7, n = 13.3k).
* **dead_v2@2h** (main label): no trade in [launch+1h, launch+2h], OR the price at launch+2h is at most
  0.1 x the price at T0. Graduated coins are judged from post-graduation DEX snapshots (1h txns + price).
  The base rate is 94.9% dead, against roughly 90% for FlagKan's v2.
* The `<$1k liquidity` clause is dropped. GeckoTerminal "liquidity" for a curve pool is real token reserve x
  price + real SOL, which is about 22 SOL (~$2.5k) at launch and can only grow. So it never fires on a live
  curve. The 21% of FlagKan's first sights with liq < $1k are Gecko zeros, not real illiquidity.
* Sensitivity labels are stored too: `loss90`, `loss50`, `win2x`.
* **True 6h label: rejected.** On the few days where the tape reaches 6h, curve coins are 99.4% dead.
  Of the survivors, 72% were idle in hour 1 to 2 and trade again around 5.9h, and hour-of-day becomes a
  top feature (direct 6h training AUC 0.98 on 51 positives). That is a collector re-scan artifact, not
  survival. The 2h model ranks that 6h label at only AUC 0.56 to 0.63.

## Features (point-in-time, <= decision time td = T0 + {0, 5, 15, 30} min)

From the tape: trade, buy and sell counts (total, last 1 min, last 5 min); unique buyers and sellers;
buy and sell SOL; sell ratios; price return since launch and since T0; max price; drawdown; realized
volatility; time since the last trade; buys in the first 2 s and 10 s (bundles); dev buys and sells; dev
first-sell time; dev share now; top-1, top-5 and top-10 holder share, top 2 to 11 share, HHI and holder
count from net flows (curve excluded); share held by wallets whose first buy came within 5 s (snipers);
serial-sniper reuse (each sniper's prior snipes across coins); hour of day.

Cross-coin history: creator prior launches, launches in the last 24h, gap since the previous launch, and
the dead rate / mean log-return of prior launches **already resolved before td**. Copycat counts of prior
same-symbol and same-name launches.

## Results (walk-forward, test = Jun 15 to 24, 3 blocks)

AUC by feature set (dead = positive class). Test base rate = 95.45% dead.

| set | model | T0 | +5m | +15m | +30m |
|---|---|---|---|---|---|
| FlagKan-now feats (Gecko m5 + top holders) | LR | 0.631 | 0.705 | 0.694 | 0.695 |
| FlagKan-now feats | LightGBM | 0.809 | 0.843 | 0.856 | 0.868 |
| live_core, pooled single model | LR | 0.741 | 0.770 | 0.781 | 0.790 |
| **live_core, pooled single model** | **LightGBM** | **0.822** | **0.854** | **0.872** | **0.885** |
| live_creator (live_core + creator history) | LR | 0.764 | 0.788 | 0.797 | 0.806 |
| live_creator | LightGBM | 0.826 | 0.858 | 0.874 | 0.887 |
| full tape + history | LR | 0.798 | 0.824 | 0.836 | 0.847 |
| full tape + history | LightGBM | 0.833 | 0.861 | 0.877 | 0.891 |

live_core LightGBM, both sides:

| delay | PR-AUC alive | RED precision @20% / @50% / @80% coverage | survivor precision top 1% / 5% / 10% | acc vs all-dead | ECE |
|---|---|---|---|---|---|
| T0 | 0.224 | 0.996 / 0.992 / 0.980 | 0.419 / 0.255 / 0.199 | 0.9556 vs 0.9545 | 0.004 |
| +15m | 0.352 | 0.997 / 0.994 / 0.986 | 0.628 / 0.357 / 0.256 | 0.9571 vs 0.9545 | 0.005 |
| +30m | 0.405 | 0.997 / 0.995 / see json | 0.717 / 0.395 / see json | 0.9592 vs 0.9545 | 0.004 |

Brier at T0 is 0.039, against 0.043 for the base rate. PR-AUC on the dead class is 0.988.

Top features by gain. For live_core: price return since launch 27%, top-10 share 14%, top-5 share 11%,
top 2 to 11 share 9%, max-price ratio 5%, then dev buy %, hour, age, dev share now and initial buy SOL.
For full-tape at +30m, time since the last trade rises to 17%. The full set also uses `sys_frac` (the share
of placeholder-wallet trades), which is collector-specific, so it is not in any live set. Several trees
split at about 1e-10 on return/drawdown features, so the live code must compute drawdown as exactly 0 when
price equals max.

Per-block AUC (live_core, T0): 0.812 / 0.840 / 0.822. Drift is small. Note that "accuracy" barely beats the
all-dead baseline: with 95% of coins dying, accuracy is the wrong yardstick. The useful products are a
near-certain RED for half the feed (99.2% vs 95.5% base) and a **survivor list** at 9 to 16x the base rate.

Study 2 (loopholetape, Oct 2 to 4 test, coins still undecided at 60 s):

* rugged AUC: 0.883 from launch features, 0.909 with creator history and copycat added, 0.820 from history alone.
* graduated AUC: 0.938 to 0.943; top-1% precision 33 to 40% against a 1.25% base.
* So creator history is worth about +0.025 AUC on rugs at population scale. On jocry it adds only
  +0.002 to +0.007, because the history there starts cold on Jun 5.

## Honesty checks

* Leakage review: every tape feature filters `s <= td`. Creator, sniper and copycat history use only events
  timestamped before td, and creator fates count only once resolved (launch + 2h <= td).
  `entry_price_*`, `creator_past_*` and the `initial_*` holder fields are excluded.
* Walk-forward with a 2h embargo, and thresholds tuned on the last train day.
* Numbers that looked too good were investigated and removed: loophole graduation (100% top-1%, which was
  already graduated at 60 s) and jocry 6h (collector artifact).
* Distribution gaps for production: no mayhem coins in training (26% of Oct launches), the tape is
  pumpdev-websocket rather than Gecko counts, and the horizon is 2h, not 6h.

## Live port (recommended)

1. **Stage 1, provisional light at first sight (age ~2 min).** Run `model-live.json` on live_core features.
   Inputs: the Gecko pool call FlagKan already makes (price, txns m5/h1 incl. buyers/sellers, volume), one
   Gecko OHLCV call (max price), and Solana RPC: getTokenLargestAccounts, getSignaturesForAddress on the
   bonding curve, and getTokenAccountsByOwner for the creator. The creator and their create-tx buy are
   cached from one getTransaction. That is about 1 extra Gecko call and 3 to 4 RPC calls per coin.
   Expected AUC is about 0.82 if the live counts match the tape.
2. **Stage 2, confirmed light at age ~15 min.** Run the same model and features again (age_min is an
   input). Expected AUC is about 0.87. Upgrade or downgrade the light there.
3. **Policy.** RED when P(dead) is in the top 50% of the feed: about 99.2% precise against a 95.5% base.
   SURVIVOR/GREEN only for the top 1% lowest P(dead): about 42% precise at stage 1 and 63% at stage 2,
   against 4.5% base. Everything else is YELLOW. Pick thresholds as feed quantiles on FlagKan's own data.
4. **Out of distribution, use rules:** mayhem coins (in loopholetape they rug 89% and almost never
   graduate) and PumpSwap graduation pools.
5. **Creator history** (`model-live-creator.json`, +0.004 AUC here and +0.025 on rugs at population scale):
   ingest the CC-BY loopholetape daily files (7-day lag) weekly into a D1 `creators` table (prior
   launches, rug rate), plus FlagKan's own outcomes. The per-mint loopholetape card is paid (x402); its
   free `token_check` is capped at 30 calls/h.
6. **Before trusting it, shadow-score.** Log P(dead) next to the current policy for about 3 days, then
   compare AUC on FlagKan's own v2 labels. Gecko counts and horizon differences will cost some AUC. If it
   holds, refit the same feature set on FlagKan's labels (6h horizon) and keep this model as the prior.
