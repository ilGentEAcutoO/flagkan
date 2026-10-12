---
format: 1920x1080
duration: 140s
message: "FlagKan grades every new-coin verdict on-chain — check before you buy"
arc: Hook → Problem → Solution → Proof → CTA
audience: Colosseum judges and crypto traders
mode: autonomous
music: none
---

## Frame 1 — Hook

- scene: Red light slams in over the hook line on near-black
- type: hook
- blueprint: kinetic-type-beats
- duration: 12s
- poster: 8s
- transition_in: cut
- status: animated
- voiceover: "Every minute, a new coin launches on Solana. And every minute, somebody buys one that goes straight to zero. What if you could see the risk — before you buy?"
- src: compositions/frames/01-hook.html
- sfx: riser, impact-bass-1
- ground: "#16130E"

Cold open on near-black. Beat 1 (0–4s): "Every minute, a new coin launches on Solana." types/scales in, white Sarabun 700. Beat 2 (4–8s): hard cut, "somebody buys one that goes to zero." — "zero" in negative red, glitch-1 tick. Beat 3 (8–12s): red traffic-light dot spring-pops center with impact-bass-1, line resolves to "What if you could see the risk — before you buy?" Signature move: in-place word-swap relay with spring-pop payoff on the red light. Red/yellow/green light motif starts here and recurs every frame.

## Frame 2 — Problem

- scene: Dead-coin count-up and crashing chart on dark
- type: pain_point
- blueprint: dataviz-countup
- duration: 18s
- poster: 12s
- transition_in: cut
- status: animated
- voiceover: "New coins are a minefield. The whale often holds eighty percent of supply. Liquidity vanishes overnight. By the time the chart tells you, your money is already gone. Nobody grades these coins — so nobody learns, and the same traps refill every day."
- src: compositions/frames/02-problem.html
- sfx: glitch-1, error
- ground: "#16130E"

Illustrative motion graphic (no plate): a red line chart draws itself then falls off a cliff (0–8s) while three pain phrases land one per beat — "The whale holds 80%." / "Liquidity vanishes overnight." / "Your money is already gone." (8–14s). Closes (14–18s) on the kicker "Nobody grades these coins — so nobody learns." with error-tone sting. Signature move: camera push through the crashing chart to land on the kicker. Numbers are illustrative of the mechanism, never presented as FlagKan stats.

## Frame 3 — The board

- scene: Slow push over the live FlagKan board, lights popping row by row
- type: product_intro
- blueprint: device-surface-showcase
- duration: 21.5s
- poster: 12s
- transition_in: cut
- status: animated
- voiceover: "FlagKan watches every new coin on Solana, around the clock, without pause. Each one gets a light: red means do not buy, yellow means caution, green means it passed every check. Whether it's the next runner or the next rug, the light is already there. One board. Every coin. No hype, just the verdict."
- src: compositions/frames/03-board.html
- asset_candidates: assets/board-scroll-000.png — plate
- sfx: whoosh-short, pop
- ground: "#16130E"

Full-bleed live board plate (board-scroll-000.png, 1x, no fake UI). Static-hold showcase with a slow continuous push-in (0–20s); red/yellow/green light pills pulse on three rows in sync with the VO naming each light (pop sfx each). Lower-third caption IDs the three light meanings as spoken. Signature move: the push-in never stops — content arrives with the voice, never dumped at t=0.

## Frame 4 — Coin detail

- scene: Cursorless flight through the CAT verdict modal: banner, bar, six checks
- type: feature_showcase
- blueprint: camera-journey
- duration: 27s
- poster: 16s
- transition_in: cut
- status: animated
- voiceover: "Tap any coin and FlagKan shows its work. Six checks run on every coin: whale concentration, holder spread, first-minute buys, pool liquidity, coin age, and linked wallets. Take CAT: one whale holds eighty percent, first-minute buys are far over the limit — so the AI says yellow, eighty-six percent confidence, while the raw rules shout red. You see exactly why — every reason, on screen."
- src: compositions/frames/04-coin.html
- asset_candidates: assets/modal-cat.png — plate
- sfx: click-soft, ping, pop
- ground: "#16130E"

