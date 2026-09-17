---
title: Settings
description: Every Deskfish setting, its default, and what it changes.
section: Reference
order: 1
---

In VS Code, open **Settings** and search for *Deskfish*, or choose **Deskfish: Settings…** in the
chat's **…** menu; on the web page, press the settings icon in the title bar. All settings live
under the `deskfish` prefix. (The **Change** button next to
*Model* in the chat opens the model picker, which sets the three model settings for you; the key
has its own button too. Neither opens this list.)

## One set of settings

Deskfish keeps its settings itself, in `config.json` in its data folder, and runs on those —
whichever window or page changed them last. VS Code mirrors them into your **User** settings, so
the two always agree: a value you set on the web page shows up in VS Code's settings (and in
`settings.json`), and a value you change in VS Code shows up on the page. The very first time
Deskfish starts, it takes VS Code's settings as they are.

**An edit made while VS Code was closed is kept.** VS Code remembers the settings both sides last
agreed on. When it opens again, a setting you changed in `settings.json` in the meantime is sent
to Deskfish; a setting changed on the web page in the meantime is written into `settings.json`.
If the same setting was changed in both places to different values, Deskfish's value wins and
the Deskfish log names the setting.

The **Settings** panel (in the chat, in VS Code and on the web page alike) shows the same settings
with the words VS Code shows, in three groups: *How she works*, *Her desktop*, and *Advanced*
(folded). **Save** sends only what you changed; a value Deskfish does not accept is marked on its
field and nothing is saved. The three *Where Deskfish runs* settings below belong to VS Code alone
and are not in the panel.

> [!TIP]
> Keep Deskfish settings in your **User** settings. A folder's (workspace) settings are not sent
> to Deskfish and are not updated when a value changes elsewhere; Deskfish writes a line in its
> log when one hides a value in a window.

## Model

