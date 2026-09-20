# Deskfish desktop: the smallest useful "computer" for a bot.
#
#   debian:bookworm-slim  (28 MB)        base
#   Xvfb + Openbox + x11vnc + websockify  virtual screen, window manager, remote view
#   tint2 + feh + librsvg                 bottom panel (launchers + open windows), wallpaper
#   firefox-esr + xterm                   the apps (+ curl, python3/pip/requests, git, gh, jq, poppler's pdftotext/pdftoppm,
#                                         zip/unzip, nano in the terminal; libavcodec so Firefox plays H.264/AAC video)
#   Node.js 22 + npm (nodejs.org)         runs the daemon; lets the bot run its own test suite before a pull request
#   xdotool + scrot                       hands + eyes
#   daemon.mjs (Node)                     the control API on :9990  (+ /websockify proxy for noVNC; run_command runs
#                                         shell commands for the agent without the screen)
#   bridge/ (WebExtension)                the page bridge: lets the agent read the Firefox page, find
#                                         elements by name, scroll one into view and set a native
#                                         dropdown (find / read_page / click_element / scroll_to /
#                                         select_option tools)
#
# No systemd, no desktop environment, no root inside, no privileged mode needed.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox x11vnc websockify xdotool scrot xclip xterm x11-xserver-utils \
      tint2 feh librsvg2-bin \
      firefox-esr libgl1-mesa-dri dbus-x11 fonts-dejavu-core fonts-liberation2 \
      ca-certificates procps \
      curl python3 python3-pip python3-requests jq git gh zip unzip nano less xinput \
      poppler-utils libavcodec59 \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 (LTS) from nodejs.org, checksum-verified against its SHASUMS256.txt. Debian's nodejs
# is 18 without npm; the daemon runs on this one, and so does `npm test` on the bot's own source.
RUN set -eu; arch=$(dpkg --print-architecture); case "$arch" in amd64) a=x64 ;; arm64) a=arm64 ;; *) echo "unsupported architecture $arch" >&2; exit 1 ;; esac; \
    base=https://nodejs.org/dist/latest-v22.x; \
    curl -fsSL "$base/SHASUMS256.txt" -o /tmp/SHASUMS256.txt; \
    f=$(grep -o "node-v22\.[0-9.]*-linux-$a\.tar\.gz" /tmp/SHASUMS256.txt | head -1); \
    curl -fsSL "$base/$f" -o "/tmp/$f"; \
    (cd /tmp && grep " $f\$" SHASUMS256.txt | sha256sum -c -); \
    tar -xzf "/tmp/$f" -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'; \
    rm -f "/tmp/$f" /tmp/SHASUMS256.txt; node --version; npm --version

RUN useradd -m -u 1000 -s /bin/bash bot

# Debian's firefox-esr ignores /etc/firefox-esr/policies; the install-dir location is the one that works
# (check about:policies — it must not say "inactive"). The file belongs to the bot user because the
# entrypoint writes the daemon's port and token into it (3rdparty → the page bridge's managed storage).
COPY policies.json /usr/lib/firefox-esr/distribution/policies.json
# The page bridge extension, packaged as an .xpi and force-installed by policy. It is unsigned, so
# policies.json also lowers xpinstall.signatures.required (allowed on ESR) and, in case a Firefox
# build ignores that, the autoconfig below locks the same preference.
COPY bridge /opt/bridge
RUN mkdir -p /usr/share/deskfish && cd /opt/bridge && zip -qr /usr/share/deskfish/deskfish-bridge.xpi . \
    && chown 1000:1000 /usr/lib/firefox-esr/distribution/policies.json
COPY firefox-autoconfig.js /usr/lib/firefox-esr/defaults/pref/autoconfig.js
COPY firefox.cfg /usr/lib/firefox-esr/firefox.cfg
COPY openbox/menu.xml openbox/autostart /etc/xdg/openbox/
# The panel and the wallpaper. The terminal launcher icon is rendered from SVG at build time;
# the wallpaper is rendered at start-up, at the real screen size.
COPY tint2rc /etc/xdg/tint2/tint2rc
COPY deskfish-terminal.desktop /usr/share/applications/deskfish-terminal.desktop
COPY wallpaper.svg terminal.svg /usr/share/deskfish/
RUN rsvg-convert -w 64 -h 64 /usr/share/deskfish/terminal.svg -o /usr/share/deskfish/terminal.png
COPY daemon.mjs /opt/daemon/daemon.mjs
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /etc/xdg/openbox/autostart

USER bot
WORKDIR /home/bot
ENV DISPLAY=:99 \
    SCREEN=1280x800x24 \
    HOME=/home/bot \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    MOZ_DISABLE_CONTENT_SANDBOX=1 \
    MOZ_DISABLE_GMP_SANDBOX=1 \
    MOZ_DISABLE_RDD_SANDBOX=1 \
    MOZ_DISABLE_SOCKET_PROCESS_SANDBOX=1

EXPOSE 9990
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
