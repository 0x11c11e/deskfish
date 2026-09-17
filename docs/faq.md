---
title: FAQ
description: Short answers to the questions people ask first.
section: Help
order: 2
---

## Does the agent see my files?

No. Nothing on your computer is visible inside the tank. Files cross only when you attach
one or click **Save**. See [Files in and out](files).

## Does turning the tank off log the agent out of websites?

No. The container is recreated each time, but the agent's home folder, including Firefox's
cookies and logins, is kept on a storage volume. Logins survive restarts, reboots and
updates. Only removing the `deskfish-home` volume erases them. See [The tank](the-tank).

## Should I give the agent my passwords?

Give it accounts of its own instead; that is the whole idea of the tank. If you must use one
of yours, type it yourself in the Desktop tab when the agent knocks, rather than in the chat.
Anything Firefox in the tank remembers, the agent may use later. See
[Security and privacy](security-and-privacy).

## Can it solve CAPTCHAs?

In the default free mode nothing forbids it, and it knocks on the glass for any CAPTCHA it
cannot get past; you solve it and click **Resume**. In guided mode (`deskfish.autonomy`) it is
told never to attempt one.

## Does it read web pages, or only look at them?

Both. It sees the screen as a screenshot, and on a web page in Firefox it can also ask the
page itself, through a small extension in the tank, where a button or field is and what a
page says. That is why it clicks the right thing more often in the browser than in the
terminal or in a dialog, where only the picture is available. See
[How the bot sees and acts](how-the-bot-sees-and-acts).

## Can it wait for something, or do things on a timer?

Waiting, yes. Give it a task like "send this to each address on the list, five minutes
apart" or "publish the ad set and check the stats when it has finished processing", and it
uses its `wait_for` tool: Deskfish watches the screen for it without spending steps and wakes
it when something changes or the time is up, for up to two hours at a stretch. Tasks on a
timer, such as every Monday at seven, are [schedules](schedules): they start themselves while
Deskfish runs (in the background, with or without VS Code open), wait for the agent if she is
busy, and are reported as missed rather than run late if Deskfish was not running at the time.

## Will it buy things, send messages, or delete anything?

If you ask it to, yes, all the way through, using the accounts and saved payment methods in
its tank. It hands over only for things it cannot do itself, such as a code on your phone or
a card that is not saved. Some models add caution of their own: Claude usually stops at the
final Pay click and asks you to press it. If you want Deskfish itself to make the agent ask
before anything irreversible, set `deskfish.autonomy` to `guided`.

## Why did a long task cost so much, and what can I do?

