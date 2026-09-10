---
title: Running tasks
description: The chat sidebar, how to phrase a task, what you see while the agent works, follow-ups, and stopping.
section: Using Deskfish
order: 2
---

Everything you say to the agent goes through the chat sidebar, and everything it says comes
back there. This page is a tour of that sidebar and of the habits that make tasks go well.

## The sidebar, top to bottom

**The status rows.** Three lines at the top show the state of things, each with buttons that
say what they do:

| Chip | Shows | Click to |
| --- | --- | --- |
| Desktop | Off, On, Turning on…, or Error, with a coloured dot | **Open** the Desktop tab; **Turn on** / **Turn off**; after an error, **Show log** and **Try again** |
| Model | The model and where it runs, e.g. `claude-opus-5 · Anthropic` | **Change** opens the provider and model picker |
| API key | *Stored in your keychain*, *Not set*, *Not needed for a local endpoint*, or *Not needed* (demo) | **Set API key** or **Change** |

**The conversation.** Your messages, the agent's replies, and a few kinds of cards: the
hand-over card when the agent needs you, and a file card whenever a new file lands in its
Downloads folder. Hover any message and a small copy icon appears in its corner; click it to
put the whole message on your clipboard. Your own messages also get a **send again** icon
next to it: one click sends the same text once more, handy when a run failed for a reason
that had nothing to do with the task (no API key, the desktop was off) and you do not want
to retype it. Attached files are not re-sent. The conversation stays until you start a new chat,
so you can scroll back through the day's work.

**The counter and the status row.** Two lines under the conversation. The first is a running
count for the conversation: tokens in, tokens out, how much came from the prompt cache, and
a cost where Deskfish can tell (Claude models used directly, or the charge OpenRouter reports).
"In" counts everything the model processed; because each step re-sends the conversation so
far, that number grows quickly on long tasks, and the cached share is what keeps it cheap.
Below it, the status row says *Ready*, *Working*, *Paused*, *Done*, *Stopped* or *Error*,
often with a short message.

**The composer.** A text box with a paperclip for attaching files, a **Run** button
(**Send** while a task is running), and, while the agent works, **Pause**, **Resume** and
**Stop** buttons. Enter sends; Shift+Enter makes a new line.

## Phrasing a task

The agent is a capable reader of instructions, so write the way you would write to a
colleague:

- **Say where to go.** *"On booking.com"* or *"at https://…"* saves a search. The agent
  types URLs straight into the address bar.
- **Say what "done" looks like.** *"…and tell me the three cheapest with free
  cancellation"* gives it a stopping point and a shape for the answer.
- **Give the constraints up front.** Dates, budgets, must-haves. It cannot ask a website
  what you meant.
- **Multi-step is fine.** *"Open a terminal, run `df -h`, and tell me which disk is
  fullest."* The agent batches obvious sequences by itself.
- **Do not put secrets in the task.** Anything you type goes to the model provider. When a
  login is needed, let the agent knock on the glass and type it yourself. See
  [Knocking on the glass](knocking-on-the-glass).

## What happens after you press Run

1. The Desktop tab opens beside the chat (if it is not open already), so you can watch. Your
   cursor stays in the chat box. Turn this off with `deskfish.desktop.openOnRun`.
2. If the tank is off, Deskfish turns it on first; the Desktop tab shows the progress.
3. The agent takes a screenshot, thinks, and decides on one or more actions.
4. The actions run on the tank, the screen settles for a moment, and a fresh screenshot is
   taken. That is one **step**.
5. Repeat until the agent decides the task is finished, at which point it writes a summary
   and stops.

In the chat, what the agent *says* appears as ordinary messages, with basic markdown
(bold, inline code, headings). What it *does* is folded into a small chip that reads
**N actions**; click it to expand the list. The chip turns red and says how many failed if
any action did not work, for example an unknown key name. There are no screenshots in the
chat on purpose: the Desktop tab is the screen.

The complete, unfolded log of every step is always in the **Deskfish** output channel
(**Deskfish: Show Log**).

## Talking to it while it works

You can type while a task is running. The button says **Send**, and your message reaches
the agent together with its next screenshot, so it can change course, take a hint, or
answer a question mid-task. The one exception is a reflection: a message sent while the agent
reflects waits, and starts as a task when the reflection ends.

## Follow-ups keep their context

When a task ends with *Done*, the next thing you type continues the **same conversation**.
The agent remembers what it did, what it saw, and what it told you, so *"how much was the
second one?"* or *"now book it"* work without repeating yourself.

The conversation starts fresh when:

