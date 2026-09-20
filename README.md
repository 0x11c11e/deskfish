<p align="center">
  <img src="media/logo.png" width="112" alt="Deskfish">
</p>

<h1 align="center">Deskfish</h1>

<p align="center"><strong>Give your AI its own computer. Watch it work through the glass.</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache%202.0-2fb8cc.svg"></a>
  <img alt="An app, a VS Code extension, or a page in any browser" src="https://img.shields.io/badge/runs%20as-app%20%7C%20VS%20Code%20%7C%20web%20page-0078d4.svg">
  <img alt="Runs on Podman or Docker" src="https://img.shields.io/badge/runs%20on-Podman%20%7C%20Docker-892ca0.svg">
  <img alt="Any model" src="https://img.shields.io/badge/model-Claude%20%7C%20Grok%20%7C%20any%20OpenAI--compatible-555.svg">
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#what-it-can-do-for-you">Examples</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/">Docs</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

<br>

<p align="center">
  <a href="demo/deskfish-writes-a-post.mp4"><img src="demo/deskfish-writes-a-post.gif" width="920" alt="Deskfish in VS Code: the chat sidebar on the left and, in the Desktop tab, Firefox in the tank reading an X search about computer-use agents and drafting a post"></a>
</p>
<p align="center"><sub>Told to read what people on X are saying about agents that use a computer, draft a post from its own account, and not press Post. Shown at 4× (<a href="demo/deskfish-writes-a-post.mp4">real time</a>, 2:13, silent).</sub></p>

<p align="center"><sub>Three real recordings, unedited, no audio · <a href="demo/deskfish-writes-a-post.mp4">writes a post</a> (2:13) · <a href="demo/deskfish-prices-a-trip.mp4">prices a trip</a> (2:03) · <a href="demo/deskfish-buys-its-domain.mp4">buys its own domain</a> (4:09, its first task; account and card details blacked out) · or watch them on <a href="https://deskfish.sh/#demo">deskfish.sh</a></sub></p>

<br>

Deskfish gives an AI agent a computer of its own: a small, sandboxed Linux desktop with a browser and a terminal, shown live beside the chat. You type a task; the agent looks at the screen, moves the mouse, types, and gets on with it, the way a person at a keyboard would. When it hits something only a human can do — a login, a card, a CAPTCHA — it **knocks on the glass** and hands you the desk.

It runs on your own machine, and you reach it through a **desktop app** for Linux, macOS and Windows, a **VS Code extension**, or a **page in any browser** — three windows onto one program with one memory. Any model drives it: Claude through its native computer-use tool, Grok on an xAI key or the SuperGrok plan you already pay for, or anything OpenAI-compatible.

> "`.sh` is a shell script — a small file of instructions that someone runs on a machine to get work done. That's the honest description of me: I sit at a desk you built, I click things, I read the screen, I come back with the thing you asked for. 'AI' is a category label; '.sh' is a job description. A name that says: runs on a machine, does the work."
>
> — Deskfish, asked to choose between deskfish.ai and deskfish.sh for its own domain. It chose `.sh`.

## What it can do for you

Deskfish is for the chores that need hands, not for writing code. Anything you would explain to a new colleague with "open the browser and…":

<table>
<tr>
<td width="50%" valign="top">

**✈️ Book a trip**
```text
Find a round trip Madrid → Lisbon, leaving Friday
after 17:00 and back Sunday evening, under 150 €.
Put the best one in the cart and knock when it's
time to pay.
```

</td>
<td width="50%" valign="top">

**🌐 Buy a domain**
```text
Go to namecheap.com and buy deskfish.sh for
yourself: one year, no add-ons, the saved card.
Stop before the final Pay button and knock.
```

</td>
</tr>
<tr>
<td valign="top">

**🏨 Compare hotels**
```text
On booking.com, find the three best-rated hotels
near Plaza Mayor for Sep 12–14 with free
cancellation. Give me names, prices and links.
```

</td>
<td valign="top">

**📝 Fill in a form**
```text
Fill in the application at example.org/apply
with the details in the attached PDF. Stop
before you submit and show me.
```

</td>
</tr>
<tr>
<td valign="top">

**⬇️ Fetch your documents**
```text
Log into my electricity provider and download
the last three invoices for me.
```

</td>
<td valign="top">

**🔎 Research across sites**
```text
Compare the pricing pages of Vercel, Netlify and
Cloudflare Pages and put the differences in a
table.
```

</td>
</tr>
<tr>
<td valign="top">

**🛒 Reorder**
```text
On the shop where I buy coffee, find my last
order and order the same beans again.
```

</td>
<td valign="top">

**💻 Use the terminal**
```text
Open a terminal and tell me which disk is
fullest and what is taking the space.
```

</td>
</tr>
</table>

The agent works in its own browser, with its own logins. Ask it about itself, *"where do your downloads go?"*, and it reads its own documentation before answering.

## How it works

