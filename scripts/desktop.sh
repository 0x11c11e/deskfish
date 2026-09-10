#!/usr/bin/env bash
# Start / stop the bot's desktop container with plain `podman run` or `docker run` — no compose
# provider needed. Used by the extension's "Deskfish: Start/Stop Desktop Container" commands.
#
#   scripts/desktop.sh up [--build]   build the image if missing (or --build), then start it
#   scripts/desktop.sh down           stop and remove the container (the home volume is kept)
#   scripts/desktop.sh status | logs | shell | screenshot
#
# Environment (all optional):
#   DESKFISH_CONTAINER_CLI   auto | docker | podman            (auto: docker if present, else podman)
#   DESKFISH_DESKTOP_TOKEN   bearer token for the daemon + VNC websocket
#   DESKFISH_VNC_PASSWORD    VNC password
#   DESKFISH_SCREEN          Xvfb geometry, default 1280x800x24
#   DESKFISH_PORT            host port for the daemon, default 9990
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
IMAGE="localhost/deskfish-desktop:latest"
NAME="deskfish-desktop"
VOLUME="deskfish-home"
PORT="${DESKFISH_PORT:-9990}"

pick_cli() {
  case "${DESKFISH_CONTAINER_CLI:-auto}" in
    docker|podman) echo "$DESKFISH_CONTAINER_CLI" ;;
    *)
      if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker
      elif command -v podman >/dev/null 2>&1; then echo podman
      else echo "neither docker nor podman found on PATH" >&2; exit 1
      fi ;;
  esac
}
CLI="$(pick_cli)"

# Rootless Podman needs pasta or slirp4netns to publish ports. Without them, fall back to the host
# network namespace with everything bound to 127.0.0.1 (display :99 avoids clashing with the host's X).
network_args() {
  if [ "$CLI" = podman ] && ! command -v pasta >/dev/null 2>&1 && ! command -v slirp4netns >/dev/null 2>&1; then
    echo "note: neither pasta nor slirp4netns is installed — using --network host bound to 127.0.0.1" >&2
    echo "      (install the 'passt' package for normal port publishing)" >&2
    echo "--network host -e DAEMON_BIND=127.0.0.1 -e DAEMON_PORT=$PORT"
  else
    echo "-p 127.0.0.1:$PORT:9990"
  fi
}

cmd="${1:-status}"
shift || true
case "$cmd" in
  up)
    if [ "${1:-}" = "--build" ] || ! "$CLI" image exists "$IMAGE" 2>/dev/null && ! "$CLI" image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "building $IMAGE …"
      "$CLI" build -t "$IMAGE" "$ROOT/docker/desktop"
    fi
    "$CLI" rm -f "$NAME" >/dev/null 2>&1 || true
    # shellcheck disable=SC2046
    "$CLI" run -d --name "$NAME" --hostname computer --shm-size 1g \
      $(network_args) \
      -e "SCREEN=${DESKFISH_SCREEN:-1280x800x24}" \
      -e "DAEMON_TOKEN=${DESKFISH_DESKTOP_TOKEN:-}" \
      -e "VNC_PASSWORD=${DESKFISH_VNC_PASSWORD:-}" \
      -v "$VOLUME:/home/bot" \
      "$IMAGE" >/dev/null
    echo -n "waiting for the daemon"
    for _ in $(seq 1 60); do
      if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then echo; break; fi
      echo -n "."; sleep 1
    done
    curl -s "http://127.0.0.1:$PORT/" || { echo "daemon did not come up; logs:"; "$CLI" logs "$NAME" | tail -20; exit 1; }
    echo
    echo "desktop up: API http://127.0.0.1:$PORT  screen http://127.0.0.1:$PORT/screenshot.png  VNC ws://127.0.0.1:$PORT/websockify"
    ;;
  down)
    "$CLI" stop -t 15 "$NAME" >/dev/null 2>&1; "$CLI" rm -f "$NAME" >/dev/null 2>&1 && echo "stopped $NAME (volume $VOLUME kept)" || echo "$NAME was not running"
    ;;
  status)
    "$CLI" ps -a --filter "name=$NAME" --format '{{.Names}}  {{.Status}}  {{.Image}}'
    curl -s "http://127.0.0.1:$PORT/" 2>/dev/null && echo || echo "daemon not reachable on 127.0.0.1:$PORT"
    ;;
  logs)
    "$CLI" logs -f "$NAME"
    ;;
  shell)
    "$CLI" exec -it "$NAME" bash
    ;;
  screenshot)
    out="${1:-screenshot.png}"
    curl -s -o "$out" "http://127.0.0.1:$PORT/screenshot.png" && echo "saved $out"
    ;;
  *)
    echo "usage: $0 up [--build] | down | status | logs | shell | screenshot [file]" >&2
    exit 2
    ;;
esac