| Setting | Default | What it does |
| --- | --- | --- |
| `deskfish.provider` | `anthropic` | Which adapter drives the desktop: `anthropic` (Claude direct, the recommended path), `openai-compatible`, or `mock` |
| `deskfish.autonomy` | `free` | `free`: the tank is the boundary, the agent may use any account or saved login in it and completes what you ask. `guided`: it asks before anything irreversible and never uses credentials you did not give it |
| `deskfish.model` | `claude-opus-5` | The model name exactly as the provider expects it (`claude-opus-5`, `grok-4`, `llama3.2-vision`, …) |
| `deskfish.baseUrl` | *(empty)* | Endpoint for OpenAI-compatible providers, the part before `/chat/completions`. Leave empty for Anthropic unless you use a gateway |
| `deskfish.anthropicWorkspaceId` | *(empty)* | Anthropic workspace ID (`wrkspc_…`). Needed only when your Anthropic key is identity-linked; see [Models and providers](models-and-providers#anthropic) |

The API key is not a setting; **Deskfish: Set LLM API Key** stores it in the keychain and in
`secrets.json` in Deskfish's data folder (readable only by your user account).

## Behavior

| Setting | Default | What it does |
| --- | --- | --- |
| `deskfish.maxSteps` | `0` | Cap on model turns per task. `0` = no cap: the agent works until it is done or you press Stop. A number stops the task there with a summary; "continue" resumes |
| `deskfish.maxCostUsd` | `0` | Cost budget per task in dollars: at list prices for Claude, Kimi or Grok used directly, or the cost OpenRouter reports. `0` = none. At 80% the agent is told to wrap up; once a turn reaches the budget it takes no more actions and summarizes; "continue" resumes. A brake, not a hard ceiling: the wrap-up can go a little over, and endpoints with no cost source cannot enforce it |
| `deskfish.unattendedMaxCostUsd` | `2` | Cost budget in dollars for a run nobody asked for and nobody is watching — a scheduled task. Such a run also behaves as `guided` unless the schedule says otherwise. `0` = no budget; a budget on the schedule itself wins. Same limits as `deskfish.maxCostUsd`: it can only act where the cost is known. See [Schedules](schedules#the-fence-on-a-run-nobody-is-watching) |
| `deskfish.temperature` | *(unset)* | Sampling temperature for OpenAI-compatible endpoints. Unset, none is sent and the model runs at its provider default, which reasoning models such as `kimi-k3` and GPT-5 insist on (they answer any other value with HTTP 400). Set a number, `0` for the most repeatable clicks, only for models that accept one. Not used by the Anthropic provider, whose adaptive thinking fixes the temperature |
| `deskfish.promptCaching` | `auto` | Cache breakpoints on OpenAI-compatible endpoints: `auto` adds them for openrouter.ai only, `on` for any gateway that passes them through (LiteLLM), `off` never. The Anthropic provider always caches. See [Models and providers](models-and-providers#a-note-on-openrouter) |
| `deskfish.reflectEvery` | `5` | After how many finished tasks the agent reflects (alone with its journal and notes: saves facts, may revise its self file). `0` = only when you run **Deskfish: Let Her Reflect**. See [Memory](memory#reflection) |
| `deskfish.userName` | *(empty)* | Your name, told to the agent at the start of every task so it knows the person in the chat is you and not a third party. Its page and journal will use the same name |
| `deskfish.ledgerEvery` | `40` | Every this many steps of a task the agent writes a ledger (goal, done, left, state, traps) and the conversation restarts from it, so long tasks stay cheap and on track. `0` = never. See [The ledger](how-the-bot-sees-and-acts#long-tasks-the-ledger) |
| `deskfish.ledgerTokens` | `100000` | Also write a ledger when the last request's context (input plus cache) passed this many tokens, whatever the step count, so a text-heavy task does not pay for a huge context on every step. `0` = only by step count |
| `deskfish.cacheTtl` | `1h` | Anthropic prompt cache lifetime. `1h`: the cached conversation survives the pauses between your messages, a standby and a slow command, at twice the input price on each step's few new tokens instead of 1.25×. `5m`: the cheaper write, for back-to-back requests; after five idle minutes the whole conversation is re-written at cache-write price |
| `deskfish.effort` | *(empty)* | Anthropic only: how hard the model thinks on each turn (`low`, `medium`, `high`, `xhigh`, `max`). Empty = the provider's default, `high`. Lower effort means fewer thinking tokens, faster turns and fewer, more consolidated actions; `medium` is worth measuring on your own tasks. Applies from the next new conversation |
| `deskfish.scheduleGraceMinutes` | `5` | A scheduled task still starts this many minutes after its due time when Deskfish was only just opened; later it is reported as missed and skipped. A task due while the agent was busy always runs once she is free. See [Schedules](schedules) |
| `deskfish.screenshotWidth` | `1280` | Screenshots are scaled to this width before going to the model; coordinates are mapped back automatically. Smaller is cheaper, larger is sharper |
| `deskfish.settleMs` | `800` | Milliseconds to wait after a batch of actions before the next screenshot, so pages can react |

## The tank

| Setting | Default | What it does |
| --- | --- | --- |
| `deskfish.desktop.autoStart` | `true` | Turn the tank on when the Deskfish view opens. Running a task turns it on regardless |
| `deskfish.desktop.openOnRun` | `true` | Open the Desktop tab whenever you send a task, so the live view is in front of you. The chat keeps keyboard focus |
| `deskfish.desktop.screen` | `1280x800x24` | The virtual screen: width × height × color depth. Applied the next time the tank starts |
| `deskfish.desktop.containerCli` | `auto` | Which container engine to use: `podman`, `docker`, or `auto` (Podman if installed and Docker is not, otherwise Docker) |
| `deskfish.desktop.daemonUrl` | `http://localhost:9990` | Where the tank's control API is. Change only for a tank on another machine |
| `deskfish.desktop.vncUrl` | `ws://localhost:9990/websockify` | Where the live view connects. Change only for a tank on another machine |
| `deskfish.desktop.token` | *(empty)* | Bearer token for the control API and the live view, if the tank was started with one. Empty means no authentication, which is fine when the port is bound to `127.0.0.1` |
| `deskfish.desktop.vncPassword` | *(empty)* | Password for the live view, if the tank was started with one |
| `deskfish.desktop.composeFile` | *(empty)* | For people who start the tank with a compose file instead of the power button. The power button does not use it |

The remote-tank settings are explained in [Advanced setups](advanced).

## Where Deskfish runs

Deskfish itself — the desktop, the agent, her memory, her chats and her schedules — lives in a
background process (the *gateway*) that VS Code starts and that keeps working when VS Code is
closed. These three settings say where it runs and whether it comes back by itself. Reload the
window after changing the first two.

| Setting | Default | What it does |
| --- | --- | --- |
| `deskfish.gateway.placement` | `local` | `local`: Deskfish runs on this computer and the extension starts it — nothing to set up. `remote`: it runs on another machine; set `deskfish.gateway.url` and enter its token with **Deskfish: Set Gateway Token** |
| `deskfish.gateway.url` | *(empty)* | Address of the remote one, e.g. `http://127.0.0.1:9980` through an SSH tunnel, or a Tailscale address. Empty with `local`: this computer, port 9980 |
| `deskfish.gateway.keepRunning` | `false` | Start Deskfish when you log in, so her schedules run and an interrupted task can be picked up after a restart. Turn it on with **Deskfish: Keep Running When VS Code Is Closed**, which writes the entry and shows it to you in a terminal; the same command removes it. Without it, Deskfish still keeps running after you close VS Code — until the computer restarts |
