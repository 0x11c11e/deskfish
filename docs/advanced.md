---
title: Advanced setups
description: Controlling the tank from a terminal, running it on another machine, headless runs, and model gateways.
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

## A tank on another machine

The tank can run anywhere Linux containers run, for example on a small VPS, while VS Code
runs on your laptop.

1. Start the tank there with a token:
   `DESKFISH_DESKTOP_TOKEN=some-long-secret scripts/desktop.sh up`.
2. VS Code's live view can only open unencrypted connections to `localhost`, so tunnel the
   port: `ssh -L 9990:localhost:9990 my-vps`.
3. Put `some-long-secret` in `deskfish.desktop.token`. The default URLs already point at
   `localhost:9990`, which is now the tunnel.

Set `deskfish.desktop.autoStart` to `false` on the laptop so Deskfish does not try to start a
local tank as well. The power button controls local tanks only; a remote tank is started and
stopped on its machine.

Without a tunnel, the tank would have to be published behind an encrypted `wss://` proxy
with the token; the plain control port must never be exposed to a network.

## Headless runs without VS Code

The same agent loop the extension uses can be driven from a terminal, which is how
Deskfish itself is tested:

```bash
npm run mock-daemon            # a fake tank on 127.0.0.1:9990 with a synthetic screen
npm run build
npm run smoke -- "open the browser and go to wikipedia.org"
```

By default this uses the demo model. Environment variables select a real one and a real
tank:

| Variable | Meaning |
| --- | --- |
| `DESKFISH_PROVIDER` | `mock`, `anthropic`, or `openai-compatible` |
| `DESKFISH_MODEL`, `DESKFISH_BASE_URL`, `DESKFISH_API_KEY` | As the settings of the same names |
| `DESKFISH_DAEMON_URL`, `DESKFISH_DAEMON_TOKEN` | The tank to drive |
| `DESKFISH_MAX_STEPS`, `DESKFISH_SCREENSHOT_WIDTH`, `DESKFISH_SETTLE_MS` | As the settings, with headless defaults of 15 steps and 300 ms |
| `DESKFISH_DOCS_DIR` | Where the documentation pages are, if not the `docs` folder next to `dist` |
| `DESKFISH_MAX_COST_USD`, `DESKFISH_AUTONOMY`, `DESKFISH_WORKSPACE_ID`, `DESKFISH_PROMPT_CACHING` | As the settings of the same names |
| `DESKFISH_MEMORY_FILE` | A facts file to use; without it the headless agent has no memory |
| `DESKFISH_MEMORY_DIR` | A folder for the self page, journal and playbooks; on first use it writes the seed and the starter notes |
| `DESKFISH_SELF_KEY` | The signing key for the self page (hex); a random one is used when unset, so signatures will not carry over |
| `DESKFISH_REFLECT_EVERY` | Reflect after this many finished tasks, default `0` (never, headless) |

The headless runner is the loop without the extension around it. It has no ledger, no
`userName` and no schedules, and it stops at 15 steps unless you raise `DESKFISH_MAX_STEPS`.

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
`find` and `read_page` fail; no `run_command`; no release of stuck keys; and none of the fixes that let the
agent type line breaks and non-ASCII text. Deskfish's own image is the default, the smallest,
and the only one Deskfish vets. Before pointing Deskfish
at any other image, remember that it will hold the agent's browser logins: check who builds
it and where it comes from as carefully as you would for a password manager.
