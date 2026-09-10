---
title: The Desktop tab
description: The live view of the agent's screen. Watching, taking over, handing back, and the shared clipboard.
section: Using Deskfish
order: 3
---

The Desktop tab is the glass. It shows the agent's screen as it changes, and it lets you
step in with your own mouse and keyboard whenever you want.

## Opening it

It opens by itself whenever you send a task (setting `deskfish.desktop.openOnRun`), and
again when the agent knocks on the glass. You can also open it any time with the **Open**
button in the Desktop row at the top of the chat sidebar, or with **Deskfish: Open Desktop
View** from the command palette. It is an editor tab, so you can drag it next to your files,
or drop it into a second window on another monitor.

## What you see

A live view of the tank, streamed from the container over a local connection. Underneath
the screen, a status line says what the agent is doing (*agent: running*, *agent: paused*,
*agent: done*, and so on) and two buttons: **Take over** and **Reconnect**.

When the tank is off the tab shows a placeholder and a note that the desktop is off; when
it is starting it shows the progress, including the image build the first time.

## View-only while the agent works

While a task is running, the screen is **view-only**. Your clicks and keystrokes do not
reach the tank, so you cannot accidentally get in the agent's way. The agent's own mouse
moves in the live view as it works; note that the agent itself sees its pointer as a red
crosshair drawn on its screenshots, which does not appear in your view.

## Taking over

While you have the desktop, the panel at the bottom of the screen is yours too: its Firefox
and Terminal icons open those apps, and its buttons switch between open windows.

Click **Take over** (or **Pause** in the sidebar). Three things happen, in this order:

1. The agent finishes the action it is in the middle of and takes no more. While that
   lasts, a few seconds at most, the status reads *Pausing — finishing the current action*.
2. Every key and mouse button being held on the desktop is released, so you start with a
   clean keyboard. The status now reads *Paused — you have the desktop*.
3. The screen accepts your input. Click, type, log in, scroll: the tank is yours.

The button now reads **Hand back to agent**. Click it (or **Resume** in the sidebar) when
you are done. The agent is told that you had control for a while and takes a fresh
screenshot before it continues, so anything you changed is taken into account.

You can take over as often as you like during a task. The agent does not mind. While the
agent reflects, the desktop is not in use at all, so the view is never locked then; the
label reads *agent: reflecting — the desktop is yours*.

## Her pointer

While the agent works, the live view draws a large glowing pointer that glides to each target
before she clicks, pulses on the click, and carries a short label: *click*, *type "…"*,
*scroll down ×10*, *find "Sign in"*, *reading the page*, *standing by*. It is drawn from the
actions Deskfish already reports, so it costs nothing and the model never sees it; the tank's
own small pointer still moves underneath. It disappears when you take over and while she
reflects.

## The clipboard works both ways

- **Your computer → the tank.** Whenever the Desktop tab gets focus, and again when you press
  Ctrl+V inside it, your clipboard is copied into the tank first. Pasting a URL, a text or a
  code you copied on your machine simply works.
- **The tank → your computer.** Anything copied inside the tank lands on your clipboard
  within a second or two, as long as the Desktop tab is visible.

Unicode survives in both directions: accents, emoji and non-Latin scripts arrive intact.

## Keyboard notes

- Keys go to the tank only while you have taken over and the Desktop tab has focus.
- A few shortcuts belong to VS Code itself (for example the ones that switch tabs or open
  the command palette) and are not forwarded.
- If the tank ever seems to have a key stuck, for instance every click selects text as if
  Shift were held, or dragging moves the window instead of selecting, move the mouse out of
  the live view and back in, or click **Take over** and then **Hand back to agent**. Deskfish
  releases whatever is held before you interact and every time control changes hands, and
  the output log names what it released. See [Troubleshooting](troubleshooting).

## Reconnect

The live view reconnects by itself: when the tank starts, when the connection drops while
the tank is on (for instance after your machine wakes from sleep), when the tab becomes
visible again, and when the network comes back. It retries with growing pauses, up to half a
minute apart. **Reconnect** is there if you want it to try right now.

## Not a video call

The live view is for you. The agent does not watch a video: it takes one screenshot per
step and decides from that. So a page that is still loading when the agent looks is still
loading for the agent; it knows this and waits a moment after opening things. Details in
[How the bot sees and acts](how-the-bot-sees-and-acts).
