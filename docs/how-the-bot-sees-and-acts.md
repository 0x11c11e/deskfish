---
title: How the bot sees and acts
description: The loop behind every task, the tools the agent has, and the tricks that make it click the right thing.
section: Under the hood
order: 1
---

The agent has no special access to the programs in the tank. It works the way a person
does: it looks at the screen, decides, and uses the mouse and keyboard. This page explains
that loop and the few tools around it, so its behavior makes sense when you watch it.

## The loop

Every task is a repetition of the same four moves:

1. **Look.** Deskfish takes a screenshot of the tank's screen and sends it to the model.
2. **Think.** The model, given the task, the conversation so far and the screenshot, decides
   what to do next. It may say something to you first.
3. **Act.** The chosen actions are carried out on the tank: move the mouse, click, type,
   press keys, scroll, wait.
4. **Settle.** After actions that could change the screen, Deskfish waits a moment
   (`deskfish.settleMs`, 800 ms by default) so pages can react, and then looks again.

One trip round the loop is a **step**. The model is told to check each new screenshot
against what it intended, and to correct itself if a click landed in the wrong place.

A step that could not have changed the screen — asking the page a question, magnifying a corner
of it, reading a documentation page, saving a memory — skips the looking: no screenshot is taken,
and the agent is told in one sentence that the screen is still the one it last saw. Most of a long
web task is such steps, and each of them used to carry a fresh picture of an untouched screen.

## What the agent can do

The model is given a small set of tools, the same on every provider:

| Tool | What it does |
| --- | --- |
| `computer` | The hands and eyes: screenshot, left/right/middle/double/triple click, mouse move, drag, type text, press a key or key chord, scroll, wait, and report the pointer position |
| `wait_for` | Stand by for minutes without spending steps: Deskfish watches the screen and wakes the agent when it changes and settles, or when the time is up. See below |
| `zoom` | Magnify part of the screen to read small text or find an exact click point. Changes nothing |
| `find` | Find links, buttons, fields and text on the web page open in Firefox by what they say, and get their exact click coordinates. See below. Changes nothing |
| `read_page` | List every control on the page in Firefox with its state and position, or read the page's text. Changes nothing |
| `click_element` | Click a control on that page by what it says — the find and the click in one step. Clicks only a clear match that is visible and unobstructed; otherwise it clicks nothing and says why. See below |
| `scroll_to` | Bring a named element into the middle of the visible part of the page — the page scrolls itself, no mouse wheel — and say where it is now. See below |
| `select_option` | Choose an option of a native dropdown on the page by its text, without opening it. See below |
| `run_command` | Run a shell command in the tank's terminal environment and get its output back as text, without the screen: reading and editing files, git, tests, scripts. Time-limited, and cut at about 20,000 characters |
| `ask_user` | Stop and hand the desktop to you, with a reason. See [Knocking on the glass](knocking-on-the-glass) |
| `ask_fill` | Ask for a login through a card in your chat, and have what you type typed into the page's fields. The agent is told which fields were filled and never the values. See [the sign-in card](knocking-on-the-glass) |
| `read_docs` | Read a page of this documentation, so it can answer questions about Deskfish accurately. Changes nothing |
| `remember` / `forget` | Save one durable fact to its [long-term memory](memory), or delete matching ones |
| `note_to_self` / `recall` | Leave a line in its journal; search the journal and past chats |
| `revise_self` / `restore_self` / `self_history` / `archive_story` | Rewrite, restore or read the history of its own self file, or move an older story paragraph into its journal to make room. See [Memory](memory) |
| `save_playbook` / `read_playbook` | Keep and consult its own how-to notes for sites and kinds of task |

