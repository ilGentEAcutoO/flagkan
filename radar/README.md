# FlagKan — new-coin risk radar (red / yellow / green)

Live: https://flag.sornkan.com/ · API: https://radar-worker-api.sornkan.workers.dev/

FlagKan watches newly boosted Solana tokens and gives each one a risk light:

- **RED — do not buy** · **YELLOW — caution** · **GREEN — looks OK**
- Every verdict shows its reasons as a checklist (whale share, holder spread,
  early buys, liquidity, coin age, AI wallet-coordination score) with the
  measured value and the limit next to it, in Thai and English.
- Outcomes resolve on-chain (~6h after first sight) so accuracy is proven,
  not claimed: `/api/proof`.

## How it works

```
DexScreener boosts ──► top Solana mints ──► cron every minute
Solami RPC ──► on-chain signals (top holders, early buys, coin age)
TypeSafe Jev ──► risk verdict: choice + probabilities + coordination + severity
Cloudflare D1 ──► rounds / snapshots / signals / verdicts / outcomes
```

- Market data: DexScreener (`/tokens/v1/solana`, `/token-boosts/top/v1`)
- On-chain data: Solami RPC (`getTokenSupply`, `getTokenLargestAccounts`,
  `getSignaturesForAddress`) — the only data path for holder signals
- Judge: Jev (`jev-latest`) with explicit numeric criteria per light
- Board lifecycle: unresolved coins count down to their outcome; resolved
  coins stay 7 days then drop off (history kept for proof stats)

## Run it yourself

```bash
cd radar
npm install
wrangler d1 create radar-d1-main   # put the id in wrangler.jsonc
wrangler d1 execute radar-d1-main --file=schema.sql
wrangler secret put TYPESAFE_API_KEY   # from https://console.typesafe.ai/keys
wrangler secret put SOLAMI_API_KEY     # from https://solami.dev/ dashboard
npm run dev        # local: worker + UI at http://localhost:8787
npm run deploy     # needs a Cloudflare account (cron + D1 + assets)
```

No secrets live in this repo — keys go through `wrangler secret` only.
See `/../.env.example` for the full variable list.

## API

| Endpoint | What |
|---|---|
| `GET /api/rounds?limit=50` | board: verdict + last price/liq/top1 + outcome |
| `GET /api/coin?mint=` | everything for one coin (signals, verdict, outcome, history) |
| `GET /api/verdict?mint=` | stored Jev verdict |
| `GET /api/proof` | resolved count, accuracy, red precision |
| `POST /api/verdict-now?mint=` | judge any mint on demand |
| `POST /api/signals-now?mint=` | recompute on-chain signals + verdict |
| `GET /api/health` `GET /api/diag` | status |

## Project layout

```text
radar/
  src/index.ts      worker: cron ingest, signals, Jev verdicts, outcomes, API
  schema.sql        D1 tables
  public/index.html UI (single file, no build step, TH/EN)
  wrangler.jsonc   cron * * * * *, D1 binding, assets, custom domain
../research/        hackathon rules + eligible tracks (competition homework)
../tracks/ ../data/ full track briefs + raw listings
```

Built for Colosseum Crypto World's Fair 2026 (AI x Solana Thailand + Solami tracks).
