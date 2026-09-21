---
title: Advanced setups
description: The gateway on a server, reaching it over a tunnel or Tailscale, the command line, controlling the tank from a terminal, and model gateways.
section: Reference
order: 4
---

None of this is needed to use Deskfish. It is here for people who like terminals, run
things on servers, or want to try the agent without VS Code.

## Peeking at the screen

The tank serves its current screen as a plain image. Open
`http://localhost:9990/screenshot.png` in any browser, or:

```bash
curl -s http://127.0.0.1:9990/screenshot.png -o screen.png
```

## The tank from a terminal

`scripts/desktop.sh` in the source tree does what the power button does, with plain
`podman run` or `docker run`:

```bash
scripts/desktop.sh up            # build the image if missing, then start
scripts/desktop.sh up --build    # rebuild the image first
scripts/desktop.sh down          # stop and remove the container (the home volume is kept)
scripts/desktop.sh status
scripts/desktop.sh logs
scripts/desktop.sh shell         # a shell inside the tank, as the bot user
scripts/desktop.sh screenshot
```

It reads these environment variables:

| Variable | Meaning |
| --- | --- |
| `DESKFISH_CONTAINER_CLI` | `auto`, `podman`, or `docker` |
| `DESKFISH_DESKTOP_TOKEN` | Bearer token for the control API and the live view |
| `DESKFISH_VNC_PASSWORD` | Password for the live view |
| `DESKFISH_SCREEN` | Screen geometry, default `1280x800x24` |
| `DESKFISH_PORT` | Host port for the control API, default `9990` |

The container itself understands `SCREEN`, `DAEMON_TOKEN`, `VNC_PASSWORD`, `DAEMON_BIND`,
`DAEMON_PORT` and `DISPLAY_NUM`.

## A gateway on another machine

Deskfish is one program, the [gateway](running-without-vscode), and it does not have to run on
your laptop. Put it on a machine that stays awake — an old laptop in a cupboard, a mini PC, a
rented server — and her schedules run whether or not you are at your desk, and an interrupted
task is picked up when the machine comes back.

What follows is the whole recipe for a fresh **Ubuntu 24.04** box with systemd. Other Linux
distributions differ only in the package names.

### 1. Podman and Node

```bash
sudo apt update
sudo apt install -y podman passt
```

`passt` is what lets rootless Podman give the tank a network of its own; without it Deskfish
still works but shares the machine's network namespace.

Ubuntu 24.04 ships Node.js 18, which is too old — Deskfish is built for Node 20 or newer. Take
Node 22 from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Deskfish

```bash
sudo npm i -g https://github.com/0x11c11e/deskfish/releases/latest/download/deskfish.tgz
deskfish --help
```

That link always serves the newest build. Run the gateway once by hand so it creates her data
folder and her token, then stop it with Ctrl+C:

```bash
deskfish serve
```

`deskfish status` (in another shell, while it runs) prints the web address and the path of the
token file. Keep that token: it is what every window will sign in with.

### 3. Keep it running

A user service, so it starts at boot and comes back after a crash. Write
`~/.config/systemd/user/deskfish.service`:

```text
[Unit]
Description=Deskfish gateway
After=network-online.target

[Service]
ExecStart=/usr/local/bin/deskfish serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user enable --now deskfish
loginctl enable-linger $USER
```

`enable-linger` is the important one: without it the service stops when you log out of the SSH
session. Her own log is `~/.local/share/deskfish/logs/gateway.log`; if the service will not
start at all, `journalctl --user -u deskfish` says why.

### 4. Reach it from your laptop

**With an SSH tunnel.** Nothing is opened to the network; SSH carries everything:

```bash
ssh -L 9980:127.0.0.1:9980 my-box
```

If your laptop also runs Deskfish, port 9980 is already taken there, so use another local port:

```bash
ssh -L 9981:127.0.0.1:9980 my-box
```

While the tunnel is up:

- **In a browser**, open `http://127.0.0.1:9981/?token=<the token>` once. The page keeps the
  token, so after that `http://127.0.0.1:9981/` is enough.
- **In VS Code**, set `deskfish.gateway.placement` to `remote` and `deskfish.gateway.url` to
  `http://127.0.0.1:9981`, reload the window, and paste the token when it asks (or run
  **Deskfish: Set Gateway Token**).
- **In the app**: not yet. The app always runs or finds a gateway on the machine it is on; a
  field for another machine is still to come. Use the page or VS Code for this.

**With Tailscale.** A private network between your own machines, with no port open to the
internet and no tunnel to remember. (Tailscale is made by Tailscale Inc., Toronto, Canada; the
gateway token travels through it, which is why the origin is worth naming.) Install it on both
machines, then on the box:

```bash
deskfish serve --host 100.x.y.z --allow-remote
```

with its Tailscale address, and use `http://100.x.y.z:9980` as the address in the browser, in
`deskfish.gateway.url`, or on your phone. In the systemd unit, put the same flags on
`ExecStart`.

> [!WARNING]
> **Never use `--allow-remote` on a public address.** The page and its connection are plain
> HTTP: on a public interface the token, and everything she does, would travel in clear, and
> anyone who catches the token owns her tank. A tunnel or Tailscale encrypts the hop between
> your two machines, and then nothing else is needed. Deskfish refuses a non-loopback `--host`
> unless you pass `--allow-remote`, precisely so that this is a decision and not an accident.

**Through a relay, with no port open anywhere.** The third way needs no tunnel, no VPN and no
client on the device you are holding: her gateway dials *out* to a small server you run, your
browser dials the same server, and it passes sealed frames between the two without being able to
read them. In VS Code it is **Deskfish: Remote Access…**; without VS Code it is `deskfish remote
enroll --relay wss://… --username NAME --code CODE` and then `deskfish remote password`, which
write `deskfish.remote.relay` and `deskfish.remote.username` and nothing secret. This works for a
gateway on a rented server exactly as it does for one at home — it opens no port there either.
See [Reaching her from anywhere](remote-access).

### What lives on that machine

Everything of hers except the screenshots:

- the model API key (`secrets.json`, readable only by that user) and the gateway token;
- her facts, the page about who she is and its history, her journal, her playbooks, the charter;
- every chat transcript (text only), `config.json` and `state.json`;
- the tank's volume, with the browser profile and whatever websites it is logged into.

**Screenshots are never written to disk.** They go to the model and to the windows watching,
and then they are gone.

