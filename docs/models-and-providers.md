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
tool calls. It also uses adaptive thinking (how much, per turn, is `deskfish.effort`), and it
caches the conversation for an hour so repeated steps and follow-up tasks cost less. If Claude refuses a task, the
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
| xAI | `https://api.x.ai/v1` | `grok-4.6` | xAI key — or your SuperGrok plan, see [Sign in with Grok](#sign-in-with-grok) |
| Moonshot AI (Kimi) | `https://api.moonshot.ai/v1` | `kimi-k3` | Moonshot key. Moonshot AI is in Beijing: your key, your payment and what is on screen go to their servers. Via OpenRouter (`moonshotai/kimi-k3`) your key and payment stay with OpenRouter, but what is on screen still goes to whichever host OpenRouter routes the model to |
| OpenRouter | `https://openrouter.ai/api/v1` | any vision + tools model | OpenRouter key |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.2-vision` | none |
| vLLM (local or hosted) | your server's `/v1` | whatever it serves | as configured |
| LiteLLM proxy | `http://localhost:4000/v1` | names from its config | its master key, if set |

No sampling temperature is sent unless you set `deskfish.temperature`: reasoning models such
as `kimi-k3` and GPT-5 accept only their own default and reject any other value.

Models here are shown a generic `computer` tool whose actions mirror the vocabulary Claude
uses, with `zoom` as one of its actions, so instructions and habits transfer. The rest of the
tool set is the same as on the Anthropic path: `run_command`, `wait_for`, `find`, `read_page`,
`click_element`, `ask_user`, `ask_fill`,
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

## Sign in with Grok

If you already pay for **SuperGrok**, Deskfish can work on the plan you have instead of billing an
xAI API key on top of it. In the model picker choose **xAI (Grok) — sign in with your SuperGrok**,
press **Sign in with Grok**, and a code appears. Open the page it shows, type the code, approve it,
and the sign-in is done; the next task draws the plan's pool.

> [!NOTE]
> **The consent screen says "Grok Build".** That is xAI's own shared sign-in for outside programs —
> the same one Hermes Agent, Kilo Code and OpenClaw use — not a separate app you have to install.
> Deskfish is not registered with xAI under its own name, because xAI publishes no way to do that.

**Which plan.** SuperGrok (from grok.com), including SuperGrok Heavy. X Premium+ has been reported
to work for some people and not others.

**xAI decides which accounts get sign-in tokens.** It keeps its own list, and an account with a live
subscription can still be refused. If yours is, Deskfish says so in one sentence — *"xAI decides
which accounts get sign-in tokens; this one was refused"* — and an xAI API key remains the way in.

**When the pool runs out**, xAI stops answering until the plan's window resets. Deskfish does not
quietly fall back to an API key and charge you for the rest of the task: it knocks on the glass, the
way it does for a login, and waits for you to say what to do. Switch to the **xAI (Grok) — API
key** preset in Settings and hand the desktop back, and the task goes on from where it stopped,
now on the key; or hand back once the pool has reset.

**What a task costs on it.** Nothing per token — that is the point — so the counter above the status
row shows the tokens and the word *subscription* instead of a figure, and the journal writes
`subscription` where it would write a price. For the same reason `deskfish.maxCostUsd` has nothing
to act on while you are signed in; the pool running out is the limit. (xAI does return a cost
number of its own on every request, but it does not agree with xAI's published per-token prices, so
Deskfish does not show it as money.)

**Signing out** (the same button, once you are signed in) tells xAI to forget the grant and deletes
the tokens. An xAI API key you had saved before is untouched and is there again the moment you pick
the API-key preset. You can also revoke it from your xAI account page at any time: it is listed
there as "Grok Build", and revoking it signs out every program that uses xAI's shared sign-in.

**Only xAI.** Anthropic's terms forbid using a Claude Pro or Max subscription from a third-party
tool — that is a first-party privilege of Claude Code, and Deskfish will not offer it. OpenAI
documents its ChatGPT sign-in for Codex alone. So the Anthropic and OpenRouter paths here are, and
stay, API keys.

## The demo model

`deskfish.provider = mock`. A scripted model that needs no key and no internet: it opens
the browser, goes to the site named in your task (or example.com), knocks on the glass once
so you can see the hand-over, looks around with a zoom and a scroll, and declares itself
done. Use it to check that the tank, the Desktop tab and the chat all work before adding a
real model.

## Keys

The API key is stored in your operating system's keychain through VS Code's secret
storage and in `secrets.json` in Deskfish's data folder (readable only by your user account),
never in a settings file, and it is sent only to the endpoint you configured.
The tokens from [Sign in with Grok](#sign-in-with-grok) live in that same `secrets.json` and nowhere
else — not in the keychain, not in a settings file — and Deskfish renews them in the background.
Enter it with **Deskfish: Set LLM API Key** or the **Change** button next to *API key*;
leave the box empty to clear it. Keys are kept one per provider (Anthropic, and one per
endpoint host such as openrouter.ai or api.x.ai), so switching providers does not lose the
other key; the model picker asks for a key only when the chosen provider has none. A signed-in
endpoint has a slot of its own, so an xAI API key and a Grok sign-in can both be stored and neither
disturbs the other.

## What a task costs

Each step sends the model the task, the conversation so far, the newest screenshot (a JPEG
of about 1280 × 800 pixels) and the results of its last actions. Hosted providers charge for
all of it; the total depends on the model and on the task. Six things keep the bill in check:

- **the ledger**: every forty steps (`deskfish.ledgerEvery`, 0 to turn it off), or sooner when
  the conversation has grown past a hundred thousand tokens (`deskfish.ledgerTokens`), the agent
  writes a summary and the conversation restarts from it, so the cost of a step stops growing
  with the length of the task; see [The ledger](how-the-bot-sees-and-acts#long-tasks-the-ledger);
- **prompt caching**: on Anthropic direct, always; on OpenRouter, with `deskfish.promptCaching`
  at `auto` (the default); on another gateway that passes cache markers through, set it to
  `on`. Everything before the newest message is then read from the cache at a fraction of the
  price. On Anthropic the cache lives an hour by default (`deskfish.cacheTtl`), so a pause
  between your messages, a standby or a slow command does not throw the conversation away, and
  a follow-up task in the same chat keeps the cached conversation instead of rebuilding it.
  Whether a given model honours the markers is up to the provider serving it;
- **pruning**: after each prune only the three most recent screenshots stay in the
  conversation, so a few more can pile up between prunes; long text results (a page's text, a
  command's output, a documentation page) likewise shrink to their first line once more than
  eight are in the conversation, keeping the four newest whole;
- **effort**: on Anthropic, `deskfish.effort` sets how hard the model thinks on each turn.
  Thinking is billed as output, the dearest kind of token, and is most of a step's waiting
  time; `medium` is worth measuring on your own tasks, and lower effort also tends to batch
  more actions per turn;
- **standby**: while the agent waits with `wait_for`, Deskfish watches the screen locally
  instead of calling the model;
- **no step cap by default**: `deskfish.maxSteps` is 0, so the agent works until it finishes,
  hands over or you press Stop; set a number if you want a hard stop.

On the Anthropic path Deskfish also asks for server-side compaction, so a very long
conversation is summarized by the API rather than dying at the context window.

The counter above the status row shows the total input, the output, the share that came from
the cache and, where Deskfish can tell, a cost. The estimate exists for the models in
Deskfish's price table, at the provider's list prices, and only where those prices apply:
Claude used directly (Opus 5 at $5 per million input tokens, $25 per million output and $0.50
per million read from cache; Sonnet 5 at $2, $10 and $0.20) and Kimi used directly from
Moonshot AI (K3 at $3, $15 and $0.30; K2.6 at $0.95, $4 and $0.16), and Grok used directly
from xAI at `api.x.ai` (grok-4.6 at $2, $6 and $0.50; grok-4.5 at $2, $6 and $0.30; grok-4.3 and
the grok-4.20 models at $1.25, $2.50 and $0.20; grok-build-0.1 at $1, $2 and $0.20). Moonshot's
own API caches prefixes automatically and reports the cached share, so the estimate counts it.
xAI doubles every rate once a single request reaches 200,000 tokens; the ledger restarts the
conversation at 100,000 (`deskfish.ledgerTokens`), so a task stays at the rates above unless you
raise that setting a long way. A Grok model not listed there shows tokens only. The same model
name served from a local endpoint is not priced, since it costs nothing but time. Note that Kimi
K3's list prices are higher than Sonnet 5's on every line. A long task can process a million
tokens or more in total; with caching, most of that is the cheap kind.

Through OpenRouter the counter shows the actual charge instead of an estimate: OpenRouter
reports the cost of every request, and Deskfish adds them up. Other OpenAI-compatible
endpoints report tokens only, so no figure is shown.

`deskfish.maxCostUsd`, 0 by default, is a budget for one task, and it works wherever one of
those cost sources exists, a list price or a reported charge. At 80% the agent is told to wrap up; once a turn reaches the
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
