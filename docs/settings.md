---
title: Settings
description: Every Deskfish setting, its default, and what it changes.
section: Reference
order: 1
---

Open **Settings** and search for *Deskfish*. All settings live under the `deskfish` prefix.
(The **Change** button next to *Model* in the sidebar opens the model picker, which writes the
three model settings for you; it does not open this list.)

> [!TIP]
> Put the model settings (`provider`, `model`, `baseUrl`) and `desktop.containerCli` in your
> **User** settings. Deskfish is used from any folder, and a workspace's settings only apply
> to that workspace.

## Model

| Setting | Default | What it does |
| --- | --- | --- |
| `deskfish.provider` | `anthropic` | Which adapter drives the desktop: `anthropic` (Claude direct, the recommended path), `openai-compatible`, or `mock` |
| `deskfish.autonomy` | `free` | `free`: the tank is the boundary, the agent may use any account or saved login in it and completes what you ask. `guided`: it asks before anything irreversible and never uses credentials you did not give it |
| `deskfish.model` | `claude-opus-5` | The model name exactly as the provider expects it (`claude-opus-5`, `grok-4`, `llama3.2-vision`, …) |
| `deskfish.baseUrl` | *(empty)* | Endpoint for OpenAI-compatible providers, the part before `/chat/completions`. Leave empty for Anthropic unless you use a gateway |
| `deskfish.anthropicWorkspaceId` | *(empty)* | Anthropic workspace ID (`wrkspc_…`). Needed only when your Anthropic key is identity-linked; see [Models and providers](models-and-providers#anthropic) |

The API key is not a setting; it is stored in the keychain through **Deskfish: Set LLM API
Key**.

## Behavior

| Setting | Default | What it does |
| --- | --- | --- |
| `deskfish.maxSteps` | `0` | Cap on model turns per task. `0` = no cap: the agent works until it is done or you press Stop. A number stops the task there with a summary; "continue" resumes |
| `deskfish.maxCostUsd` | `0` | Cost budget per task in dollars: at list prices for Claude used directly, or the cost OpenRouter reports. `0` = none. At 80% the agent is told to wrap up; once a turn reaches the budget it takes no more actions and summarizes; "continue" resumes. A brake, not a hard ceiling: the wrap-up can go a little over, and endpoints with no cost source cannot enforce it |
| `deskfish.temperature` | *(unset)* | Sampling temperature for OpenAI-compatible endpoints. Unset, none is sent and the model runs at its provider default, which reasoning models such as `kimi-k3` and GPT-5 insist on (they answer any other value with HTTP 400). Set a number, `0` for the most repeatable clicks, only for models that accept one. Not used by the Anthropic provider, whose adaptive thinking fixes the temperature |
| `deskfish.promptCaching` | `auto` | Cache breakpoints on OpenAI-compatible endpoints: `auto` adds them for openrouter.ai only, `on` for any gateway that passes them through (LiteLLM), `off` never. The Anthropic provider always caches. See [Models and providers](models-and-providers#a-note-on-openrouter) |
| `deskfish.reflectEvery` | `5` | After how many finished tasks the agent reflects (alone with its journal and notes: saves facts, may revise its self file). `0` = only when you run **Deskfish: Let Her Reflect**. See [Memory](memory#reflection) |
| `deskfish.userName` | *(empty)* | Your name, told to the agent at the start of every task so it knows the person in the chat is you and not a third party. Its page and journal will use the same name |
| `deskfish.ledgerEvery` | `40` | Every this many steps of a task the agent writes a ledger (goal, done, left, state, traps) and the conversation restarts from it, so long tasks stay cheap and on track. `0` = never. See [The ledger](how-the-bot-sees-and-acts#long-tasks-the-ledger) |
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
