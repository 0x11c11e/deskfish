#!/usr/bin/env bash
# Record the bot's screen (the tank) from the host, straight off its X display — no VS Code
# chrome, no host desktop, pointer included. Rootless Podman with --network host shares the
# abstract X socket, so the tank's display (:99 by default) is reachable from the host.
#
#   scripts/record-tank.sh out.mp4            record until you press q (or Ctrl+C)
#   scripts/record-tank.sh out.mp4 --gif      also write out.gif (12 fps, 960 px wide) for READMEs
#   DISPLAY_NUM=98 SIZE=1440x900 FPS=30 scripts/record-tank.sh out.mp4
#
# Post-processing ideas (ffmpeg):
#   2x speed:      ffmpeg -i out.mp4 -vf "setpts=PTS/2" -an fast.mp4
#   trim 0:05-0:45: ffmpeg -ss 5 -to 45 -i out.mp4 -c copy cut.mp4
set -euo pipefail
OUT="${1:?usage: record-tank.sh OUT.mp4 [--gif]}"
GIF="${2:-}"
: "${DISPLAY_NUM:=99}"
: "${SIZE:=1280x800}"
: "${FPS:=30}"
command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed (sudo apt install ffmpeg)" >&2; exit 1; }
echo "Recording display :$DISPLAY_NUM at $SIZE, $FPS fps → $OUT   (press q to stop)"
ffmpeg -hide_banner -loglevel warning -stats \
  -f x11grab -framerate "$FPS" -video_size "$SIZE" -draw_mouse 1 -i ":$DISPLAY_NUM" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart -y "$OUT"
echo "saved $OUT"
if [ "$GIF" = "--gif" ]; then
  G="${OUT%.*}.gif"
  ffmpeg -hide_banner -loglevel warning -i "$OUT" \
    -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
    -y "$G"
  echo "saved $G ($(du -h "$G" | cut -f1))"
fi
