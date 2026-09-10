#!/bin/bash
# Starts the virtual screen, window manager, VNC bridge and the control daemon.
# Environment:
#   SCREEN        Xvfb geometry, default 1280x800x24
#   DISPLAY_NUM   X display number, default 99 (not 0: with --network host the abstract socket of
#                 display :0 would collide with the host's real X server)
#   VNC_PORT / WS_PORT  internal x11vnc / websockify ports (5900 / 6080); only matter with --network host
#   VNC_PASSWORD  if set, VNC requires this password (noVNC prompts for it / extension setting)
#   DAEMON_TOKEN  if set, the control API requires "Authorization: Bearer <token>" and the
#                 websocket needs "?token=<token>"
set -euo pipefail
: "${SCREEN:=1280x800x24}"
: "${DISPLAY_NUM:=99}"
: "${VNC_PORT:=5900}"
: "${WS_PORT:=6080}"
export WS_PORT
export DISPLAY=":${DISPLAY_NUM}"

# File exchange with the user: attachments arrive in Uploads, anything for the user goes to
# Downloads (Firefox is locked to it by policy; the extension watches it).
mkdir -p "$HOME/Downloads" "$HOME/Uploads"

# Tell the Firefox page bridge extension where the daemon is (managed storage via policies.json,
# which the image leaves owned by this user). Firefox reads the policy file when it starts.
POLICIES=/usr/lib/firefox-esr/distribution/policies.json
if [ -w "$POLICIES" ]; then
  DAEMON_PORT="${DAEMON_PORT:-9990}" DAEMON_TOKEN="${DAEMON_TOKEN:-}" node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.policies["3rdparty"] = { Extensions: { "deskfish-bridge@deskfish.sh": { port: Number(process.env.DAEMON_PORT) || 9990, token: process.env.DAEMON_TOKEN || "" } } };
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  ' "$POLICIES" || echo "warning: could not write the page bridge settings into $POLICIES" >&2
fi

rm -f "/tmp/.X${DISPLAY_NUM}-lock"
Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp -ac +extension RANDR >/tmp/xvfb.log 2>&1 &

# wait for the X server
for _ in $(seq 1 100); do
  if xdotool getdisplaygeometry >/dev/null 2>&1; then break; fi
  sleep 0.1
done

# a session bus keeps Firefox quiet; not required for anything else
if command -v dbus-launch >/dev/null; then
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS
fi

openbox-session >/tmp/openbox.log 2>&1 &

if [ -n "${VNC_PASSWORD:-}" ]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vncpass >/dev/null 2>&1
  VNC_AUTH=(-rfbauth /tmp/vncpass)
else
  VNC_AUTH=(-nopw)
fi
# -localhost: only websockify (same container) can reach the raw VNC port
x11vnc -display "$DISPLAY" -localhost -forever -shared -rfbport "$VNC_PORT" -noxdamage -quiet "${VNC_AUTH[@]}" >/tmp/x11vnc.log 2>&1 &
websockify "127.0.0.1:$WS_PORT" "127.0.0.1:$VNC_PORT" >/tmp/websockify.log 2>&1 &

# Graceful shutdown: on SIGTERM (podman/docker stop) close Firefox cleanly first so it saves its
# session, cookies and logins, then stop the daemon. Without this, `rm -f` kills Firefox mid-write
# and the next start shows a "restore session?" page.
node /opt/daemon/daemon.mjs &
DAEMON_PID=$!
shutdown() {
  pkill -TERM -x firefox-esr 2>/dev/null || true
  for _ in $(seq 1 50); do pgrep -x firefox-esr >/dev/null 2>&1 || break; sleep 0.1; done
  kill -TERM "$DAEMON_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT
wait "$DAEMON_PID"
