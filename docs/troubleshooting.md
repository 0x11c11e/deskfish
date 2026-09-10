---
title: Troubleshooting
description: What to do when the tank will not start, the model cannot be reached, or the live view goes dark.
section: Help
order: 1
---

Start with the **Deskfish** output channel (**Deskfish: Show Log**): it has the exact
error for every step, including the container engine's output when the tank fails to start.

## The sidebar says "Needs Podman"

No container engine was found on your `PATH`. Click **Install Podman** on the setup card,
follow the terminal, then **Check again**. If you installed Podman or Docker some other way
and still see this, make sure the command works in a fresh terminal (`podman --version`),
then click **Check again**; Deskfish looks again each time.

If you have both Docker and Podman and Deskfish picks the wrong one, set
`deskfish.desktop.containerCli`.

## The tank will not turn on

The chip says **Desktop error** and the message is the first line of the problem. Common
causes:

- **The image build failed**, typically a network problem while downloading Debian packages.
  Turn the tank on again; the build resumes from where it stopped.
- **Rootless Podman on Linux says something about user namespaces or `subuid`.** Your user
  needs a range of subordinate IDs. The installation card's command sets this up; if you
  installed Podman yourself, run
  `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER` followed by
  `podman system migrate`.
- **Port 9990 is already in use.** Another tank (or something else) is listening. Stop it,
  or start this one on another port from a terminal and change `deskfish.desktop.daemonUrl`
  and `deskfish.desktop.vncUrl`.
- **On macOS the Podman machine is not running.** Run `podman machine start`.
- **On Windows WSL 2 is missing** or the Podman machine is not initialized. Run
  `podman machine init` and `podman machine start` in a terminal.

## "The desktop did not come up within 90 s"

The container started but its control API never answered. The log shows the container's
last lines. Usually this is a very slow machine on the first start; turning the tank on again
works. If it repeats, `scripts/desktop.sh logs` in the source tree shows the full output.

## The model cannot be reached

- **"Cannot reach the model provider at …"** with an OpenAI-compatible provider: the base
  URL is wrong or the server is not running. For a local Ollama or LiteLLM, start it. For xAI
  it must be `https://api.x.ai/v1`. The base URL must not include `/chat/completions`.
- **"rejected the API key"**: enter it again with **Deskfish: Set LLM API Key**. Keys are
  stored per extension, so after reinstalling Deskfish under another name the key has to be
  entered once more.
- **"Cannot reach the Anthropic API at …"**: `deskfish.baseUrl` should be empty for
  Anthropic unless you use a gateway. An old workspace setting pointing at a local proxy is
  a classic cause; check the workspace's `.vscode/settings.json`.
