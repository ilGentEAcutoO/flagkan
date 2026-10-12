---
format: 1920x1080
duration: 145s
message: "Watch FlagKan judge a live coin in under a minute"
arc: Land → Board → Verdict → Check → Proof → Language → CTA
audience: Colosseum judges and crypto traders
mode: autonomous
music: none
---

## Frame 1 — Landing

- scene: Slow pan across the FlagKan landing hero into the live stats
- type: product_intro
- blueprint: spatial-pan-stations
- duration: 18s
- poster: 12s
- transition_in: cut
- status: animated
- voiceover: "This is FlagKan — a risk radar for new coins on Solana. In the next two minutes, I'll walk you through the live board, a full coin verdict, an on-demand check, and the public proof behind every call. No slides, no mockups — the real product. Let's go."
- src: compositions/frames/01-landing.html
- asset_candidates: assets/scroll-000.png — plate; assets/scroll-060.png — plate; assets/scroll-100.png — plate
- sfx: whoosh-cinematic
- ground: "#16130E"

One oversized canvas: the three landing plates stitched as pan stations. Single virtual camera: station 1 hero (0–6s) → lateral pan with parallax to station 2 live stats (6–12s) → settle on station 3 CTA band (12–18s). Each station reveals a callout naming the tour stop ahead. Signature move: one unbroken pan, landing held on the "let's go" beat. All visuals are the real captured landing — no rebuilds.

## Frame 2 — Board tour

- scene: The live board held hero while regions tour: lights, filters, sort, pagination
- type: feature_showcase
- blueprint: cursor-ui-demo
- duration: 27s
- poster: 18s
- transition_in: cut
- status: animated
- voiceover: "The board tracks every new coin, live, as it gets discovered. Each row is a coin with its light — red, yellow, or green — plus confidence, price, liquidity, and the whale's share. Filter by light, search by name or mint, and sort any column with one click. Fifty coins a page, thousands tracked around the clock. Everything updates live — no refresh needed."
- src: compositions/frames/02-board.html
- asset_candidates: assets/en-board.png — plate
- sfx: whoosh-short, click-soft, pop
- ground: "#16130E"

Locked static stage on the real EN board plate; a visible cursor drives attention (never fakes state). Beats: lights column pulse (0–6s) → filter chips highlight All/Red/Yellow/Green (6–12s, click-soft each) → search + sort headers (12–19s) → pagination footer settle (19–27s). Signature move: cursor-led region tour with the camera chasing each stop. Every label shown exists on the plate.

## Frame 3 — Coin detail

- scene: Cursorless flight through the CAT verdict: banner, probability bar, six checks
- type: feature_showcase
- blueprint: camera-journey
- duration: 26s
- poster: 16s
- transition_in: cut
- status: animated
- voiceover: "Click any row for the full verdict. CAT is yellow at eighty-six percent confidence. The Why panel shows all six checks: whale concentration failed at eighty percent, first-minute buys failed at nine hundred twenty-five against a limit of three hundred — and the AI agrees: caution. Below that, the raw rules, the severity score, and links to the explorer and the chart."
- src: compositions/frames/03-coin.html
- asset_candidates: assets/modal-cat.png — plate
- sfx: click-soft, ping, pop
- ground: "#16130E"

Cursorless flight (sub-shape B) over the real CAT modal plate. Leg 1 (0–6s): dive onto the YELLOW banner + R/Y/G probability bar. Leg 2 (6–18s): travel down the Why panel, each check row highlighting with the VO — ping on the failed whale row. Leg 3 (18–25s): landing push on the severity line + explorer links. Signature move: travel tells the cause→effect story. All numbers are the plate's own.

## Frame 4 — On-demand check

- scene: Paste a mint into Check and watch FlagKan judge it fresh
- type: feature_showcase
- blueprint: prompt-type-submit-generate
- duration: 25s
- poster: 18s
- transition_in: cut
- status: animated
- voiceover: "Now the on-demand check. Paste any mint address into the box up top — I'll use CAT again — hit Check, and FlagKan judges it fresh: the same six checks, the same verdict, plus a live price chart on the side. Any coin, any time, in seconds. Try it on the next coin someone shills you."
- src: compositions/frames/04-check.html
- asset_candidates: assets/check-result.png — plate; assets/en-board.png — plate
- sfx: typing, key-press, notification
- ground: "#16130E"

Full loop across two real plates. Beat 1 (0–8s): on the board plate, the mint types into the Check input (typing sfx), key-press on submit. Beat 2 (8–12s): judging shimmer. Beat 3 (12–25s): hard cut to the check-result plate as the verdict modal springs in (notification sfx), camera settles on banner + live price chart. Signature move: keyboard drives, machine answers. Typed mint is CAT's real address.

## Frame 5 — Proof

- scene: The graded record scrolls as evidence, landing on the public-record payoff
- type: social_proof
- blueprint: transcript-scroll-artifact-reveal
- duration: 25s
- poster: 18s
- transition_in: cut
- status: animated
- voiceover: "Every verdict on the board gets resolved. Six hours after we first see a coin, the chain delivers the outcome, and the proof page publishes all of it — every call, right or wrong, nothing hidden. Thousands of graded verdicts already sit on the public record, and the API is free for anyone to audit. That is the whole point."
- src: compositions/frames/05-proof.html
- asset_candidates: assets/proof-scroll-000.png — plate; assets/proof-scroll-100.png — plate
- sfx: whoosh, ping, chime
- ground: "#16130E"

Vertical traversal of the real proof plates as one continuous scroll (0–17s) — graded verdicts as evidence. Focal pivot (17–21s): one right call + one wrong call highlighted together. Payoff (21–25s): count-up to the captured resolved figure + "public record, free API" + chime. Signature move: traversal is the proof, the count-up is the payoff. Figures match the plates exactly.

## Frame 6 — TH/EN switch

- scene: The board pinned center while the language flips Thai to English
- type: benefit_highlight
- blueprint: fixed-anchor-cycle
- duration: 13s
- poster: 9s
- transition_in: wipe
- status: animated
- voiceover: "FlagKan speaks two languages. One tap on the toggle switches the whole board between Thai and English — same data, same verdicts, same lights."
- src: compositions/frames/06-lang.html
- asset_candidates: assets/th-board.png — plate; assets/en-board.png — plate
- sfx: whoosh-short, pop
- ground: "#16130E"

Anchor-cycle: the EN board plate pinned dead-center and never moving (0–4s hold). The TH plate wipes across it and back (4–9s, whoosh-short) — the surface re-skins while the anchor's stillness asserts "same data, same verdicts" (pop on the language toggle). Resolves on the EN board (9–13s). Signature move: the anchor's stillness IS the claim. Both plates are real captures.

## Frame 7 — End card

- scene: FlagKan lockup + URL end card held to the final frame
- type: cta
- blueprint: logo-assemble-lockup
- duration: 12s
- poster: 8s
- transition_in: crossfade
- status: animated
- voiceover: "That's FlagKan — check before you buy. The link is on screen. See you on the board."
- src: compositions/frames/07-outro.html
- sfx: impact-bass-1, chime
- ground: "#FFFDF7"

Cream ground per frame.md closing treatment. Red/yellow/green dots orbit and spring-assemble into the FlagKan wordmark (0–5s, impact-bass-1 on lock); "Check before you buy." + flag.sornkan.com fade up beneath (5–8s); full lockup holds static with concentric closing rings (8–12s). Signature move: the lights BECOME the brand and the CTA. URL legible ≥1.4cqw, final 4s fully still.