Every step re-sends the conversation so far, so the last steps of a long task cost more than
the first ones. Three things bring it down: the ledger, on by default, restarts the
conversation from the agent's own notes every forty steps or when it grows too large; prompt
caching, where the provider supports it, makes the re-sent part cheap, and on Anthropic the
cache now lasts an hour, so a pause between your messages no longer re-bills the whole
conversation; and standby waits without model calls. On Anthropic, `deskfish.effort` at
`medium` cuts the thinking tokens on routine work. A cheaper
model for routine work, chosen with the **Change** button, helps too. `deskfish.maxCostUsd`
sets a budget for a task where Deskfish can see the cost (Claude, Kimi or Grok used directly, or
OpenRouter);
the wrap-up turn can go a little over. See
[What a task costs](models-and-providers#what-a-task-costs).

## Which model should I use?

Claude through the Anthropic provider is the recommended path: it drives the desktop with the
computer-use tool it was trained on, so clicks land more reliably. Any OpenAI-compatible model
with vision and tool calling can drive the desktop; bigger tends to do better. Local models
through Ollama are free and slow, and misclick more. Pick with the **Change** button. See
[Models and providers](models-and-providers).

## Does the agent know which model it runs on?

Yes. Its instructions carry one line naming the current model and where it runs, the same
pair the **Model** row of the sidebar shows, and the line is refreshed whenever you change
them. That line is the agent's authority on the question: not a memory, not the default named
in this documentation, and not the model's own idea of what it is. Whichever model is
underneath, it stays Deskfish.

## Can I try it without an API key?

Yes. Set the provider to `mock` for a scripted demo that exercises everything, including
the hand-over.

## Does it work on Windows and macOS?

Yes, as long as Podman (or Docker) runs Linux containers there: Podman Desktop or
`podman machine` on macOS, WSL 2 on Windows. The tank itself is always Linux.

## Why is the first start so slow?

Deskfish builds the tank's image on your machine from its own recipe rather than
downloading a prebuilt one, which takes a few minutes and about a gigabyte of disk. Every
later start takes seconds, except after an update that changes what is inside the tank, when
the image is rebuilt once (mostly from cache, so faster than the first time).

## Can I watch and use the tank at the same time as the agent?

You can always watch. To use it, click **Take over**; the agent pauses until you hand back.
See [The Desktop tab](watching-and-taking-over).

## Does it remember me between sessions?

Yes. It keeps facts about you (preferences, things you told it, which accounts it is logged
into, site quirks) in a text file you can open, edit and empty; a journal of what it did; the
how-to playbooks it writes; every chat as a transcript; and a page about who it is that only
it can change. It is told to keep passwords out of all of it; Firefox in the tank may still
save logins of its own. These are readable local files, so review an export before sharing
it. See [Memory](memory).

## How do I start a new conversation?

Click **+** in the title bar of the Deskfish sidebar (or run **Deskfish: New Chat**). The
chat and the agent's memory of it are cleared; the desktop is left as it is.

## Does the conversation survive a VS Code reload?

Yes. Deskfish runs in a background process of its own, which VS Code starts and which keeps
running when VS Code is closed or reloaded: a task carries on, and the reopened sidebar shows the
chat as it stands. The model's live context is lost only when that process restarts (the
computer restarts, or Deskfish updates), and even then nothing is lost: every chat is saved as a
transcript. After such a restart, the clock icon in the sidebar's title bar (or **Deskfish: Past Chats…**) opens
the history; click a chat to read it in place, and **Continue this chat** to pick it up. The agent then gets up to the
latest 16,000 characters of that transcript as context, with no images: a fresh conversation
with the old one as notes, not the old one resumed. Within a window, every new task continues
the previous conversation.

## Does she keep running when I log out?

Closing VS Code does not stop her: she lives in a background process of her own, and a task or a
schedule carries on. Logging out or restarting the computer does end that process. Run
**Deskfish: Keep Running When VS Code Is Closed** once and she comes back when you log in — the
command writes the entry (an autostart entry on Linux, a launch agent on macOS, a logon task on
Windows) and shows it to you in a terminal, and running it again removes it. She still needs the
machine to be awake: a sleeping laptop runs nothing, and a schedule whose time passed while it
slept is reported as missed rather than run late. If she was in the middle of a task when the
computer restarted, her next task is told about it before she touches anything — see
[Running tasks](running-tasks#if-deskfish-is-interrupted).

## Can the agent reach other devices on my network?

Its traffic leaves through your machine, so a device that answers to your computer also
answers to the tank, like any program you run. Normally the tank does not see your network
interfaces or your machine's own `localhost`; on Linux that needs the `passt` package, and
Deskfish warns you when it has to fall back to sharing your machine's network. Details in
[Security and privacy](security-and-privacy#network-exposure).

## Who made Deskfish?

Iman Reihanian, in 2026. The agent knows it too; it is in its own story and in the charter it
reads every time.

## Where is the full log?

**Deskfish: Show Log** opens the output channel with every step of every task.

## Can the agent answer questions about itself?

Yes. Ask it anything about Deskfish, for example *"where do downloaded files go?"* or
*"what do you do when a site asks for a password?"*, and it reads the relevant page of this
documentation before answering. It only reads when asked, so this costs nothing during
normal tasks.

## Can the agent change its own code?

It can read it, and it can propose changes: the tank has `git`, `gh`, Node.js and `npm`, and the
agent is told to work in a fork under its own GitHub account, run the tests, and open a pull
request. It cannot change what runs it: a pull request from a fork has no access, and a change
reaches a tank only when you merge it and install the new build. The agent asked for the review
step itself. See [How the bot sees and acts](how-the-bot-sees-and-acts#its-own-source-code).

## Is Deskfish open source?

Yes, under the Apache License 2.0: use, modify, redistribute and sell freely, with an explicit
patent grant from contributors. The name Deskfish is not part of the grant; the mascot is CC0.