- you click **+** (New chat) in the title bar of the sidebar, or
- you press **Stop**, or the task ends in an error, or
- you change the provider, the model, the base URL or the API key, or
- you reload VS Code (the model's live context is gone; the saved transcript can be reopened,
  see [Past chats](memory#past-chats)).

## Starting fresh

The **+** button in the title bar of the Deskfish sidebar (or **Deskfish: New Chat** in the
command palette) clears the conversation and the agent's memory of it. If a task is running,
it is stopped first. The desktop is not touched: Firefox, its tabs, its logins and the files
in the tank stay exactly as they were, so the new conversation starts by looking at whatever
is on screen. The chat itself is not lost: every chat is saved as a transcript, and the clock
icon next to **+** lists them, to reopen or to continue in a new chat. See
[Memory](memory#past-chats).

## What the agent remembers

Within one conversation the agent keeps the text of what happened: your messages, its
replies, and the result of every action. What it does not keep is every picture. Screenshots
are pruned in batches, so after each prune only the three most recent stay in its context and
older ones are replaced by a short note. On a long task the ledger (below) also replaces the
older text with a summary every forty steps. That is what keeps long tasks affordable, and it
is why the agent sometimes takes a fresh screenshot rather than reasoning from an old one.
The transcript on disk keeps every word.

Across chats, the agent keeps more than a list. Its [Memory](memory) has facts about you and
the sites it uses, a journal with one line per finished task, how-to playbooks it writes after
learning a site, the transcripts of past chats, and a page about who it is. During a task it
can search the journal and past chats with its recall tool, and read a playbook by its title,
so "what did we do about the placements last week" is one call, not a re-investigation. Every
fact, note and playbook it writes shows in the chat as a small *Memory updated* chip with a
count; open it to read what was saved.

When the agent is waiting for something to finish, or spacing actions out, the chat shows a
line of its own, *Standing by, what for, and a countdown*, and the status row says the same.
It is not stuck: Deskfish is watching the screen for it without spending steps, and wakes it
when the screen changes or the time is up. When the wait ends, the line says what happened.
If waiting is part of the plan for a task, the agent says so in a sentence before it starts.
**Stop** ends a wait at once. See [Standing by](how-the-bot-sees-and-acts#standing-by).

On a long task, every forty steps the agent writes a short ledger of what is done and what
is left, and the conversation restarts from it. It shows in the chat as a folded card. This is
what keeps a two-hour task from costing more per step as it goes; see
[The ledger](how-the-bot-sees-and-acts#long-tasks-the-ledger).

A task can also start itself at a set time or on a repeat; see [Schedules](schedules).

After every few finished tasks the status row says **Reflecting…** for a moment. The agent is
alone with its notes: it saves what is worth keeping, and may make a small change to the page
about itself. In the chat that whole moment is one folded card whose line says what changed;
open it if you are curious. It takes a few model turns, billed by your provider like a short
task, and never runs while a task is in progress; `deskfish.reflectEvery` sets how often, 0
for only when you ask.

## Pause, Resume, Stop

- **Pause** hands you the desktop. The agent finishes the action it is in the middle of
  (the status says *Pausing — finishing the current action…*), any held key or mouse button
  is released, and then the status reads *Paused — you have the desktop* and the Desktop tab
  accepts your mouse and keyboard. The same happens when you click **Take over** in the
  Desktop tab.
- **Resume** gives control back. The agent is told that you had the desktop for a while and
  re-reads the screen before continuing.
- **Stop** ends the task now. The agent lets go of any key or mouse button it was holding.

Stop takes effect at once: a model call in flight is cancelled, a wait is cut short, and the
status row says *Stopping…* until the loop has let go of the mouse and keyboard, usually
well under a second.

## Limits worth knowing

- There is **no step limit** by default. Like a coding agent, the agent works until the task
  is done or you press **Stop**; the status row counts steps (*Working · step 42*), the
  counter above it shows the running cost, and that is your control. On Anthropic, the
  conversation is compacted server-side when it grows very long, so a task can run for
  hundreds of steps. If you want a hard cap, set `deskfish.maxSteps`: the agent is warned as
  it nears it, writes a summary at the cap, and **continue** resumes from there.
- **It cannot wander for long.** Deskfish compares each screenshot with the last one. If the
  agent repeats the same actions three times and nothing on screen changes, it is told to stop
  repeating and change approach. If that happens again, it knocks on the glass with *"I seem to
  be stuck"* so you decide what to do. Scrolling a long page or working through a form is not a
  stall: the screen changes and the actions differ.
- **A cost budget, if you want one.** `deskfish.maxCostUsd` works where Deskfish can see a
  cost: Claude models used directly (known list prices) or OpenRouter, which reports the
  charge. At 80% the agent is told to wrap up; once a turn reaches the budget it takes no
  more actions, writes a summary and stops, and **continue** resumes. It is a brake, not a
  hard ceiling: the turn that crosses the line and the wrap-up itself can go a little over.
  Other endpoints report tokens only, so no budget can be enforced there.
- Screenshots are pruned in batches, keeping the three most recent; older ones are replaced
  by a note. The ledger replaces the older text every forty steps; the saved transcript keeps
  everything.
- One task at a time, on one screen. There is no audio and no webcam in the tank.

## Some tasks that work well

```text
Find the three highest-rated Italian restaurants near Plaza Mayor in Madrid that are
open on Sunday evening, and give me their names, prices and links.
```

```text
Download the PDF manual from the project's documentation page, read the installation
chapter, and write me a one-page summary of it as a text file in Downloads.
```

```text
Open a terminal and show me how much free space the disk has.
```

```text
On my account at example-shop.com (you will need me to log in), find my last order and
tell me its tracking number.
```
