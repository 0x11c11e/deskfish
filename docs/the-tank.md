---
title: The tank
description: The agent's own computer. What is inside it, how it is started and stopped, and what survives a restart.
section: Using Deskfish
order: 1
---

The tank is the agent's computer: a Linux container that runs on your machine and that
Deskfish builds, starts, stops and watches for you. You never have to touch it directly,
but it helps to know what is in there.

## What is inside

The tank is the smallest useful desktop for a bot. There is no Ubuntu-style desktop
environment and no system service manager. The agent can use `sudo` inside the tank, and
the tank alone: the container is rootless, so its root is your own unprivileged account on
your computer and nothing more.

| Part | What it is |
| --- | --- |
| Debian 12 (slim) | The operating system |
| Openbox | A one-megabyte window manager. Right-click the empty desktop for its menu |
| Firefox ESR | The browser. Downloads are locked to the Downloads folder, telemetry and update prompts are off. It plays ordinary web video, opens PDFs in its own viewer, and carries the Deskfish page bridge, a small extension that lets the agent read the page it is on and find things by name (see [How the bot sees and acts](how-the-bot-sees-and-acts)) |
| A terminal (xterm) | For commands and for files the agent creates itself. Inside: `bash`, `python3` with `pip` and `requests`, `curl`, `git` and the GitHub CLI `gh`, Node.js 22 with `npm`, `jq`, `pdftotext` and `pdftoppm` for reading PDFs, `zip` and `unzip`, `nano` and `less`. The agent can also run a command in that shell without the screen, through its `run_command` tool. It can install more with `sudo apt-get`, `pip install --user` or `npm install -g`; what `apt` installs is gone at the next tank start unless the agent keeps the commands in `~/.tank/setup.sh`, which runs at every start |
| A panel at the bottom | A small dock with a Firefox icon, a Terminal icon, and a button for every open window |
| The Deskfish wallpaper | So an empty desktop is unmistakably the tank |
| A 1280 × 800 screen | Virtual, so it exists without a monitor. The size is a setting |
| The user `bot` | An ordinary account with passwordless `sudo` inside the container. Its home is `/home/bot`, the one folder that survives a restart |

That is all. Firefox and the terminal are opened from the panel at the bottom of the screen
(or from the right-click menu on the empty desktop), and the agent knows to do that. If you
close Firefox while you have taken over, click its icon in the panel to bring it back; the
panel also lets you switch between open windows.

![The empty tank: the Deskfish wallpaper and the bottom panel with its Firefox and Terminal icons](tank.png)

The tank uses your machine's network to reach the internet. Websites see your public
address, as they would from a browser on your computer. Normally the tank has a network of
its own and does not see your machine's interfaces; on Linux that needs the `passt` package,
and Deskfish warns you when it has to fall back to sharing your machine's network instead.
What that means, and what it does not, is in
[Security and privacy](security-and-privacy#network-exposure).

## Turning it on and off

The power button at the top of the chat sidebar owns the tank's life cycle. The Desktop
chip next to it shows the state:

| Chip says | Meaning |
| --- | --- |
| **Desktop off** | Nothing is running. Click the power button, or just give a task |
| **Turning on…** | Starting. The first time this includes building the image and takes a few minutes |
| **Desktop on** | Ready. The Desktop tab shows the live screen |
| **Turning off…** | Shutting down cleanly |
| **Desktop error** | Something went wrong. The message says what; the log has the details |
| **Needs Podman** | No container engine was found. The sidebar shows the installation card |

Three things turn the tank on: the power button, starting a task while it is off, and
opening the Deskfish view when `deskfish.desktop.autoStart` is enabled (the default). Only
the power button, or the **Deskfish: Turn Desktop Off** command, turns it off. Closing VS
Code does not: the tank keeps running so the next session starts instantly.

Turning it off is graceful. Firefox is asked to close first so it saves its session, its
cookies and its logins, and only then is the container removed.

**Deskfish: Restart Desktop** (in the sidebar's **…** menu or the command palette) turns it
off and on again in one go. It is the fix for a Firefox that stopped responding, a control
daemon that stopped answering, or a network change such as installing `passt`. A running task
is stopped first; files and logins are kept, like any off and on.

## What survives a restart, and what does not

Every time the tank is turned on, Deskfish throws the previous container away and starts a
fresh one from the image. The agent's **home folder is not part of the container**: it lives
in a named storage volume that is attached to each new container. That is why:

| Survives | Erased |
| --- | --- |
| Firefox cookies, logins, history, saved sessions, extensions | Programs that were running |
| Everything in `/home/bot`, including Downloads and Uploads | Anything written outside the home folder |
| Files the agent created in its home | The clipboard |

So if you log the agent into a site today, it is still logged in tomorrow, after a reboot
of your machine, and after Deskfish is updated. When an update changes what is inside the
tank (a new tool, a new program), Deskfish notices at the next start and rebuilds the image
before turning the tank on; the status row says *Updating the desktop image* while it does.
Turning the tank off and on after an update is therefore all it takes to get the new inside.

## Names, for the curious

You do not need any of this to use Deskfish, but if you look at your container engine you
will find:

| Thing | Name |
| --- | --- |
| Image | `localhost/deskfish-desktop:latest`, built locally from Deskfish's own recipe. Nothing is pulled from a container registry |
| Container | `deskfish-desktop` |
| Volume (the home folder) | `deskfish-home` |
| Control port | `9990` on `127.0.0.1` only |

The image is about one gigabyte on disk. An idle tank uses roughly 200 MB of memory before
Firefox is open.

## Resetting the tank

To wipe the agent's home folder and start over, with no logins and no files, turn the tank
off and remove the volume:

```bash
podman volume rm deskfish-home      # or: docker volume rm deskfish-home
```

The next start creates an empty one. To force the image itself to be rebuilt, remove it
and turn the tank on again:

```bash
podman rmi localhost/deskfish-desktop:latest
```

## Changing the screen size

`deskfish.desktop.screen` sets the virtual screen, for example `1440x900x24`. It applies the
next time the tank is turned on. Larger screens show more of a page but cost more tokens per
screenshot; see [How the bot sees and acts](how-the-bot-sees-and-acts) for how screenshots are
scaled.

## The agent's own accounts

Because the tank keeps its logins, the practical way to work is to give the agent accounts
of its own for the services it uses, rather than yours. Log it in once, and it stays logged
in. [Security and privacy](security-and-privacy) explains why that is the recommended setup
for now.

## The agent's own source code

The tank has `git`, `gh`, Node.js and `npm` so that the agent can clone Deskfish's public
repository, read the code that runs it, run the test suite and open a pull request from a GitHub
account of its own. That is the whole of its access: nothing it changes reaches the tank until you
merge the pull request and install the build it produces. See
[How the bot sees and acts](how-the-bot-sees-and-acts#its-own-source-code).