On a machine you rent, the disk belongs to someone else. Two things follow. Choose encryption
at rest, or put her data folder on an encrypted volume. And keep the authoritative copy of her
memory at home: export it from the server's page and import it on your own machine now and
then, and the other way around after a stretch of work on the server. It is a manual step
today — see [Memory](memory#backup-export-and-import).

> [!NOTE]
> This recipe is written from the current behaviour of `deskfish serve`, Podman on Ubuntu and
> systemd user services; a droplet has not been rented and run end to end. If a step is wrong
> on your box, please say so.

## Headless runs without VS Code

The `deskfish` command is the whole program without a window. Install it as above, and:

```bash
deskfish serve                 # the gateway itself; Ctrl+C stops it
deskfish status                # what is running, on what model, and where the token file is
deskfish run "open wikipedia.org and tell me when Debian 1.1 was released"
deskfish stop                  # stop the gateway (the tank keeps running)
deskfish mcp                   # an MCP server on stdio (below)
```

`deskfish run` prints her replies and her actions as they happen. Ctrl+C detaches and leaves the
task running — `deskfish status` shows it, and any window that connects later picks it up
mid-task with the whole chat.

All of them take `--data-dir DIR` and `--port N` when the gateway is not the default one; `serve`
also takes `--host` and `--allow-remote`. `DESKFISH_HOME` moves her data folder, which is
`~/.local/share/deskfish` on Linux, `~/Library/Application Support/deskfish` on macOS and
`%APPDATA%\deskfish` on Windows. Only one gateway may run per data folder; a second `serve` on
the same folder exits rather than compete for her files.

Settings are hers, in `config.json` in that folder, and the way to change them without a window
is the web page the gateway serves (`deskfish status` prints the address), or editing that file
before a start.

> [!NOTE]
> `npm run smoke` in the source tree is a different thing: the agent loop on its own, with no
> gateway, no memory and no schedules, driven by `DESKFISH_*` environment variables. It exists
> for Deskfish's own tests; its variables are listed at the top of `src/smoke.ts`.


## Deskfish as an MCP server

A coding agent — Claude Code, Codex, anything that speaks MCP — can talk to Deskfish the way you
do: give her a task, watch it happen, look at her screen, read what she has written, and tell her
what to do differently. Two uses, one door:

- **Errands.** An agent working in your repository has no browser and no hands. Hers are next
  door: "log in to the dashboard and download last month's invoice" goes to her tank, where the
  browser, the logins and the Downloads folder are.
- **Teaching.** Give her a task from a session that can judge the result, then tell her in the
  same chat what was good and what to do differently. She keeps what she keeps: her playbooks and
  her reflection are hers, and nothing here writes a file of hers.

`deskfish mcp` is that door. It speaks MCP over stdin and stdout and is a **client** of the
gateway — the same port and the same token as a window. It never starts a gateway; if none
answers it says so and exits, so start Deskfish first (VS Code, the app, or `deskfish serve`).

### Registering it

Once, outside any project:

```bash
# installed from the tarball (npm i -g … deskfish.tgz)
claude mcp add --scope user deskfish -- deskfish mcp

# from a source checkout
claude mcp add --scope user deskfish -- node /path/to/deskfish/dist/cli.js mcp

# the app, which brings its own Node inside Electron: the .deb installs under /opt/Deskfish
claude mcp add --scope user deskfish -- env ELECTRON_RUN_AS_NODE=1 /opt/Deskfish/deskfish /opt/Deskfish/resources/deskfish/dist/cli.js mcp

# the AppImage mounts itself somewhere new on every start, so unpack it once and use the copy
./Deskfish-linux-x86_64.AppImage --appimage-extract
claude mcp add --scope user deskfish -- env ELECTRON_RUN_AS_NODE=1 $PWD/squashfs-root/deskfish $PWD/squashfs-root/resources/deskfish/dist/cli.js mcp
```

`claude mcp list` should then say **Connected**, and the tools appear as `mcp__deskfish__run`,
`mcp__deskfish__wait` and so on. Codex takes the same command:

```bash
codex mcp add deskfish -- deskfish mcp
```

or, by hand in `~/.codex/config.toml`:

```toml
[mcp_servers.deskfish]
command = "deskfish"
args = ["mcp"]
```

Add `--port N` and `--data-dir DIR` when the gateway is not the default one. For a Deskfish on
another machine, use `--url http://host:port` and put its token in `DESKFISH_GATEWAY_TOKEN` —
over a tunnel or Tailscale, as in *A gateway on another machine* above. The token is the same one
the web page asks for.

### The tools

| Tool | What it does |
| --- | --- |
| `run` | Give her a task, in her chat, the way you would type it. Queued if she is busy; she turns the tank on herself |
| `say` | A message while she works — a correction, or the answer to a knock. Refused when she is idle |
| `wait` | Block until the task ends, she knocks, or the timeout; returns the chat items since your cursor |
| `status` | What she is doing, the step, the cost and tokens so far in the running task (what the provider reported, or an estimate at list price, marked `costEstimated`), her model, whether the tank is on, what is queued. The counts are live: a finished task's steps and tokens are on its journal line and at the end of its transcript |
| `transcript` | The chat she is in now, or a past one by name |
| `screenshot` | A picture of the tank — a fresh one by default, which is passive and does not interrupt her |
| `stop` | End the running task at once, standby and knocks included |
| `new_chat` | File the chat and start an empty one: the boundary between one errand and the next |
| `chats` | The history, with how each one ended |
| `self`, `journal`, `playbooks`, `memory` | Read her pages: who she is, what she has done, what she has learned, what she remembers |
| `reflect` | Ask her to reflect now rather than at the next due one |

Nothing in that list writes a file of hers, sets a key or changes a setting; those stay with the
windows. An agent using it is a person in her chat as far as she is concerned: what it says is in
the transcript, the run is journaled with what put it there, and **Stop** in any window still
stops her.

> [!NOTE]
> `wait` blocks for up to two minutes, which is longer than some hosts allow a single tool call.
> Claude Code's CLI has no short limit; the desktop app cuts a call at about a minute, so set
> `MCP_TOOL_TIMEOUT` (milliseconds) or ask for a shorter `timeoutSeconds`. Either way the answer
> is to call `wait` again — it is meant to be used in a loop.

## One URL for many models

`docker/docker-compose.yml` starts the tank together with a **LiteLLM** proxy on
`127.0.0.1:4000`, configured by `docker/litellm.config.yaml`. Each entry in that file is a
model name the extension can use, backed by xAI, Anthropic, OpenAI, or an Ollama running on
the host. Keys go in `docker/.env`. Then set the provider to `openai-compatible`, the base URL
to `http://localhost:4000/v1`, and the model to one of the configured names.

The compose file is a convenience for this setup only. The power button in the sidebar
does not use compose.

## Other desktop images

The tank's control API speaks the same protocol as Bytebot's desktop daemon, so a
container built from that project's image can stand in for Deskfish's own, within limits:
only the basic mouse, keyboard and screenshot actions work there. There is no page bridge, so
`find`, `read_page` and `click_element` fail; no `run_command`; no release of stuck keys; and none of the fixes that let the
agent type line breaks and non-ASCII text. Deskfish's own image is the default, the smallest,
and the only one Deskfish vets. Before pointing Deskfish
at any other image, remember that it will hold the agent's browser logins: check who builds
it and where it comes from as carefully as you would for a password manager.