- **"Your Anthropic API key is identity-linked…"**: the key is tied to your user rather than
  to a workspace, so Anthropic needs the workspace ID with each request. Put it in
  `deskfish.anthropicWorkspaceId` (Anthropic Console → Settings → Workspaces, `wrkspc_…`), or
  create a workspace-scoped key. See [Models and providers](models-and-providers#anthropic).
- **Rate limit**: the message says so. Wait, or use another model.

## The live view is black or says "Connecting…"

The view retries by itself with growing pauses (up to half a minute), also right after your
machine wakes from sleep or the tab is shown again. **Reconnect** makes it try immediately.
If it still does not connect, check the Desktop row: the tank may be off or starting. If the
tank is on and the view never connects, the log will show whether the control port answers.

## Every click selects text, keys seem stuck, or I cannot select with the mouse

A key or mouse button is being held down inside the tank without anyone holding it: a
release that never arrived, because the mouse was let go outside the live view, a window
switch happened with Alt down, or the editor swallowed a key-up. With Shift held every click
selects text; with Alt held, dragging moves the window instead of selecting.

Deskfish now lets go of held keys by itself: whenever you start interacting with the live
view, whenever control passes between you and the agent, when a task starts, and, as a last
resort, whenever the tank sees a modifier key or a mouse button held for thirty seconds
straight, or any other key for sixty. The output log says what was released and when. If you
still see it, click once inside the live view and wait a second, or turn the desktop off and
on, and tell us what the log said.

## The task stopped at the step limit

That only happens if you set `deskfish.maxSteps` (the default is no limit). At the cap the
agent writes a summary of what it found and the task ends as *Done*; type **continue** and it
picks up where it stopped, with everything it learned. If the agent burns steps scrolling a
long page a few lines at a time, tell it what you are looking for more precisely; it is
instructed to scroll in big jumps and to use find-in-page, but a precise goal helps most.

## The agent keeps repeating itself

It cannot do that for long. When the same actions repeat three times and nothing on screen
changes, Deskfish tells it to change approach; if it stalls again it hands you the desktop with
*"I seem to be stuck"*. Tell it what to try in the
chat, or do the step yourself and click Resume. For a budget on what a task may spend, where
Deskfish can see the cost, set `deskfish.maxCostUsd`.

## Deskfish says the tank is sharing my machine's network

Rootless Podman on Linux needs the `passt` package to give the tank a network of its own.
Without it Deskfish still works, but the tank sees your network interfaces and can reach
devices on your LAN, and it tells you so when the desktop turns on. Click **Install passt** in
that message (or install it with your package manager), then turn the desktop off and on. The
warning does not come back.

## The task ended with no reply

If the status row says *Task finished — the model ended without a reply*, the model's last
turn came back with nothing in it. Through OpenAI-compatible endpoints the usual cause is a
reasoning model spending its output budget thinking; Deskfish now asks once for the rest and
reports an error if it gets nothing again. Ask her to continue, or switch to the direct
Anthropic path for that task.

## The status row says "Reflecting…"

That is not a task. After every few finished tasks the agent takes a short run alone with its
notes to save facts and playbooks and, sometimes, change the page about who it is. In the
chat it appears as one folded card whose line says what changed; open it for the details. It
takes a few model turns, billed by your provider; set `deskfish.reflectEvery` to `0` if
you would rather run it yourself from the **…** menu. See [Memory](memory#reflection).

## The memory chip says "1 not saved"

Open it: the agent tried to save something over its size limit, a playbook over 2,500
characters or a fact over 400. The message tells it exactly how much to cut, and it usually
writes a shorter one right after, which shows in the same chip. Nothing to do on your side.

## The agent got the date wrong

Older builds never told the agent what time it was, so a task from an hour ago could read as
"yesterday" in its notes. Every run now starts with the current date and time. If you still
see it, reload VS Code to pick up the current build.

## The agent keeps missing small buttons

Vision models misclick on tiny targets, and smaller models more so. Deskfish gives the
agent a zoom tool for exactly this and tells it to use it, but a model can still be
stubborn. Things that help: a stronger model (Claude with the Anthropic provider is the
most accurate), a slightly smaller screen (`deskfish.desktop.screen` at `1280x800x24`),
and taking over for the one click it cannot land.

## I closed Firefox inside the tank

Click the Firefox icon in the panel at the bottom centre of the screen (take over first if a
task is running). The agent does the same when it finds no browser window. The right-click
menu on the empty desktop has Firefox and Terminal too.

## Firefox shows "already running" or asks to restore a session

This happens when the tank was stopped abruptly, for instance by killing the container
engine. Deskfish stops Firefox cleanly when it turns the tank off, so it is rare. Take
over, close the dialog, and hand back; if Firefox refuses to open at all, turn the tank
off and on again.

## Logins disappeared

Logins live in the `deskfish-home` volume. They disappear only if that volume was removed,
or if the tank is pointed at a different volume. Check with `podman volume ls`.

## Starting completely fresh

Turn the tank off, then:

```bash
podman volume rm deskfish-home
podman rmi localhost/deskfish-desktop:latest
```

The next start rebuilds the image and creates an empty home folder.

## `find` or `read_page` say Firefox is not open, or the page did not answer

These tools are answered by the Deskfish page bridge, an extension inside the tank's
Firefox. *Firefox is not open* means exactly that: the agent opens it from the panel and
tries again. *The page did not answer* means the page was still loading, or it is one that
Firefox does not let extensions read (its own `about:` pages, the add-ons site, PDFs); the
agent waits or falls back to the screenshot. If the answer is *unknown action "page_find"*,
the tank is running an image from before the bridge existed: turn the desktop off and on,
and Deskfish updates the image.

## Still stuck?

Copy the relevant lines from the Deskfish output channel; they say what was attempted and
what came back. Deskfish's own answer to *"why did that fail?"* is also often useful: the
agent can read this documentation, and it saw the same screen you did.
