---
title: Models and providers
description: Which AI models drive Deskfish, how to connect each kind, and what to expect from them.
section: Under the hood
order: 2
---

Deskfish talks to the model through a thin adapter, and there is one adapter per kind of
API. Choose with `deskfish.provider`; Anthropic direct is the default.

Whichever you choose, the agent is told which model it runs on and where, in one line of
its instructions that follows the setting; ask it and it answers from that line, not from a
guess.

## Anthropic

`deskfish.provider = anthropic` and `deskfish.model = claude-opus-5` (both the defaults),
`deskfish.baseUrl` empty. Set the key with **Deskfish: Set LLM API Key**.

This adapter uses Claude's **native computer-use tool**, the one the models were trained
on, which is why it is the recommended path: clicks land more reliably than through generic
tool calls. It also uses adaptive thinking, and it caches the conversation so repeated steps
cost less. If Claude refuses a task, the
refusal and its explanation appear in the chat and the task ends.

> [!NOTE]
> **Identity-linked keys.** Newer Anthropic keys can be linked to your user identity instead of
> a workspace. The API then requires every request to name the workspace it acts in, and
> Deskfish shows *"Your Anthropic API key is identity-linked…"*. Copy the workspace ID from the
> Anthropic Console (**Settings → Workspaces**, it looks like `wrkspc_…`) into
> `deskfish.anthropicWorkspaceId`. A key created for a specific workspace does not need this.

Any Claude model that supports computer use should work; the picker suggests `claude-opus-5`
as the strongest and `claude-sonnet-5` as a good cheaper choice for simple tasks, and your
provider's model list is the authority on what is available. If you use a gateway in front of
the Anthropic API, put its URL in `deskfish.baseUrl`.

## OpenAI-compatible endpoints

`deskfish.provider = openai-compatible`, `deskfish.baseUrl` set to the endpoint, and a
model name that supports **vision and tool calling**. This one adapter covers a lot of
ground:

| Service | Base URL | Example model | Key |
| --- | --- | --- | --- |
| xAI | `https://api.x.ai/v1` | `grok-4` | xAI key |
| Moonshot AI (Kimi) | `https://api.moonshot.ai/v1` | `kimi-k3` | Moonshot key. Moonshot AI is in Beijing: your key, your payment and what is on screen go to their servers. Via OpenRouter (`moonshotai/kimi-k3`) your key and payment stay with OpenRouter, but what is on screen still goes to whichever host OpenRouter routes the model to |
| OpenRouter | `https://openrouter.ai/api/v1` | any vision + tools model | OpenRouter key |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.2-vision` | none |
| vLLM (local or hosted) | your server's `/v1` | whatever it serves | as configured |
| LiteLLM proxy | `http://localhost:4000/v1` | names from its config | its master key, if set |

No sampling temperature is sent unless you set `deskfish.temperature`: reasoning models such
as `kimi-k3` and GPT-5 accept only their own default and reject any other value.

Models here are shown a generic `computer` tool whose actions mirror the vocabulary Claude
uses, with `zoom` as one of its actions, so instructions and habits transfer. The rest of the
tool set is the same as on the Anthropic path: `wait_for`, `find`, `read_page`, `ask_user`,
`read_docs`, `remember` and `forget`, `note_to_self` and `recall`, `revise_self`,
`restore_self`, `self_history` and `archive_story`, and `save_playbook` and `read_playbook`.
Accuracy depends entirely on the model. Large hosted models do well; small local ones can find
the right button but misclick often, and the zoom action exists partly for them.

When the endpoint is on `localhost` no key is required and the key chip says *Not needed for
a local endpoint*.

### A note on OpenRouter

OpenRouter is the easiest way to try many models with one key, and it works with this adapter
(`https://openrouter.ai/api/v1`, a model name such as `anthropic/claude-opus-5`,
`google/gemini-2.5-pro` or `moonshotai/kimi-k3`). It is also the way to use models from
companies you would rather not hold an account with: your key and your payment stay with
OpenRouter, and OpenRouter lets you choose which hosts may serve a model. Three things to know before choosing it over the direct path:

- **Clicks are less precise.** Through OpenRouter, Claude is driven with generic tool calls and
  screenshots, not its native computer-use tool. It works, but the direct Anthropic path is
  the one that hits small targets reliably; the zoom tool helps.
- **Caching works for Anthropic and Gemini models.** Deskfish marks the conversation with cache
  breakpoints when the endpoint is OpenRouter, so the prefix is cached the same way as on the
  direct path; the counter above the status row shows the cached share. Other models cache or
  not on their own (OpenAI and xAI do it automatically). OpenRouter's fee still applies.
