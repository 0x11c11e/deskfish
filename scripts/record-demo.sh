#!/usr/bin/env bash
# Record a Deskfish demo: the tank's own screen AND your whole screen (VS Code with the chat and
# the Desktop tab), both at once. Stop with Ctrl+C in this terminal (once is enough).
#
# Recording goes to Matroska (.mkv) first — playable even if something dies mid-way — and is
# remuxed to .mp4 on a clean stop. If you only find the .mkv afterwards, it is complete anyway.
#
#   scripts/record-demo.sh ~/Videos/demo          → demo-tank.mp4 + demo-screen.mp4 (and the .mkv originals)
#   DELAY=8 scripts/record-demo.sh ~/Videos/demo    seconds of countdown before recording starts (default 5)
#   DISPLAY_NUM=99 TANK_SIZE=1280x800 FPS=30 SCREEN=:0 scripts/record-demo.sh ~/Videos/demo
#
# Afterwards (examples):
#   trim:      ffmpeg -ss 0:04 -to 1:10 -i demo-screen.mp4 -c copy demo-screen-cut.mp4
#   2x speed:  ffmpeg -i demo-tank.mp4 -vf "setpts=PTS/2" -an demo-tank-fast.mp4
#   GIF:       ffmpeg -i demo-tank-fast.mp4 -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" demo.gif
set -euo pipefail
BASE="${1:?usage: record-demo.sh OUTPUT-BASENAME   (e.g. ~/Videos/demo)}"
: "${DELAY:=5}"
: "${DISPLAY_NUM:=99}"
: "${TANK_SIZE:=1280x800}"
: "${FPS:=30}"
: "${SCREEN:=:0}"
command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed (sudo apt install ffmpeg)" >&2; exit 1; }
mkdir -p "$(dirname "$BASE")"
SCREEN_SIZE=$(DISPLAY="$SCREEN" xrandr --current 2>/dev/null | grep -oP 'current \K\d+ x \d+' | tr -d ' ' || true)
: "${SCREEN_SIZE:=1920x1080}"

for i in $(seq "$DELAY" -1 1); do printf '\rRecording starts in %2d s — switch to VS Code now… ' "$i"; sleep 1; done
printf '\rRecording. Press Ctrl+C here (once) when the task is done.          \n'

# Each ffmpeg runs in its own session (setsid) so the terminal's Ctrl+C does NOT reach it; only
# this script's single SIGINT does, and ffmpeg then finalizes the file. -nostdin: never read the tty.
setsid ffmpeg -nostdin -hide_banner -loglevel error -f x11grab -framerate "$FPS" -video_size "$TANK_SIZE" -draw_mouse 1 -i ":$DISPLAY_NUM" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -y "$BASE-tank.mkv" &
P1=$!
setsid ffmpeg -nostdin -hide_banner -loglevel error -f x11grab -framerate "$FPS" -video_size "$SCREEN_SIZE" -draw_mouse 1 -i "$SCREEN" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -y "$BASE-screen.mkv" &
P2=$!

finish() {
  trap - INT TERM
  kill -INT "$P1" "$P2" 2>/dev/null || true
  wait "$P1" 2>/dev/null || true
  wait "$P2" 2>/dev/null || true
  echo
  for part in tank screen; do
    if ffmpeg -v error -y -i "$BASE-$part.mkv" -c copy -movflags +faststart "$BASE-$part.mp4"; then
      echo "saved $BASE-$part.mp4"
    else
      echo "kept $BASE-$part.mkv (mp4 remux failed; the .mkv plays as is)"
    fi
  done
  exit 0
}
trap finish INT TERM
wait "$P1" "$P2" || true
finish