Cursorless flight (sub-shape B) over the real CAT modal plate. Leg 1 (0–6s): dive onto the YELLOW banner + R/Y/G bar. Leg 2 (6–18s): travel down the Why panel as each of the six check rows highlights in turn with the VO (click-soft ticks, ping on the failed whale row). Leg 3 (18–25s): landing push on "80.05% · limit 30%" + conf 86%. Signature move: the camera's travel IS the cause→effect story. No invented figures — every number visible comes from the plate.

## Frame 5 — Proof

- scene: The proof panel scrolls as evidence, landing on the graded-record payoff
- type: social_proof
- blueprint: transcript-scroll-artifact-reveal
- duration: 30s
- poster: 22s
- transition_in: cut
- status: animated
- voiceover: "And here's the part no one else does. Every verdict gets graded. Six hours after we first see a coin, the chain itself gives the result, and FlagKan publishes it — wins and misses alike, nothing cherry-picked. More than thirty-five hundred calls already sit on the public record, with the accuracy to prove it. The scoreboard is open to everyone, and the API is free. Don't trust us. Check the proof."
- src: compositions/frames/05-proof.html
- asset_candidates: assets/proof-scroll-000.png — plate; assets/proof-scroll-100.png — plate
- sfx: whoosh, ping, chime
- ground: "#16130E"

Vertical traversal of the real proof plates (scroll-000 → scroll-100 cross-dissolved as one continuous scroll, 0–20s) — the graded verdicts ARE the evidence. Focal pivot (20–24s): highlight one right call and one wrong call side by side. Payoff (24–30s): count-up lands on the captured resolved figure (3526 at capture; render exactly what the plate shows) + "wins and misses alike" + chime. Signature move: traversal is the proof, the count-up is the payoff. Never speak or show a figure the plate doesn't support.

## Frame 6 — On-demand check

- scene: A mint address types into Check and the verdict fires back
- type: feature_showcase
- blueprint: prompt-type-submit-generate
- duration: 20s
- poster: 15s
- transition_in: cut
- status: animated
- voiceover: "Found a coin somewhere else? Paste its mint address and FlagKan judges it on demand — the same six checks, the same verdict, in seconds. No signup, no waiting for the next scan. Bring any coin you like, and get an answer before your money moves. Check before you buy. Every time."
- src: compositions/frames/06-check.html
- asset_candidates: assets/check-result.png — plate
- sfx: typing, key-press, notification
- ground: "#16130E"

Full loop on the real Check plate. Beat 1 (0–7s): mint address types into the Check input (typing sfx + key-press on submit). Beat 2 (7–11s): status theater — brief judging shimmer. Beat 3 (11–20s): the CAT verdict modal springs in with the live price chart (notification sfx on arrival), camera settles on the verdict banner + chart. Signature move: keyboard drives, machine answers. The typed mint is CAT's real address from the plate.

## Frame 7 — End card

- scene: FlagKan lockup assembles over closing rings + URL held to the final frame
- type: branding
- blueprint: logo-assemble-lockup
- duration: 15s
- poster: 10s
- transition_in: crossfade
- status: animated
- voiceover: "FlagKan. Every new coin on Solana, judged in the open — and every judgment, graded by the chain. Check before you buy."
- src: compositions/frames/07-outro.html
- sfx: impact-bass-1, chime
- ground: "#FFFDF7"

Cream ground per frame.md closing treatment. Red/yellow/green dots orbit and spring-assemble into the FlagKan wordmark (0–6s, impact-bass-1 on lock); tagline "Check before you buy." + flag.sornkan.com URL fade up beneath (6–10s); full lockup holds static to the final frame with concentric closing rings (10–15s). Signature move: the lights BECOME the brand. URL legible ≥1.4cqw, final 5s fully still for the end-screen hold.
