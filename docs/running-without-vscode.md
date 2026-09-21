---
title: Running without VS Code
description: Deskfish is a program of its own; VS Code is one way to talk to it. The app, the web page, the command line, and where she should live.
section: Start here
order: 3
---

VS Code was the first window onto Deskfish, and for a while it was the only one. It is not
the product. The agent, her tank, her memory and her schedules live in a program of their
own, and you can reach that program from a desktop app, from any browser, from VS Code, or
from a terminal. Pick whichever suits you; they are all looking at the same fish.

## One program, one port, one token

The program is called the **gateway**. One process, started once, holds everything:

- the tank (the container with the agent's desktop);
- the agent loop that looks at the screen and moves the mouse;
- her facts, her journal, her playbooks, the page about who she is;
- every chat transcript, and the scheduled tasks;
- the model settings and the API key.

It listens on **one port**, `9980` on this computer by default, behind **one token**, and it
serves the web page itself. Everything else — the app's window, the VS Code sidebar, the
browser tab, `deskfish run` — is a client of it. Because exactly one process writes her
files and runs one queue, two windows open at once never fight: a task started in VS Code is
the same task the browser shows, with the same chat, the same live view and the same status.

And because the gateway is not inside any window, closing a window changes nothing. Quit VS
Code in the middle of a task and the task carries on; open the page an hour later and you see
where she got to.

## The three ways to watch her

| | What it is | Best for |
| --- | --- | --- |
| **The app** | A desktop app for Linux, macOS and Windows. It *is* the gateway: it starts one inside itself, opens a window on the page, and sits in the tray | Anyone who does not use VS Code. Download, open, done. See [The app](the-app) |
| **The VS Code extension** | The sidebar and the Desktop tab, alongside your work | People who live in VS Code. See [Getting started](getting-started) |
| **The web page** | Whatever the gateway serves at its own address, in any browser | A gateway on another machine, a second screen, a phone or tablet on your own network |

The web page is not a cut-down view. It has the chat, the live view of the tank, the history
of past chats, the settings, the scheduled tasks, her files, the model and key dialogs, and
the **…** menu — the same code the VS Code sidebar runs, in a page instead of a webview. The
one thing only VS Code does is open her editable files in a real editor.

## Signing in, once

Open the gateway's address in a browser and it asks for the token. Paste it once and the page
remembers it in that browser; you will not be asked again on that machine.

Where to find the token:

- `deskfish status` prints the web address and the path of the token file.
- The token file itself is `gateway.token` in her data folder (see below), readable only by
  your user account.
- If you use the app, the window is already signed in — it started the gateway and knows the
  token.

If you would rather not paste it, `http://<address>/?token=<token>` signs in and then keeps
the token for next time.

> [!NOTE]
> The page and its connection are plain HTTP, which is fine on `127.0.0.1` and fine over an
> SSH tunnel or Tailscale, and wrong on a public address. See
> [Security and privacy](security-and-privacy#one-port-one-token).

## From a terminal

Installing the `deskfish` command puts all of this in one place:

```bash
sudo npm i -g https://github.com/0x11c11e/deskfish/releases/latest/download/deskfish.tgz
```

Node.js 20 or newer, and a container engine for the tank. Then:

```bash
deskfish serve                 # run the gateway in the foreground (Ctrl+C stops it)
deskfish status                # is it running, on what, with which model — and the token file
deskfish run "book a table"    # give her a task and watch it; Ctrl+C detaches, she keeps going
deskfish stop                  # stop the gateway (the tank keeps running)
deskfish mcp                   # an MCP server on stdio, for a coding agent to use her
deskfish remote status         # is she reachable from a browser anywhere, and from where
```

Reaching her from away from home is `deskfish remote`: `enroll --relay wss://… --username NAME
--code CODE` once, then `password` to set what the sign-in page asks for, and `off` when you want
it to stop. She dials *out* to the relay, so nothing here opens a port —
[Reaching her from anywhere](remote-access) is the whole story.

`serve` takes `--data-dir DIR`, `--port N`, `--host H` and `--allow-remote`; the others take
`--data-dir` and `--port` so they can reach a gateway that is not on the default one.
`deskfish mcp` is for Claude Code, Codex and anything else that speaks MCP — see
[Deskfish as an MCP server](advanced#deskfish-as-an-mcp-server). Only one
gateway may run per data folder — a second `serve` on the same folder refuses to start, which
is what keeps her one writer.

Everything the gateway prints also goes to `logs/gateway.log` in her data folder.

## Where she lives on disk

| System | Her data folder |
| --- | --- |
| Linux | `~/.local/share/deskfish` |
| macOS | `~/Library/Application Support/deskfish` |
| Windows | `%APPDATA%\deskfish` |

Set `DESKFISH_HOME` to put it somewhere else. Inside it are her facts, her self page and its
history, her journal, her playbooks, the charter, `chats/`, `schedules.json`, `config.json`
(the settings she runs on), `secrets.json` (the API key, readable only by you),
`gateway.token`, `state.json` (what she was doing, so an interrupted task is picked up) and
`logs/`.

Everything in that folder is hers. Copying it to another machine moves her, as long as you
also move the tank's volume or accept that she will be logged out of the websites her browser
remembered.

## Where she should live

The gateway can run anywhere. Which machine you choose is a privacy decision, so here it is as
a ladder, cheapest to most careful:

1. **Your laptop.** Everything stays on the machine you already trust. She only runs while it
   is awake, so a schedule at three in the morning is missed if the lid is closed.
2. **A small box at home.** An old laptop, a mini PC, a Raspberry-class machine — anything that
   stays on. Her data never leaves your house, and her schedules actually run. Reach it over
   your own network with an SSH tunnel or Tailscale.
3. **A rented server.** Always on, always fast, and the provider's disk. Use it when you need
   the uptime, with the conditions below.

Whatever you choose, **what lives with the gateway** is the same list: the model key, the
gateway token, her memory, her self page, her journal, her playbooks, the chat transcripts,
her settings and her state. Her screenshots are *not* written to disk — they go to the model
and to whatever window is watching, and then they are gone.

On a rented server, three things are worth doing:

- **Encrypt the disk** (or put her data folder on an encrypted volume). It is someone else's
  hardware.
- **Keep her authoritative copy at home.** Export her memory from the server's page and import
  it at home now and then, and the other way around after a stretch of work on the server. It
  is a manual step today; see [Memory](memory#backup-export-and-import).
- **Never open her port to the internet.** A tunnel or Tailscale, never `--allow-remote` on a
  public address.

The recipe for a server, end to end, is in
[Advanced setups](advanced#a-gateway-on-another-machine).

## Where to go next

- [The app](the-app) — download, tray, updates, the Podman VM on macOS and Windows.
- [A gateway on another machine](advanced#a-gateway-on-another-machine) — Ubuntu, systemd, the
  tunnel, Tailscale.
- [Security and privacy](security-and-privacy#one-port-one-token) — what the one port and the
  one token actually protect.
