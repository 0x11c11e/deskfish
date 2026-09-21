# The relay: one small Node program, one dependency, no state but a JSON file on /data.
# Build:  podman build -t deskfish-relay relay
# Run:    podman run -d --name deskfish-relay -p 127.0.0.1:8080:8080 \
#           -e RELAY_ADMIN_KEY=… -v deskfish-relay-data:/data deskfish-relay
# Put your own TLS proxy in front of it (relay/README.md has Caddy, Traefik and nginx).
FROM node:22-alpine

WORKDIR /app
# The lockfile is not committed: one dependency, pinned by the range in package.json, and an
# image that installs it at build time is reproducible enough for a program of this size.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs store.mjs ./

# /data holds users.json (the users list, unspent enrolment codes, daily counts) and nothing else.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

ENV RELAY_PORT=8080 RELAY_DATA=/data RELAY_LOG=quiet
EXPOSE 8080
# No RELAY_ADMIN_KEY here on purpose: the program refuses to start without one, and a key baked
# into an image is a key in a registry.
# Docker honours this; Podman's default OCI image format drops it with a warning at build time
# (`podman build --format docker` keeps it). Either way `GET /status` is the check.
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.RELAY_PORT+'/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
