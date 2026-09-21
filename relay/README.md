# The Deskfish relay

Deskfish runs on your own computer, and your computer opens no port. To reach her from a phone
on the road, something in the middle has to be reachable by both of you — so **she dials out** to
this program and holds the connection, your browser dials the same program, and it passes frames
between the two. Both hops are outbound, which every home router and firewall allows.

This is that program. It is about six hundred lines of Node with one dependency.

## What it can and cannot see

**It cannot read anything you do.** The page you sign in on and her gateway agree on keys through
here, using [OPAQUE](https://www.rfc-editor.org/rfc/rfc9807.html) — a password exchange in which
the password never crosses the wire, not even hashed, and which a machine that records the whole
handshake cannot take away and attack offline. Everything after that is AES-256-GCM, sealed before
it enters this program and opened only at the two ends. This relay's one job is to copy bytes from
one socket to the other; the only thing it ever reads out of a frame is the four-byte client number
at its front. There is no log level that prints a frame, because there is no code that opens one.

**It cannot pretend to be her.** Without the registration record — which never leaves her
machine — a server here cannot finish the password exchange. A page that reaches an impostor is
told so and shows you a refusal instead of a chat.

**What it does know**: the usernames enrolled on it, which of them is connected right now, the
addresses connections come from, how many bytes went by, and when. That is unavoidable for a post
box, and it is what the usage counters are made of.

**One condition this program cannot give you on its own**: the sign-in page must be served from
somewhere else. Sealing a frame is worth nothing if the same machine can hand your browser altered
code that leaks the key. Deskfish's page is a single static file published separately from any
relay; if you host your own, host it somewhere other than this container.

## What it stores

One file, `/data/users.json`:

- the users list — a username against the Ed25519 public key allowed to hold its uplink;
- enrolment codes that have been minted and not yet spent;
- daily totals per username: seconds connected, bytes each way.

No chat, no message, no frame, no screenshot, no addresses. Deleting the file forgets every
enrolment; nothing else is lost.

## Running it

```bash
# A key only you hold. It mints enrolment codes; it is not a password anyone signs in with.
printf 'RELAY_ADMIN_KEY=%s\n' "$(openssl rand -base64 32)" > relay.env
chmod 600 relay.env

podman build -t deskfish-relay relay          # or docker build
podman run -d --name deskfish-relay --restart unless-stopped \
  --env-file relay.env -p 127.0.0.1:8080:8080 \
  -v deskfish-relay-data:/data deskfish-relay
```

`relay/compose.example.yml` is the same thing for `podman compose` or `docker compose`.

**Give it a named volume, not a folder of your own.** A rootless container runs as a user your host
does not share, so a directory you bind-mount is not its to write; the relay checks at startup and
says so rather than failing at your first enrolment. (Podman also drops the image's `HEALTHCHECK`
unless you build with `--format docker`; `GET /status` is the check either way.)

It listens on `127.0.0.1:8080` and expects **your own TLS proxy** in front of it, because browsers
need `wss://` and so does the gateway. Do not publish 8080 straight to the internet: besides the
missing certificate, the connection rate limit counts `x-forwarded-for` — the last address in it,
the one your proxy appended — which only a proxy you run can be trusted to set. One of these, with
a name you own pointed at the machine:

**Caddy** — the whole of it:

```caddyfile
relay.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

**Traefik**, as labels on the container:

```yaml
labels:
  - 'traefik.enable=true'
  - 'traefik.http.routers.relay.rule=Host(`relay.example.com`)'
  - 'traefik.http.routers.relay.tls.certresolver=le'
  - 'traefik.http.services.relay.loadbalancer.server.port=8080'
```

**nginx** — WebSockets need the upgrade headers and a long read timeout, or an idle uplink is cut
every minute:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

## Settings

All of it is environment variables; there is no configuration file.

| Variable | Default | What it is |
| --- | --- | --- |
| `RELAY_ADMIN_KEY` | — | **Required.** The key that mints enrolment codes and reads usage. The relay refuses to start without one. |
| `RELAY_PORT` | `8080` | The port it listens on. |
| `RELAY_HOST` | `0.0.0.0` | The address it binds inside the container. |
| `RELAY_DATA` | `/data` | Where `users.json` lives. |
| `RELAY_LOG` | `quiet` | `quiet` prints errors only; `events` adds one line per connection, enrolment and disconnection. Neither prints a frame. |
| `RELAY_MAX_CLIENTS_PER_USER` | `8` | Browser windows on one username at once. |
| `RELAY_RATE` | `30` | New connections from one address per minute. |

## Enrolling yourself

Enrolment is by a **one-time code**, not by the admin key, so the key never has to leave the
machine it runs on — and so that a relay serving other people later works the same way.

```bash
# On the relay's machine (or anywhere, with the key):
curl -s -X POST https://relay.example.com/admin/codes \
  -H "authorization: Bearer $RELAY_ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"username":"yourname"}'
# → {"code":"…","username":"yourname"}
```

Then, at home, in VS Code: **Deskfish: Remote Access…**, which asks for the relay address, the
username and that code, and then for a password twice. Or, without VS Code:

```bash
deskfish remote enroll --relay wss://relay.example.com --username yourname --code <the code>
deskfish remote password
```

The code is spent the moment it is used, and a username is taken once on a relay.

## The other endpoints

```
GET    /status                 { "name": "deskfish-relay", "version": … } and nothing else
POST   /admin/codes            (admin key) { "username": … } → a one-time code
DELETE /admin/users/:name      (admin key) revoke a username; its uplink is dropped
GET    /admin/usage/:name      (admin key) { "days": { "2026-09-20": { seconds, up, down } } }
POST   /enroll                 { code, username, publicKey } — no admin key; the code is spent
WS     /uplink                 her gateway, after signing a challenge with its enrolled key
WS     /client?user=<name>     a browser; { "offline": true } and a close when she is not here
```

## Running it for others

Nothing in this program is specific to one person: usernames are independent, enrolment is by a
code an operator mints, and the usage counters exist because an operator has to bill and cap
something. What the code does **not** give you, and what a paid relay needs beyond it:

- an entity to take money, a payment processor, terms and a privacy statement that say plainly
  what is and is not visible to you (this README's first section is the honest version);
- a page that mints a code after payment, and one that revokes;
- quotas: the counters are written, nothing enforces a limit yet;
- a status page, backups of `users.json`, and a way to restore it;
- abuse handling **by metadata only**. You cannot see content — by design, permanently — so the
  only signals you will ever have are bytes, hours, addresses and complaints. Decide before you
  sell anything whether that is enough for you, because adding a way to look inside would break
  the promise the rest of this makes.

## Updating it

The relay speaks a stable, tiny wire: a challenge, a signature, then `[client number][bytes]`.
A gateway of a different version than the relay is fine. Rebuild the image and restart it; every
connected browser reconnects, and a task she is running at home is not interrupted by any of it —
the relay holds no state a session depends on.