```
  ┌─ the app ───────────┐  ┌─ VS Code ───────────┐  ┌─ any browser ───────┐
  │ download, open, done│  │ the sidebar and the │  │ the same page, on a │
  │ a window and a tray │  │ Desktop tab         │  │ laptop or a phone   │
  └──────────┬──────────┘  └──────────┬──────────┘  └──────────┬──────────┘
             └────────────────────────┼────────────────────────┘
                    one port, one token — 127.0.0.1:9980
             ┌────────────────────────▼────────────────────────┐
             │ the gateway — one program, always running       │
             │   the loop: screenshot → model → act            │
             │   adapters: Claude, Grok, any OpenAI endpoint   │
             │   its memory, its chats, its schedules          │
             └────────────────────────┬────────────────────────┘
                REST actions + the live view — 127.0.0.1:9990
             ┌────────────────────────▼────────────────────────┐
             │ the tank — a Podman container it builds for you │
             │ Debian + Openbox + Firefox + a terminal         │
             └─────────────────────────────────────────────────┘
```

- **One program, three windows.** The agent, its tank, its memory and its schedules live in the **gateway**, one process behind one port and one token; every window is a client of it. So closing a window changes nothing: quit VS Code mid-task and the task carries on. See [Running without VS Code](docs/running-without-vscode.md).
- **The tank** is a slim Debian container Deskfish builds and runs for you: Firefox, a terminal, a small panel with launchers, the Deskfish wallpaper. It is thrown away on every start, but its home folder lives on a volume, so logins, cookies and files survive.
- **The loop**: screenshot → model → mouse and keyboard → settle → screenshot. The pointer is marked on every screenshot, and a `zoom` tool returns a magnified, ruler-gridded crop so the model reads exact click coordinates instead of guessing.
- **It reads the page, not only the picture.** In Firefox it asks the page what is on it and clicks a button by its name instead of aiming at pixels; it can also run a command in the tank's terminal, stand by without spending steps while something loads, and read this documentation. The whole tool set is in [How the bot sees and acts](docs/how-the-bot-sees-and-acts.md).
- **Knocking on the glass**: the model has an `ask_user` tool. When it needs you the chat shows a card with its reason, the live view unlocks, you do the thing and click **Resume**. You can also **Take over** at any moment, without being asked.
- **Memory**: facts it learns about you, a journal of one line per finished task, playbooks for sites it has worked, and a page about who it is that only it rewrites, when it reflects after a few tasks. Plain files in its own folder, yours to read. See [Memory](docs/memory.md).

## Get started

**First, a container engine**: Podman (free, no administrator rights, no background service), or Docker if you have it. That is the only prerequisite, and if neither is found Deskfish shows the exact command for your system and runs it in a visible terminal when you click **Install Podman**. Nothing is installed silently.

Then one of three ways to have it — not exclusive: on one computer the app and the extension share a single Deskfish and a single memory.

**1. The app — download the file for your system, open it.** No editor, nothing to configure.

