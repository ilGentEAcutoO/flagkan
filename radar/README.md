# FlagKan worker — new-coin risk radar (red / yellow / green)

Live: https://flag.sornkan.com/ · Proof: https://flag.sornkan.com/proof · API: https://flag.sornkan.com/api/proof

This folder is the whole product: one Cloudflare Worker (cron + API) and a static UI.
See the [root README](../README.md) for the product overview and honesty notes.

FlagKan watches **new Solana tokens** (about 98% arrive through GeckoTerminal's new-pool feed,
the rest through DexScreener boosts) and gives each one a risk light:

- **RED — do not buy** · **YELLOW — caution** · **GREEN — looks OK**
- Every verdict shows a checklist (whale share, holder spread, early buys, liquidity, coin age,
  AI wallet-coordination score) with the measured value next to a **reference level**, in Thai
  and English. The reference levels explain the verdict; the light itself comes from the model,
  the rules and crash re-checks.
- About 6 hours after first sight the outcome is **graded from market data** (GeckoTerminal /
  DexScreener, same source as first sight) and the verdict is scored publicly on `/api/proof`,
  next to the do-nothing baselines.

## What counts as dead (label v2, since 2026-10-12)

Within 6 hours of first sight: price fell 90%+, **or** liquidity dropped under $1,000 (same data
source as first sight), **or** nobody traded it in the final hour. Parameters are published in
`label_def` on `/api/proof`. The previous label (v1) missed coins that simply stopped trading;
its numbers are kept in `legacy_v1`.

## How it works

```
GeckoTerminal new pools + DexScreener boosts ──► new Solana mints ──► cron (every minute)
Solami RPC ──► on-chain signals (top holders, early buys, coin age, authorities)
model (LightGBM, LR fallback) + rules ──► light; crash re-checks can re-arm red before grading
TypeSafe Jev ──► wallet coordination + written reasons
Cloudflare D1 ──► rounds / snapshots / signals / verdicts / outcomes
```

- Market data: GeckoTerminal new pools + pool batches, DexScreener (`/tokens/v1/solana`,
  `/token-boosts/top/v1`) — liquidity, FDV, volume, trades, pair age
- On-chain data: Solami RPC (`getTokenSupply`, `getTokenLargestAccounts`,
  `getSignaturesForAddress`, `getAccountInfo`) — holder spread, early buys, coin age, plus
  mint/freeze authority flags
- Model: LightGBM (27 leak-free first-sight features) decides the light since 2026-10-12, after an out-of-sample test on 357 resolved coins neither model had seen ranked better than the logistic regression (AUC 0.776 vs 0.736 — suggestive, not statistically significant: the confidence intervals overlap heavily with only 21 surviving coins). The LR stays as the automatic fallback and as the live comparison; live head-to-head numbers are in [`/api/proof`](https://flag.sornkan.com/api/proof). Rollback is one line: `DECIDER` in
  [`src/ml/train.ts`](src/ml/train.ts). The LR (feature list in the same file) is still retrained
  on a schedule and a challenger is only promoted on a measured test-split improvement; a new LR
  champion cannot take over the light while `DECIDER = "gbm"`
- Judge: Jev (`jev-latest`) — coordination score, severity and the human-readable reasons
- Board lifecycle: unresolved coins count down to their outcome; resolved coins stay 7 days
  then drop off (history kept for proof stats)

## Run it yourself

```bash
cd radar
npm install
npx wrangler d1 create radar-d1-main   # put the id in wrangler.jsonc
npx wrangler d1 execute radar-d1-main --file=schema.sql
npx wrangler secret put TYPESAFE_API_KEY   # from https://console.typesafe.ai/keys
npx wrangler secret put SOLAMI_API_KEY     # from https://solami.dev/ dashboard
npx wrangler secret put ADMIN_KEY          # guards maintenance endpoints
npm run dev        # local: worker + UI at http://localhost:8787
npm run deploy     # needs a Cloudflare account (cron + D1 + assets)
```

No secrets live in this repo — keys go through `wrangler secret put` only.
See [`../.env.example`](../.env.example) for the variable list.

Offline tools: `npm run mltest` (model checks), `npm run smoke` (endpoint guards),
`npm run backtest`, `npm run calibrate`, `npm run gate` (challenger vs champion).

## API

| Endpoint | What |
|---|---|
| `GET /api/rounds?limit=&offset=` | board page (newest first) + `total`; `resolved=1` → newest graded coins (proof table). Rows may carry `tier` and `policy_v` |
| `GET /api/coin?mint=` | everything for one coin (signals, verdict, outcome, history) |
| `GET /api/verdict?mint=` | stored verdict |
| `GET /api/proof` | `label` + `label_def`, `headline` (accuracy, red precision, base dead rate, baselines, survivor lift, tiers), `v2_history_regrade`, `legacy_v1`; old top-level fields are kept as the legacy v1 view |
| `POST /api/verdict-now?mint=` | judge any mint on demand (daily budget) |
| `POST /api/signals-now?mint=&key=` | recompute on-chain signals + verdict (admin) |
| `POST /api/backfill-now?key=` | judge resolved-but-unverdicted coins from stored first-seen state (training only, excluded from proof; admin) |
| `GET /health` `GET /api/diag` `GET /api/cost` | status, diagnostics, cost watch |

## Project layout

```text
radar/
  src/index.ts     worker: cron ingest, signals, model + rules, Jev verdicts, grading, API
  src/ml/          training (train.ts) + verdict upgrade logic (upgrade.ts)
  schema.sql       D1 tables (+ migrate-v*.sql)
  public/          UI: index (landing), board, proof, about (no build step, TH/EN)
  wrangler.jsonc   crons, D1 binding, assets, custom domain
  *.mjs            offline tools (backtest, calibrate, gate, sweeps, smoke)
../research/       hackathon rules + eligible tracks (competition homework)
```

Built for Colosseum Crypto World's Fair 2026 (AI × Solana Thailand + Solami tracks).