- **Only vision-and-tools models can drive a desktop.** Check both boxes on OpenRouter's model
  page before picking one.

Anthropic direct is the recommended path; OpenRouter is for every other model. It has not yet
been tested as thoroughly as the direct path. For other gateways that pass Anthropic's cache
markers through, such as a LiteLLM proxy, set `deskfish.promptCaching` to `on`; for a strict
endpoint that rejects unknown fields, `off`.

> [!NOTE]
> The base URL is the part *before* `/chat/completions`. For most services that ends in
> `/v1`.

## The demo model

`deskfish.provider = mock`. A scripted model that needs no key and no internet: it opens
the browser, goes to the site named in your task (or example.com), knocks on the glass once
so you can see the hand-over, looks around with a zoom and a scroll, and declares itself
done. Use it to check that the tank, the Desktop tab and the chat all work before adding a
real model.

## Keys

The API key is stored in your operating system's keychain through VS Code's secret
storage, never in a settings file, and it is sent only to the endpoint you configured.
Enter it with **Deskfish: Set LLM API Key** or the **Change** button next to *API key*;
leave the box empty to clear it. Keys are kept one per provider (Anthropic, and one per
endpoint host such as openrouter.ai or api.x.ai), so switching providers does not lose the
other key; the model picker asks for a key only when the chosen provider has none.

## What a task costs

Each step sends the model the task, the conversation so far, the newest screenshot (a JPEG
of about 1280 × 800 pixels) and the results of its last actions. Hosted providers charge for
all of it; the total depends on the model and on the task. Five things keep the bill in check:

- **the ledger**: every forty steps (`deskfish.ledgerEvery`, 0 to turn it off) the agent
  writes a summary and the conversation restarts from it, so the cost of a step stops growing
  with the length of the task; see [The ledger](how-the-bot-sees-and-acts#long-tasks-the-ledger);
- **prompt caching**: on Anthropic direct, always; on OpenRouter, with `deskfish.promptCaching`
  at `auto` (the default); on another gateway that passes cache markers through, set it to
  `on`. Everything before the newest message is then read from the cache at a fraction of the
  price. Whether a given model honours the markers is up to the provider serving it;
- **images pruned in batches**: after each prune only the three most recent screenshots stay
  in the conversation, so a few more can pile up between prunes;
- **standby**: while the agent waits with `wait_for`, Deskfish watches the screen locally
  instead of calling the model;
- **no step cap by default**: `deskfish.maxSteps` is 0, so the agent works until it finishes,
  hands over or you press Stop; set a number if you want a hard stop.

On the Anthropic path Deskfish also asks for server-side compaction, so a very long
conversation is summarized by the API rather than dying at the context window.

The counter above the status row shows the total input, the output, the share that came from
the cache and, where Deskfish can tell, a cost. The estimate exists only for `claude-*` models
with an entry in Deskfish's price table, at list prices: Opus 5 at $5 per million input tokens,
$25 per million output and $0.50 per million read from cache; Sonnet 5 at $2, $10 and $0.20.
A long task can process a million tokens or more in total; with caching, most of that is the
cheap kind. Local models cost nothing but time.

Through OpenRouter the counter shows the actual charge instead of an estimate: OpenRouter
reports the cost of every request, and Deskfish adds them up. Other OpenAI-compatible
endpoints report tokens only, so no figure is shown.

`deskfish.maxCostUsd`, 0 by default, is a budget for one task, and it works wherever one of
those two cost sources exists. At 80% the agent is told to wrap up; once a turn reaches the
budget it takes no more actions and writes a summary. It is a brake rather than a hard
ceiling: the turn that crosses the line and the wrap-up itself can go a little over, and on
an endpoint with no cost source it cannot act at all. A reflection is billed the same way as
a task.

## Changing models

Click **Change** next to *Model* in the sidebar, or run **Deskfish: Choose Model…**: pick the
provider, then the model, and enter the key if that provider has none yet. The settings behind
it can also be edited by hand. The next task uses the new model and starts a fresh
conversation, since the live conversation belongs to the previous adapter. Everything in
[Memory](memory) stays: the facts, the self page, the journal, the playbooks and the past
chats are all there for the new model. Changing the model while a task is running does not
affect the running task.

## Running several providers behind one URL

The `docker/` folder in the source tree contains a compose file that starts the tank next to
a **LiteLLM** proxy, which exposes xAI, Anthropic, OpenAI and a local Ollama under one
OpenAI-compatible URL with model names of your choosing. It is optional, and aimed at people
who like to switch models by name. See [Advanced setups](advanced).
