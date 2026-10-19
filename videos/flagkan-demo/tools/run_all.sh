#!/usr/bin/env bash
# Full rebuild of both demo cuts from the live site.
#   bash run_all.sh [capture|nocapture] [render|norender]
set -euo pipefail
cd "$(dirname "$0")"
CAP=${1:-capture}; REN=${2:-render}
node fetch_live.mjs
python tts.py
if [ "$CAP" = capture ]; then
  node pick_fresh.mjs
  node shots.mjs landing,coin,check,grade,proof both
  LIVE_TRIES=${LIVE_TRIES:-3} node shots.mjs board both
fi
node build.mjs
python mix.py
node build.mjs
(cd .. && npx hyperframes check | tail -3)
(cd ../../flagkan-demo-th && npx hyperframes check | tail -3)
if [ "$REN" = render ]; then
  for P in ../../flagkan-demo ../../flagkan-demo-th; do
    (cd "$P" && npx hyperframes render -q delivery -o renders/raw.mp4 --quiet > /dev/null 2>&1)
    ffmpeg -y -v error -i "$P/renders/raw.mp4" -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=11 -ar 48000 -c:a aac -b:a 192k -movflags +faststart "$P/renders/video.mp4"
  done
fi