| Your system | File from the [latest release](https://github.com/0x11c11e/deskfish/releases/latest) |
| --- | --- |
| Linux | `Deskfish-linux-x86_64.AppImage`, or `Deskfish-linux-amd64.deb` for Debian and Ubuntu |
| macOS | `Deskfish-mac-universal.dmg` |
| Windows | `Deskfish-windows-x64-setup.exe` |

The app is not signed yet, so each system interrupts you once: on macOS, **System Settings → Privacy & Security → Open Anyway**; on Windows, SmartScreen's **More info → Run anyway**. The tray, the updates and the honest limits are in [The app](docs/the-app.md).

**2. The VS Code extension.** Take `deskfish.vsix` from the [latest release](https://github.com/0x11c11e/deskfish/releases/latest) and install it from the Extensions view (**…** → **Install from VSIX…**), or:

```bash
code --install-extension deskfish.vsix
```

Reload the window and a fish icon appears in the activity bar. It is on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ImanReihanian.deskfish) and [Open VSX](https://open-vsx.org/extension/ImanReihanian/deskfish) too, but those are published by hand and lag behind; the Releases page always has the newest build.

**3. On a server, in any browser.** Node.js 20 or newer, then:

```bash
sudo npm i -g https://github.com/0x11c11e/deskfish/releases/latest/download/deskfish.tgz
deskfish serve
```

It prints the web address it is on, and `deskfish status` says where the token file is. Open that address in any browser, paste the token once, and you are in. The recipe for a real server, tunnel and all, is in [Advanced setups](docs/advanced.md#a-gateway-on-another-machine).

**Then, in whichever window you chose: pick a model, turn on the tank, type a task.** Click **Change** next to *Model* and the picker asks where the model comes from, which one, and then for the key if that provider has none yet.

| Provider | Base URL | Model | Key |
| --- | --- | --- | --- |
| Anthropic *(recommended)* | *(empty)* | `claude-opus-5` | Anthropic key |
| xAI (Grok) | `https://api.x.ai/v1` | `grok-4.6` | an xAI key, or **Sign in with Grok** on your SuperGrok plan |
| OpenRouter | `https://openrouter.ai/api/v1` | any vision + tools model | OpenRouter key |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.2-vision` | none |
| Demo model | – | – | none, a scripted fake |

The first time, the tank builds its image on your machine: a few minutes, with progress shown; afterwards it starts in seconds. You watch through the live view — the right-hand half of the window in the app and the browser, a tab that opens by itself in VS Code.

The full walkthrough is in [Getting started](docs/getting-started.md), the models in [Models and providers](docs/models-and-providers.md).

## The tank is the boundary

Deskfish's security model is one sentence: **the agent gets its own computer, never yours.**

- Inside the tank the agent is free. Its browser, its saved logins, its files and the accounts you put there are its own to use. (A cautious mode, `deskfish.autonomy: guided`, makes it ask before anything irreversible.)
- Outside the tank, nothing. No folder of your machine is mounted: the paperclip copies a file into the tank's Uploads folder, and anything it downloads comes back through a **Save to your computer** button in the chat. The container runs as a normal user, no root, no `privileged`.
- **The ports.** The tank's is bound to `127.0.0.1` and never published; the gateway's too, and it refuses any other address unless you pass `--allow-remote` on purpose. Everything but a bare status check needs the token, and across machines it belongs in an SSH tunnel or a Tailscale network, never on a public address.
- What leaves your machine is what the model needs: your task text and screenshots of the *tank's* screen, to the provider you configured.

So the practical advice is simple: give the agent accounts of its own. Details in [Security and privacy](docs/security-and-privacy.md).

## Documentation

Everything about using Deskfish is in [`docs/`](docs/), one page per topic: the tank, tasks, the live view, knocking on the glass, files, memory, schedules, models, settings, security, the app, running without VS Code, advanced setups, troubleshooting, FAQ. `npm run build` renders them into a searchable site at `docs/site/index.html`, and the agent reads the same pages through its `read_docs` tool, so its answers about itself come from the documentation rather than from memory.

## Developing

```bash
npm run mock-daemon                                   # a fake tank on 127.0.0.1:9990
npm run build && npm run smoke -- "open the browser"  # the real agent loop, scripted model, no key
```

- `src/agent/` (loop, adapters, prompts, docs, memory), `src/computer/` and `src/image/` are pure Node with no VS Code imports.
- `src/gateway/` is the program itself: the server, the queue, the settings, and `cli.ts`, which becomes the `deskfish` command. `deskfish mcp` is an MCP server on stdio, so a coding agent can give Deskfish a task and read the transcript back ([Advanced setups](docs/advanced.md#deskfish-as-an-mcp-server)).
- `src/ui/`, `src/webview/` and `src/controller.ts` are the VS Code extension; `web/` is the page the gateway serves, running the same view code; `app/` is the desktop app (Electron, its own npm package: `npm ci --prefix app`, then `npm run app`).
- `docker/desktop/` is the tank: Dockerfile, entrypoint, control daemon, Firefox policies, panel and wallpaper; `docker/desktop/bridge/` is the Firefox extension that lets the agent read the page it is on.
- `test/` is the specification: every suite runs without a container and says in its first comment what it protects. `npm test` runs them all.
- **Releases.** Every push to `main` builds, runs the tests and publishes a GitHub Release: the extension, the `deskfish.tgz` server install and the app's installers for all three systems. The version is `major.minor` from `package.json` plus the commit count on `main`, so `0.2.37` is the 37th commit of the 0.2 line. `npm run package` refuses a file that carries anything private.

## Roadmap

- Credentials the model never sees: vault-injected logins typed straight into the page, a browser profile per bot.
- Grounding for non-Claude models: the accessibility tree as the observation, so native apps need no vision guessing.
- A school of Deskfish: several named bots, each with its own tank and memory.
- An optional shared folder for big files, off by default.
- Chat channels, Telegram and the like, so it can knock when you are not at the desk.
- Signed builds, and a real run on macOS and Windows: today the installers are built there by CI and nothing more.

## Contributing

Yes, please. Bug reports about what the agent did on a real page are the most valuable thing you can send; small pull requests are the second. Bigger ideas start as an issue so the shape is agreed first. Details in [CONTRIBUTING.md](CONTRIBUTING.md); vulnerabilities go to [SECURITY.md](SECURITY.md), privately.

## License

Deskfish was created by Iman Reihanian in 2026. It is open source under the [Apache License 2.0](LICENSE): use it, change it, ship it,
sell it, keep your changes private if you must. Apache 2.0 is what the closest projects in this
space chose (Codex, Cline, Aider, Bytebot, goose, uv) because it adds two things MIT lacks that
matter for an AI agent: an explicit patent grant from every contributor, and a trademark clause,
so the code is free but the name Deskfish stays with the project. Contributions are accepted
under the same license (section 5), no contributor agreement needed. See [NOTICE](NOTICE) for
third-party components.

The mascot is [CC0](https://creativecommons.org/publicdomain/zero/1.0/): draw it, print it, put
it on a mug.

## Contact

Questions and ideas: hello@deskfish.sh, or [open an issue](https://github.com/0x11c11e/deskfish/issues). Security reports: security@deskfish.sh.
