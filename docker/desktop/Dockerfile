# Deskfish desktop: the smallest useful "computer" for a bot.
#
#   debian:bookworm-slim  (28 MB)        base
#   Xvfb + Openbox + x11vnc + websockify  virtual screen, window manager, remote view
#   tint2 + feh + librsvg                 bottom panel (launchers + open windows), wallpaper
#   firefox-esr + xterm                   the apps (+ curl, python3/pip/requests, git, jq, poppler's pdftotext/pdftoppm,
#                                         zip/unzip, nano in the terminal; libavcodec so Firefox plays H.264/AAC video)
#   xdotool + scrot                       hands + eyes
#   daemon.mjs (Node)                     the control API on :9990  (+ /websockify proxy for noVNC)
#   bridge/ (WebExtension)                the page bridge: lets the agent read the Firefox page and
#                                         find elements by name (find / read_page tools)
#
# No systemd, no desktop environment, no root inside, no privileged mode needed.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox x11vnc websockify xdotool scrot xclip xterm x11-xserver-utils \
      tint2 feh librsvg2-bin \
      firefox-esr libgl1-mesa-dri dbus-x11 fonts-dejavu-core fonts-liberation2 \
      nodejs ca-certificates procps \
      curl python3 python3-pip python3-requests jq git zip unzip nano less xinput \
      poppler-utils libavcodec59 \
    && rm -rf /var/lib/apt/lists/*

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
