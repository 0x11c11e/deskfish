---
title: Introduction
description: What Deskfish is, what it does for you, and the ideas behind it.
section: Start here
order: 1
hero: true
tagline: Give your AI its own computer. | Watch it work through the glass.
---

Deskfish, created by Iman Reihanian in 2026, is a VS Code extension that gives an AI agent a computer of its own: a small,
sandboxed Linux desktop with a browser and a terminal, shown live in an editor tab. You
type a task in the chat sidebar. The agent looks at the screen, moves the mouse, types, and
gets on with it, exactly the way a person at a keyboard would. When it hits something only a
human can do, a login, a two-factor code, a CAPTCHA, it stops and asks you.

Think of it as a junior coworker with a desk in a glass box: you can see everything it does,
you can lean in and take the mouse whenever you want, and no folder of yours is inside the
box. Files cross only when you attach one or click **Save**; the Desktop tab also shares your
clipboard, and the box has the same internet access as any program on your machine.

## What it is good at

Deskfish is built for real-world chores, not for writing code. It shines at anything that a
patient person could do in a browser:

- Research that takes many tabs: comparing hotels across a region, collecting prices, reading
  reviews, summarizing what it found.
- Filling in forms and working through multi-page flows on websites.
- Downloading files, reports and receipts, and handing them to you.
- Running commands in a terminal and bringing back the results.
- Anything else you would explain to a new colleague by saying "open the browser and…".

It is deliberately *not* a coding assistant. You already have those in VS Code. Deskfish is
the one that has hands.

## The three things you will see

- **The chat sidebar.** Where you give tasks, read what the agent says, and get handed files.
  It lives in the activity bar under the fish icon.
- **The Desktop tab.** A live view of the agent's screen. You can watch, and you can take
  over at any moment. It opens by itself when you send a task; the **Open** button at the top
  of the sidebar brings it back any time.
- **The tank.** The agent's computer itself: a Linux container running on your machine. You
  turn it on and off with the power button in the sidebar, and Deskfish manages everything
  else about it. See [The tank](the-tank).

## A few words you will meet

Deskfish has a small vocabulary, and the interface uses it consistently.

| Word | Meaning |
| --- | --- |
| **The tank** | The agent's own sandboxed desktop, running in a container. |
| **Knocking on the glass** | The agent pausing to ask for your help, for example with a login or a CAPTCHA. |
| **Take over / Hand back** | You grabbing the mouse and keyboard in the Desktop tab, then giving control back. |
| **Uploads / Downloads** | The two folders through which files pass between your computer and the tank. |

## It remembers what matters

Between chats the agent keeps four things, in plain files on your computer. **Facts** about
you and your tasks: preferences, which accounts it uses, quirks of the sites you send it to;
yours to read, edit and empty. A **journal**: one dated line for every task it finished, and
the notes it leaves itself. **Playbooks**: the how-to notes it writes for sites and kinds of
task, in a file of their own. And a page about **who it is**, written in its own words, which
only it can change, when it reflects after a few tasks. Above that page sits a short
**charter** from the person who made it, ten commitments with the reason for each, which you
can rewrite. Every chat is saved as well, and the agent can search its own past. These are
readable local records, not a vault: review an export before you share it. See
[Memory](memory).

## Any model

Deskfish is not tied to one AI provider. It works with Anthropic's Claude models through
their native computer-use tool, with any OpenAI-compatible endpoint (xAI, OpenRouter,
LiteLLM, Ollama, vLLM and others), and with a scripted demo model that needs no key at all.
See [Models and providers](models-and-providers).

## Safety in one paragraph

The tank is the boundary. Inside it the agent is free: the browser, the accounts and the
files in there are its own. No folder on your machine is shared with it, files move only when
you attach one or click **Save**, its control ports listen on your machine only, and it runs
as an ordinary user with no administrator rights inside a container that is rebuilt each time
you turn it on. It does have ordinary internet access through your machine, and it can reach
devices on your network like any program you run. The full picture is in
[Security and privacy](security-and-privacy).

## Ask Deskfish about itself

The agent has read access to this documentation. If you ask it something about Deskfish,
for instance *"how do I get a file out of your desktop?"* or *"what happens to your cookies
when I turn you off?"*, it reads the relevant page and answers from it, instead of guessing.
It only reads a page when you ask such a question, so it costs nothing during ordinary tasks.

## Where to go next

- New here? Start with [Getting started](getting-started).
- Curious how it actually works? Read [How the bot sees and acts](how-the-bot-sees-and-acts).
- Something not working? Try [Troubleshooting](troubleshooting).
