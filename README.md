# FlagKan — a red / yellow / green light for new Solana tokens

**Live:** https://flag.sornkan.com · **Proof (live numbers):** https://flag.sornkan.com/proof · **API:** https://flag.sornkan.com/api/proof

Thousands of Solana tokens launch every day and most of them are dead within hours.
FlagKan looks at every new token as soon as it appears, gives it a **RED (don't buy) /
YELLOW (caution) / GREEN (lower risk — not safe)** light with the signals behind it, and then **grades its
own verdict ~6 hours later** against what actually happened. Every graded coin is public,
and every headline number is shown next to the "do-nothing" baseline it has to beat.

**The honest headline.** Most new coins (about 97%; live: [`/api/proof`](https://flag.sornkan.com/api/proof))
are dead within 6 hours, so "call everything red" is already about that accurate — accuracy is not
our skill metric. Our skill is **ranking**: the coins FlagKan scores safest survive more often than
a random pick. On 11,375 new coins the cron found itself (since 5 Oct 2026; pair ≤ 6 h old at first
sight, on-demand checks excluded) the safest 10% survived 8.8% (95% CI 7.2–10.5%) vs 5.6% for a
random pick — about 1.6×, AUC 0.609, as of 13 Oct. Live values: `ranking` and `population` on
[`/api/proof`](https://flag.sornkan.com/api/proof).

> FlagKan flags risk patterns. It is not financial advice.

## How it works

```
GeckoTerminal new pools (most coins) ────┐
DexScreener boosts ──────────────────────┴─► new Solana mints (discovery every 5 min; cron every minute)
                                              │
Solami RPC ──► on-chain signals: whale share, top-holder spread, early buys,
               coin age, mint/freeze authority
                                              │
Leak-free LightGBM model (LR fallback) + explicit rules ──► the light
TypeSafe Jev (jev-latest) ──► AI judge: wallet-coordination + risk-factor scores
Crash re-checks ──► a coin that measurably crashes before grading is re-armed red
                                              │
~6h later: graded from the same market feed (label v2) ──► Cloudflare D1
                                              │
Public /proof page + /api/proof: every number next to its baseline
```

- **Spot.** A Cloudflare Worker cron pulls GeckoTerminal's new-pool feed and DexScreener boosts.
- **Inspect.** Solami RPC (`getTokenSupply`, `getTokenLargestAccounts`, `getSignaturesForAddress`,
  `getAccountInfo`) gives holder concentration, early buy pressure, coin age and authority flags.
  Market fields (liquidity, FDV, volume, trades) come from GeckoTerminal / DexScreener.
- **Judge.** A model trained on FlagKan's own graded history combines with explicit rules.
  LightGBM (27 leak-free first-sight features) decides the light since 2026-10-12, after an out-of-sample test on 357 resolved coins neither model had seen ranked better than the logistic regression (AUC 0.776 vs 0.736 — suggestive, not statistically significant: the confidence intervals overlap heavily with only 21 surviving coins). The LR stays as the automatic fallback and as the live comparison; live head-to-head numbers are in [`/api/proof`](https://flag.sornkan.com/api/proof). The LR (feature list in
  [`radar/src/ml/train.ts`](radar/src/ml/train.ts)) is still retrained on the edge, and a challenger
  is only promoted on a measured test-split improvement. The Jev judge from
  TypeSafe is a structured sensor: it scores wallet coordination and whale / sell-pressure /
  structure risk; it writes no reason text. The six checks shown in the UI
  are reference levels that explain the verdict — the light itself comes from model + rules.
- **Grade.** About 6 hours after first sight the outcome is settled from market data and the verdict
  is scored. Resolved coins stay on the board for 7 days; history is kept for the proof stats.

## What counts as "dead" (label v2)

A coin is **dead** if, within 6 hours of first sight, **any** of these happens:

1. the price fell **90% or more**, or
2. liquidity dropped **under $1,000** — measured from the same data source as first sight, or
3. **nobody traded it in the final hour**.

Otherwise it is **alive**. The exact parameters are published in `label_def` on
[`/api/proof`](https://flag.sornkan.com/api/proof).

## Honesty notes

- **Baselines are always shown.** Most new coins die, so "call everything red" or "call everything
  yellow" already scores well. Every accuracy / precision number on /proof sits next to the
  baseline it has to beat, plus the base dead rate itself.
- **The old label had a flaw (fixed 2026-10-12).** Coins that simply stopped trading were often
  counted as *alive*, because the 6h sample came from a different data source than first sight.
  That made the old accuracy look better than a trivial strategy deserved. Label v2 grades from the
  same feed and treats "no trades in the final hour" as dead.
- **A training leak was fixed** at the same time: a stored value that was overwritten after a crash
  could reach the model's training data. The model is now trained only on first-sight state.
- **Legacy numbers are kept.** The old (v1) figures stay in `legacy_v1` on /api/proof, and a regrade
  of the history under v2 is published in `v2_history_regrade`, so nothing silently disappears.
- **No cherry-picking.** The proof table lists every resolved coin, not a highlight reel.
- **Outcomes are graded from market data, not on-chain.** The 6h outcome is read from the same
  GeckoTerminal / DexScreener feed the coin was first seen on. On-chain data (Solami RPC) feeds
  the light, not the grade.
- **Ranking is measured tie-aware.** Before 12 Oct most stored first-sight scores were coarse
  stamps from rules / Jev, so the safest 10% is one tied group; ties are split pro rata, never by
  row order, and backfilled coins are excluded. (An earlier internal figure of 3.35× used row order
  and backfilled rows and is withdrawn.) The model-era ranking and the LightGBM-vs-LR head-to-head
  show only once there are 200+ graded coins and 10+ survivors.
- **Small samples are labelled.** Green has been called on very few coins under policy v2, so no
  green hit rate is claimed. "Red · high confidence" needs 0.996 from LightGBM, a bar that is rarely
  reached (one coin so far since LightGBM took over); the bar was left unchanged. Live count and
  highest score: `headline.tiers` and `ranking.gbm_max_p` on [`/api/proof`](https://flag.sornkan.com/api/proof).
- **Legacy numbers are not current claims.** The old ~80% accuracy (label v1) and the legacy
  calibration (ECE ~0.20, mostly fixed 0.95–0.98 stamps from rules / Jev) are kept for transparency only.

Live metrics are not hardcoded here on purpose — read them from
[`/api/proof`](https://flag.sornkan.com/api/proof) or the [proof page](https://flag.sornkan.com/proof).

## API

All read endpoints are public `GET`s on `https://flag.sornkan.com`.

| Endpoint | What |
|---|---|
| `GET /api/proof` | scoreboard: `headline` (label v2 metrics + baselines + tiers), `ranking` (tie-aware top-1/2/10% survival vs random, Wilson 95% CI, deciles, AUC — all-era score, policy-v2 only, LR, LightGBM), `decider`, `challenger`, `label_def`, `v2_history_regrade`, `legacy_v1`, plus legacy calibration detail |
| `GET /api/rounds?limit=&offset=` | board page, newest first, with `total`; `resolved=1` → newest graded coins |
| `GET /api/coin?mint=` | everything for one coin: signals, verdict, outcome, price history |
| `GET /api/verdict?mint=` | the stored verdict for a mint |
| `POST /api/verdict-now?mint=` | judge any mint on demand (rate-limited by a daily budget) |
| `GET /health` · `GET /api/diag` · `GET /api/cost` | status, diagnostics, cost watch |

Maintenance endpoints (retrain, signal refresh, backfill) require an admin key and are not part of
the public surface.

## Run it yourself

Requires Node 20+ and a Cloudflare account.

```bash
cd radar
npm install
npx wrangler d1 create radar-d1-main            # put the id in wrangler.jsonc
npx wrangler d1 execute radar-d1-main --file=schema.sql
npx wrangler secret put TYPESAFE_API_KEY        # https://console.typesafe.ai/keys
npx wrangler secret put SOLAMI_API_KEY          # https://solami.dev/
npx wrangler secret put ADMIN_KEY               # any long random string
npm run dev       # worker + UI on http://localhost:8787
npm run deploy    # cron + D1 + static assets
```

No secrets live in this repo; keys go through `wrangler secret put` only.
Offline checks: `npm run mltest` (model unit checks), `npm run smoke` (endpoint guards).

## Repo layout

```text
radar/                 the product (Cloudflare Worker + static UI)
  src/index.ts         cron ingest, Solami signals, model + rules, Jev judge, grading, API
  src/ml/              logistic-regression training + verdict upgrade logic (pure TS)
  public/              UI: index (landing), board, proof, about — vanilla JS, TH/EN, no build
  schema.sql, migrate-v*.sql   D1 schema and migrations
  *.mjs                offline tools: backtest, calibration, challenger gate, sweeps
videos/                pitch + demo video sources
research/              hackathon homework (rules, eligible tracks) — Thai
tracks/  data/         full track briefs + raw listings
```

## Built for

**Colosseum Crypto World's Fair 2026** — AI × Solana (Thailand) and Solami (build something
live on Solana data) tracks. Built solo by SORNKan in Thailand.

---

## สรุปภาษาไทย

**FlagKan** ติดไฟ **แดง / เหลือง / เขียว** ให้เหรียญ Solana ที่เพิ่งเกิด ทันทีที่เจอ พร้อมสัญญาณที่อยู่เบื้องหลังเป็นข้อ ๆ
แล้ว **ตรวจคำชี้ของตัวเองอีกครั้งราว 6 ชั่วโมงต่อมา** จากสิ่งที่เกิดขึ้นจริง ผลทุกเหรียญเปิดเผยที่
[หน้า Proof](https://flag.sornkan.com/proof)

- **ข้อมูล:** เหรียญใหม่จาก GeckoTerminal (ส่วนใหญ่) + DexScreener boosts → สัญญาณบนเชนผ่าน Solami RPC
- **การชี้:** โมเดล LightGBM (มี logistic regression เป็นตัวสำรอง) + กฎเด็ดขาด 2 ข้อ + AI Jev (TypeSafe) ให้คะแนน wallet coordination และปัจจัยเสี่ยง
  และ re-check เมื่อราคาร่วงจริง ผลตัดสินอ่านจากแหล่งข้อมูลตลาดเดียวกับตอนเจอ ไม่ได้ตัดสินบนเชน
- **ตัวเลขที่ซื่อตรง:** เหรียญใหม่ส่วนใหญ่ (ราว 97% ดูค่าสดที่ /api/proof) ตายเองใน 6 ชม. ความแม่นจึงไม่ใช่ฝีมือ ฝีมือคือการจัดอันดับ:
  10% ที่คะแนนปลอดภัยสุดรอด 8.8% เทียบสุ่ม 5.6% (~1.6×, 11,375 เหรียญใหม่ที่ระบบเจอเอง ตั้งแต่ 5 ต.ค. ไม่นับเหรียญที่สั่งเช็คเอง ณ 13 ต.ค.) ไฟเขียวยังมีน้อยเกินจะอ้างอัตราถูก
- **นิยาม "ตาย" (label v2):** ภายใน 6 ชม. ราคาลง 90% ขึ้นไป หรือ liquidity ต่ำกว่า $1,000
  (วัดจากแหล่งเดียวกับตอนเห็นครั้งแรก) หรือไม่มีใครเทรดเลยในชั่วโมงสุดท้าย
- **ความซื่อตรง:** ทุกตัวเลขแสดงคู่กับ baseline แบบ "ไม่ทำอะไรเลย" เสมอ นิยามเดิมมีจุดบกพร่อง
  (เหรียญที่แค่หยุดเทรดถูกนับว่ารอด) แก้แล้วเมื่อ 12 ต.ค. 2026 ตัวเลขเก่ายังเก็บไว้ใน `legacy_v1`
- สร้างเพื่อ Colosseum Crypto World's Fair 2026 (track AI × Solana Thailand + Solami)
- งานรีเสิร์ชแฮกกาธอนเดิมย้ายไปที่ [research/README.md](research/README.md)