The agent is also told, in its standing instructions, exactly which tools these are and what
its computer contains, so it does not have to discover by trial that there is no `wget` but
there is `curl`. Beyond those tools it has no other channel into the tank. The terminal is a
normal shell with `bash`, `python3` (with `pip` and `requests`), `curl`, `git` and the GitHub
CLI `gh`, Node.js 22 with `npm`, `jq`, the `pdftotext` and `pdftoppm` tools for PDFs,
`zip`/`unzip`, `nano` and `less`, but there is no root, no `sudo` and no system package manager.
With `run_command` the agent uses that shell without the screen: the command runs as its own
user with input closed, and it gets the output, the exit code and the time back as text. You see
the command and a one-line verdict in the folded actions chip, with the output under it, and the
full text in the Deskfish output log. The network is whatever the tank can reach:
the internet through your machine, and your LAN like any program you run; see
[Security and privacy](security-and-privacy#network-exposure).

## Seeing where the pointer is

A screenshot of a Linux desktop does not include the mouse pointer. So before each look,
Deskfish asks the tank where the pointer is and draws a small red crosshair at that spot on
the screenshot. The model is told the crosshair is an overlay, not part of the screen. After a
click, the crosshair shows exactly where it landed, which is how the model notices and fixes
a miss.

You do not see the crosshair in the Desktop tab; it exists only in the agent's copy.

## Zooming instead of guessing

Small targets, such as toolbar icons, checkboxes and links in dense text, are where vision
models make mistakes. The agent is told not to guess at anything small but to **zoom** first.
A zoom returns a three-times magnified crop of the real screen around the point it asked
for, overlaid with rulers and a dotted grid labeled in ordinary screenshot coordinates. The
model reads its target's exact position off the grid, then clicks with those numbers. There
is only one coordinate system, so nothing can get lost in translation.

## Reading the page instead of the picture

Most tasks happen in Firefox, and a web page knows more about itself than a picture of it
shows. The tank's Firefox carries a small extension, the **Deskfish page bridge**, that
lets the agent ask the page directly:

- **`find`** takes a few words, such as *Sign in*, *search box*, *Add to cart button* or
  *Order total*, and returns the best-matching elements with their role, their name, their
  current state (a field's value, whether a box is checked, which option is selected) and
  the exact coordinates to click, in the same screenshot pixels the agent uses for everything
  else. A match outside the visible part of the page is reported as off-screen, with how far
  to scroll, and one hidden behind a dialog or menu is reported as covered.
- **`read_page`** lists every link, button, field, checkbox, menu item and heading visible
  in the viewport, in page order, with the same details, and says how many more lie below or
  above. With scope *text* it returns the page's text instead, so the agent can read an
  article, a results list or a confirmation without scrolling through it.
- **`click_element`** does what `find` does and then clicks the answer, in the same step. It is
  what the agent uses to press something it can name: *Sign in*, *Accept all cookies*, *60 days
  late*. It clicks only when it is sure — the words really matched, the element is inside the
  visible part of the page, and nothing is in front of it — and then says what it clicked, in the
  same words `find` uses, with the other candidates listed under it so a near miss is visible. When
  it is not sure it **clicks nothing** and answers exactly as `find` would: the candidates it
  considered, how far to scroll if the match is below the fold, or that a dialog covers the target.
  The agent then decides. It never retries and never scrolls on the agent's behalf.
- **`scroll_to`** takes the same words and has the page scroll the best match into the middle of
  the visible part itself. The answer says where the element is now, so a `click_element` or `find`
  can follow at once. It is the one-step answer to *N px below, scroll down first*: no wheel clicks,
  no looking to see whether the target has arrived yet. A weak match scrolls nothing.
- **`select_option`** sets a native dropdown (an HTML `select`) to the option whose text the agent
  names, without opening it: the page gets the change exactly as it would from a person, and the
  answer shows the dropdown with its new value. The options of an open dropdown are not elements
  of the page, so `find` and `click_element` cannot see them; this tool does not need to. If the
  dropdown has no such option, the answer lists the ones it has. A menu made of buttons is not a
  dropdown: the agent opens it with `click_element` and clicks the option.

The click point the bridge reports is on the element's own text: for a link wrapped onto two lines
it is the middle of the first line, never the gap between the lines, and the bridge checks with
the page that a click there really reaches the element before it calls the element visible.

`find` and `read_page` are passive: nothing on screen changes. `click_element`, `scroll_to` and
`select_option` act, and are followed by a look like any other action. The agent is told to ask
the page rather than guess where something is — `click_element` to press, `find` to read what is
there or check a field's state before acting, `scroll_to` to reach what is off-screen — and to
zoom only for what the bridge cannot see: native dialogs, the terminal, the panel, PDFs, drawings,
and anything that is not an `http(s)` page. Frames inside a page (a payment form, an embedded
editor) are read too.

The bridge talks only to the tank's own control daemon; it has no network access of its own,
and the page's contents go to the model only when the agent asks for them, the way a
screenshot does. If Firefox is closed, the tools say so and the agent opens it.

## Standing by

Some work is mostly waiting: an ad set that takes ten minutes to process, an upload, a reply,
or a rule like "send the next one in five minutes". A plain wait is capped at thirty seconds
and every wait is followed by a model turn, so waiting out minutes that way costs money and,
because nothing on screen changes, looks to Deskfish like the agent is stuck.

`wait_for` is waiting without model calls. The agent names what it is waiting for and how
long at most, and Deskfish takes over: it takes small local screenshots every few seconds and
compares them, without involving the model. The turn before the wait and the turn after it
still count; the checks in between are free. It wakes the agent, with a fresh screenshot,
either when the screen has changed **and then held still** for one more look (a spinner keeps
moving and does not count; a finished page is a new picture that stays), or when the time is
up. A change that happened before the wait even began (a toggle that flips at once, a page
that finished loading while the model was still thinking) counts too: Deskfish compares with
the last screenshot the agent was shown — or, when the action and the wait come in the same
turn, with the screen from just before that action — and wakes the agent after a few seconds
of stillness instead of at the deadline. With `until` set to *time* it simply waits the whole period, which is how the agent spaces
actions out. It can also watch just one area of the screen, so a clock or an animation
elsewhere does not wake it.

While it stands by, the chat shows a line with the reason and a live countdown, which turns
into the outcome when the wait ends, and the status row reads *Standing by* with the time
left. **Stop** ends it at once. When waiting is part of the plan, the agent announces it in a
sentence first. A thirty-minute wait ends in one model turn, instead of sixty short waits
with a turn after each. It is for things the page or the world does; the agent's own actions,
typing included, are complete when they return, and it is told not to stand by for them.

## Long tasks: the ledger

Every step of a task sends the conversation so far to the model. Where the provider caches
it, that is cheap, but never free: left alone, the last steps of a long task would cost many
times the first ones, and a model that has been reading the same long transcript for an hour
can lose the thread of what it was doing. Both problems have the same fix.

Every forty steps (`deskfish.ledgerEvery`, 0 to turn it off), or sooner once the conversation
has grown past a size (`deskfish.ledgerTokens`, a hundred thousand tokens by default), the agent
is asked to write a **ledger**: the goal with its limits, what is done and the concrete facts it established,
what is left, the current state of the screen, and the traps it hit. The conversation is then
restarted from that ledger and a fresh screenshot, with anything you said mid-task carried
along. The cost of a step no longer grows with the length of the task, since the context is
cut back every forty steps, and the agent continues from its own notes rather than from a
fading memory of a hundred screenshots.

The ledger shows in the chat as a folded card, so you can read what it carried over, and it
is kept in the transcript.

## Its own source code

Deskfish is open source, and the agent is told where its code lives: the repository holds the
loop, the tools, the tank recipe and these pages. It may read it any time and clone it in its
terminal. To change something, it is told to work in a fork under a GitHub account of its own,
run the test suite, and open a pull request with the change and its reasoning. Nothing it writes
runs until you merge it and install the new build: a pull request from a fork has no access to
the repository, every pull request runs the tests before anyone reads it, and a build installed
from a file never updates itself. The agent asked for exactly this arrangement, a person outside
the loop reviewing changes to the faculties it would use to review them. Keep your own GitHub
login out of the tank and protect the main branch so a merge needs a review; see
[Security and privacy](security-and-privacy#its-own-source-code).

## Screenshots and coordinates

Screenshots are scaled down to `deskfish.screenshotWidth` (1280 pixels by default) before
they go to the model, and the model's coordinates are scaled back to real pixels when actions
run. With the default 1280 × 800 screen that is exactly one to one. A larger virtual screen
still costs the same tokens per screenshot, just at a smaller scale, which is why very large
screens make small targets harder rather than easier.

Not every step takes one. When a step's actions could not have changed the screen — a `find`, a
`read_page`, a `zoom`, a documentation page, a memory — no screenshot is taken and none is sent;
the agent is told that nothing it did could have changed the screen and that its last screenshot,
still in the conversation, stands. When it expects the screen to have moved on its own — a page that
was still loading, a reply it was waiting for — it asks for one with the `screenshot` action, or
stands by with `wait_for`. The Desktop tab is unaffected, since it is a live view of the screen
rather than a stream of these pictures.

Images are pruned in batches: after each prune only the three most recent stay in the
conversation, and older ones are replaced by the note *earlier screenshot omitted*. Long text
results are pruned the same way: a page's text, a command's output or a documentation page
stays whole while it is one of the four newest and then shrinks to its first line, with a note
that the agent can ask for it again. The rest of the conversation stays until the next ledger
replaces the older part of it; the saved transcript keeps all of it.

## Keys and shortcuts

The model presses keys by name, in the style of the `xdotool` tool used inside the tank:
`Return`, `Escape`, `ctrl+l`, `alt+Tab`, `Page_Down`. The tank also understands common
aliases such as `enter` and `pageup`. It is encouraged to prefer keyboard shortcuts where
they are reliable, for instance Ctrl+L for the address bar and Ctrl+T for a new tab, and to
type URLs rather than search for them.

Typed text can be as long as an email and can span lines: each line is typed and followed by
Return. Accents, em dashes, emoji and non-Latin scripts are typed as they are; a character
the keyboard tool cannot map is pasted instead, without disturbing your clipboard.

## Batches

Obviously sequential actions, such as *click the field, type the text, press Return*, are
sent as one batch and executed in order, with a single screenshot afterwards. Anything less
certain is done one action at a time, with a look in between. When a batch contains only
passive actions (a zoom, a `find` or `read_page`, a pointer check, a documentation lookup),
Deskfish skips the settle delay *and* the screenshot, because nothing on screen could have
changed; the agent is told so in words. `click_element`, `scroll_to` and `select_option` act, so
they end a passive batch: the step settles and looks like any other click. `run_command` and `wait_for` keep their screenshot too —
a command can open a window, and standing by is waiting for the screen to change.

## What it is told

The agent's instructions are short. In summary: you are Deskfish; this computer is yours,
and everything in it is yours to use; you operate it with screenshots, mouse and keyboard;
check every screenshot against what you intended; on a web page ask the page instead of hunting in the picture
(`click_element` to press something by its words, `find` or `read_page` to see what is there,
`scroll_to` to bring it into view, `select_option` for a native dropdown), and
zoom before clicking anything small; files
you are given are in Uploads and anything for the user goes in Downloads; when you need
something only the user has (a code, a card, a confirmation, a CAPTCHA you cannot pass) or you
are stuck, hand over; do what the user asks all the way through; be economical with steps;
if a task involves waiting more than a minute, say so in a sentence first and use `wait_for`;
every forty steps, write a ledger the task can be resumed from; speak to the person in the
chat as "you", never as "the user", and treat the name in `deskfish.userName`, if set, as
that same person; and when the task is done, write a short summary. Plus what it has: its
tools by name and what is installed in the tank; the size of the screenshots; the list of
documentation pages it can read; and its memories. Every prompt also carries the charter, its
own self page, its last few journal entries and the titles of its playbooks; see
[Memory](memory). In guided mode (`deskfish.autonomy`) it is also told to ask before anything
irreversible, never to use credentials it was not given, and never to attempt a CAPTCHA.

It is told that steps cost money and, if you set a step cap, how many it has, with a warning
when three remain and a request for a summary at the cap, so a capped task ends with a report
rather than nothing. Deskfish also watches for stalls on its behalf: an unchanged screen and
repeated actions earn a nudge to change approach, then a hand-over to you.

It knows the desktop is its own and that it is the tank, a sandboxed Linux computer; that you
talk to it from the Deskfish sidebar in VS Code and can watch its screen in the Desktop tab;
how the tank is networked; the local date and time, given at the start of every run; and, in
one line, which model runs it and where.
