---
title: Getting started
description: The three ways to have Deskfish, then the VS Code path end to end: Podman, the extension, a model, the tank, and your first task.
section: Start here
order: 2
---

Deskfish needs three things: a container engine, a model, and about ten minutes the very
first time. After that, turning the tank on takes a couple of seconds.

## Three ways to have her

The agent, her tank and her memory live in a program of their own, so there is more than one
way to put a window in front of it. All three give you the same fish.

| | | |
| --- | --- | --- |
| **The app** | Download the file for your system, open it, done. No editor, nothing to configure | [The app](the-app) |
| **The VS Code extension** | The sidebar and a live Desktop tab next to your work. The seven steps below | *this page* |
| **On a server** | She runs on a machine that stays awake, and you open her page in any browser | [A gateway on another machine](advanced#a-gateway-on-another-machine) |

They are not exclusive: the app and the extension on one computer share a single Deskfish and a
single memory, and either of them can talk to one on a server instead. See
[Running without VS Code](running-without-vscode).

The rest of this page is the VS Code path.

## 1. Install Podman (or Docker)

The agent's computer is a Linux container, so your machine needs a container engine.
Deskfish is built for **Podman**, which is free, open source, and runs without administrator
rights or a background service. Docker works too if you already have it.

You do not need to figure out the installation yourself. Open the Deskfish view and, if no
engine is found, the sidebar shows a card titled **One thing to install first** with the exact
command for your system. Click **Install Podman**: the command runs in a normal VS Code
terminal, in plain sight, and asks for your password there. Nothing is installed silently.
When it finishes, click **Check again**.

What the card installs, per system:

| System | What happens |
| --- | --- |
| Debian, Ubuntu and derivatives | `podman`, `uidmap` and `passt` through apt, then the user-namespace setup rootless Podman needs |
| Fedora, RHEL, CentOS | `podman` and `passt` through dnf |
| Arch | `podman` and `passt` through pacman |
| openSUSE | `podman` through zypper |
| Alpine | `podman`, `passt` and `shadow-subids` through apk |
| macOS | `brew install podman`, then `podman machine init` and `podman machine start` (Podman runs Linux containers in a small virtual machine) |
| Windows | `winget install RedHat.Podman` (requires WSL 2) |

If your system is not in the list, the card links to Podman's installation guide instead.

> [!NOTE]
> On Linux, rootless Podman needs the `passt` package to publish ports. If it is missing,
> Deskfish still works: it falls back to sharing your machine's network namespace with
> everything bound to `127.0.0.1`. Installing `passt` later restores normal port publishing.

## 2. Install the extension

Download `deskfish.vsix` from [deskfish.sh](https://deskfish.sh). The big button there is the
app for your system; the extension is the **VS Code extension** link on the quiet line under
it. Either way it is the newest build, published to
[GitHub Releases](https://github.com/0x11c11e/deskfish/releases) on every change. In VS Code,
open the Extensions view, choose **Install from VSIX…** from its **…** menu, and pick the
downloaded file. Or from a terminal:

```bash
code --install-extension deskfish.vsix
```

An extension installed from a file does not update itself. To get a newer build, download
the file again and install it over the old one.

If you have the source tree and would rather build the file yourself, you need Node.js 20 or
newer:

```bash
npm install
npm run build
npm run package
code --install-extension deskfish.vsix
```

Either way, then reload the VS Code window (**Developer: Reload Window** from the command
palette). A fish icon appears in the activity bar.

## 3. Pick a model

Click **Change** next to *Model* at the top of the sidebar (or run **Deskfish: Choose
Model…**). It asks two questions: where the model comes from, and which model. The choices
are Anthropic direct (recommended: Claude with its native computer-use tool), OpenRouter (one
key, many models), xAI, Moonshot AI (Kimi), a local Ollama, a LiteLLM proxy, any other
OpenAI-compatible endpoint, or the demo model. Each comes with a short list of suggested
models, and you can always type another name. If the provider needs a key you have not
entered yet, the key prompt opens right after. Keys are kept one per provider, so switching between OpenRouter and Anthropic keeps
both.

If you prefer settings, or want to script them, the same three settings are behind it:

| Setting | What to put |
| --- | --- |
| `deskfish.provider` | `anthropic`, `openai-compatible`, or `mock` |
| `deskfish.model` | The model name exactly as your provider expects it |
| `deskfish.baseUrl` | Empty for Anthropic. The endpoint URL for OpenAI-compatible providers |

Common combinations:

| Provider | Base URL | Model | Key |
| --- | --- | --- | --- |
| `anthropic` | *(empty)* | `claude-opus-5` | Anthropic API key |
| `openai-compatible` | `https://api.x.ai/v1` | `grok-4` | xAI key |
| `openai-compatible` | `https://api.moonshot.ai/v1` | `kimi-k3` | Moonshot AI key (Beijing) |
| `openai-compatible` | `https://openrouter.ai/api/v1` | any vision model with tool calling | OpenRouter key |
| `openai-compatible` | `http://localhost:11434/v1` | `llama3.2-vision` | none (local Ollama) |
| `mock` | – | – | none |

To enter or change a key later, run **Deskfish: Set LLM API Key** from the command palette,
or click **Change** next to *API key* in the sidebar. The key is stored in your operating
system's keychain through VS Code's secret storage, one per provider, and in Deskfish's data
folder in a file only your user account can read (`secrets.json`). It is never written to a
settings file.

> [!TIP]
> Put these three settings in your **User** settings, not in a workspace's settings. Deskfish
> is used from any folder, and workspace settings only apply to one.

> [!TIP]
> Want to see the whole thing move before spending a cent? Set the provider to `mock`. A
> scripted demo model opens the browser, goes to a site, asks for your help once, and
> finishes. No key needed. Details in [Models and providers](models-and-providers).

## 4. Turn on the tank

Click the power button at the top of the sidebar. The very first time, Deskfish builds the
desktop image on your machine from its own recipe: this downloads Debian packages and takes
a few minutes, and the sidebar shows the progress. The image uses about one gigabyte of
disk. Every later start takes a couple of seconds.

By default the tank also turns itself on when you open the Deskfish view, and running a
task turns it on if it is off. You can change that with `deskfish.desktop.autoStart`.

The first time Deskfish runs it also writes the agent's beginnings: the page about who it is,
a few starter notes, and the first line of its journal. Everything after that is its own; see
[Memory](memory).

## 5. Open the Desktop tab

Click **Open** in the Desktop row at the top of the sidebar. An editor tab opens with a live
view of the agent's screen: the Deskfish wallpaper, a small panel at the bottom with Firefox
and Terminal icons, and Firefox open on a blank tab. (From now on this tab also opens by
itself whenever you send a task.) Right-click on it and you get a menu with Firefox
and Terminal, which is also how the agent opens them. Read more in
[The Desktop tab](watching-and-taking-over).

## 6. Give it a task

Type something in the box at the bottom of the sidebar and press Enter. Try one of the
suggestions shown in the empty sidebar, or something like:

```text
Open wikipedia.org, find the article about the Debian operating system, and tell me
when the first version was released.
```

You will see the agent think out loud in the chat, its mouse and keyboard actions fold into
a small **N actions** chip, and the Desktop tab move on its own. Under the chat, one line
counts the tokens the conversation has used (and the cost, where Deskfish can tell), and the
status line below it says what the agent is doing.

When it is done it writes a short summary. You can then ask a follow-up question in the
same box: the agent remembers the conversation and the screen. See
[Running tasks](running-tasks).

## 7. Let it knock on the glass

Give it a task that needs a login, for example on a site where you have an account. When
it reaches the login form it stops, the sidebar shows a card saying **Deskfish needs you**,
and the Desktop tab unlocks. Log in yourself, then click **Resume**. The agent re-reads the
screen and carries on. This is the heart of Deskfish; the details are in
[Knocking on the glass](knocking-on-the-glass).
