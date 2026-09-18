---
title: The app
description: Deskfish as a program you download and open — the window, the tray, starting at login, updates, and Podman on macOS and Windows.
section: Start here
order: 4
---

The app is Deskfish without anything around it: download a file, open it, and the fish has a
window. No editor, no terminal, no configuration. Inside, it is the same
[gateway](running-without-vscode) everything else talks to — the app simply runs one itself
and shows you the page it serves.

## Download

Every build is published on [GitHub Releases](https://github.com/0x11c11e/deskfish/releases/latest).
Take the file for your system:

| System | File | How to install |
| --- | --- | --- |
| Linux (most) | `Deskfish-linux-x86_64.AppImage` | Make it executable and run it (below) |
| Debian, Ubuntu | `Deskfish-linux-amd64.deb` | Install it with apt (below) |
| macOS | `Deskfish-mac-universal.dmg` | Open it, drag Deskfish to Applications |
| Windows | `Deskfish-windows-x64-setup.exe` | Run it |

On Linux that is two lines in a terminal, or the package manager:

```bash
chmod +x Deskfish-linux-x86_64.AppImage
./Deskfish-linux-x86_64.AppImage
```

```bash
sudo apt install ./Deskfish-linux-amd64.deb
```

**The app is not signed yet**, so both Apple and Microsoft will interrupt you once:

- **macOS** refuses the first launch. Open **System Settings → Privacy & Security**, scroll to
  the message about Deskfish, and click **Open Anyway**. After that it starts normally.
- **Windows** shows SmartScreen's blue "Windows protected your PC". Click **More info**, then
  **Run anyway**.

Signing is on the list; until then, this is the honest state of it, and the only place to get
a genuine build is that Releases page.

> [!NOTE]
> The AppImage needs FUSE. On Debian and older Ubuntu that is `libfuse2`; on Ubuntu 24.04 and
> newer it is `libfuse2t64`. If it will not start at all, install that package, or use the
> `.deb`. On GNOME, the tray icon needs the **AppIndicator** shell extension — without it the
> app runs fine but has no tray icon, so close the window with care (see below).

## The first start

The app looks for a gateway already running on port 9980 and, if there is none, starts one
inside itself. Either way there is exactly one, and it uses the **same data folder** as the
VS Code extension: the same agent, the same memory, the same chats. Open both and you are
looking at one fish from two windows.

If both are open and they are different builds, the newer one takes over when the older one is
idle — you never have to think about it, and a build that is in the middle of a task is left
alone until it is free.

The window is the web page the gateway serves, so everything is there: the chat, the live view
of the tank, past chats, settings, scheduled tasks, her files. There is no sign-in — the app
started the gateway and already knows the token.

## The tank

The agent's desktop still runs in a container, so the machine needs Podman (or Docker). If
neither is there, the app offers **Install Podman**: it opens your system's terminal with the
right command, in plain sight, and asks for your password there. Nothing is installed silently.

On **macOS and Windows**, Podman runs Linux containers inside a small virtual machine. Deskfish
creates and starts that machine itself the first time you turn the tank on, and says what it is
doing while it happens — this takes a few minutes once, then seconds. You do not need to run
`podman machine init` yourself.

## The window and the tray

- **Closing the window hides it.** The app keeps running, the task keeps going, and the tray
  icon brings the window back.
- **The tray menu** has: a knock indicator and **Open Deskfish**, **Desktop on/off**,
  **Start when I log in**, and **Quit**.
- **Quit** stops the gateway the app started, so her tasks and schedules stop with it. The tank
  keeps running — turn it off from the tray first if you want it gone. If the app attached to a
  gateway someone else started (VS Code's, or a `deskfish serve`), Quit leaves that one alone.
- **When she knocks on the glass** the window title changes, the taskbar entry asks for
  attention, and your system shows a notification. Click it and the window comes up on the
  chat where she is waiting.

## Start when I log in

The tray's **Start when I log in** makes her come back after a restart, so schedules run and an
interrupted task is picked up. What it writes:

| System | What it adds |
| --- | --- |
| Linux | `~/.config/autostart/deskfish-app.desktop` |
| macOS | A login item for Deskfish |
| Windows | A login item for Deskfish |

Turning it off removes the same thing. It is only ever the app's own entry; the VS Code
extension's **Keep Running** setting writes a separate one and the two do not collide (the
first one up holds the port, the second attaches).

The app also takes a few flags, if you want them: `--hidden` (start in the tray without a
window), `--port N` or `DESKFISH_PORT`, and `DESKFISH_HOME` for another data folder.

## Updates

The app checks this project's [GitHub Releases](https://github.com/0x11c11e/deskfish/releases)
— that repository and nothing else — when it starts and once a day after that. It never
downloads anything without asking, and never restarts without asking: you get a message naming
the version, you say yes, it downloads, and then it asks again before restarting into it.

Updates are **off on macOS** until the app is signed, because an unsigned update is not
something you should be asked to trust. Update by downloading the new `.dmg`.

## Where things are

The app stores nothing of hers outside her normal data folder (see
[Running without VS Code](running-without-vscode#where-she-lives-on-disk)); it only adds
`logs/app.log` there. The window's own browser storage is kept in memory and thrown away when
the app quits, so the gateway token is on disk in `gateway.token` and nowhere else. The
rendering engine keeps its caches in `~/.config/Deskfish` (and the equivalent on macOS and
Windows); nothing of hers is in there.

## Honest limits

- The app is **built for macOS and Windows but has not been run there yet**: the installers, the
  login item, the Podman VM step and the terminal it opens are written from the documentation
  of each system and tested on Linux. If something is wrong on your Mac or PC, that is the most
  likely place, and we would like to hear about it.
- There is **no field for a gateway on another machine** in the app yet. For that, use the web
  page (the address and the token) or the VS Code extension; see
  [Advanced setups](advanced#a-gateway-on-another-machine).
- The tray needs a tray. On GNOME that means the AppIndicator extension, as above.

If the terminal you started it from prints lines about `vaInitialize` or a GPU process, that is
the rendering engine probing your graphics card and it is harmless — see
[Troubleshooting](troubleshooting#the-app-prints-lines-about-vainitialize-or-the-gpu-process).
