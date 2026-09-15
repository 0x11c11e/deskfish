---
title: Schedules
description: Tasks that start themselves, once at a time or on a repeat, while Deskfish runs, and what happens when the time is missed.
section: Using Deskfish
order: 6
---

A schedule is a task with a time attached: *once on Tuesday at 22:00*, *every day at 22:00*,
*every Monday at 07:00*, or *every 90 minutes*. When the time comes, Deskfish starts the task
exactly as if you had typed it into the chat. The agent is not involved until then; she is
free to do other work in the meantime.

## Creating one

Run **Deskfish: Schedule a Task…** from the **…** menu of the chat or the command palette.
It asks when, then what. Write the task the way you would in the chat, and since nobody may
be watching when it runs, be explicit about limits and what you want reported:

> Open the analytics dashboard I use, compare last week with the week before, and report the
> main changes with the date ranges and a link to each view. Do not change any settings; if
> the dashboard asks you to log in again, knock and wait.

**Deskfish: Scheduled Tasks…** lists what is scheduled, with the next time and the last
outcome, and lets you run one now or remove it. Schedules are kept in a small file in the
agent's storage, so they survive reloads, restarts and any number of shutdowns.

## What happens at the due time

- **Deskfish is open and the agent is free.** A new chat opens with the task, the desktop
  turns on if it was off, and the task runs like any other. You get a notification when it
  starts. Results land in the chat, and the run is journaled like every task, so she has
  last Monday's report in front of her next Monday.
- **The agent is busy.** The task waits and starts as soon as she finishes, however long that
  takes. Busy never means skipped.
- **Deskfish was not running, or the laptop was asleep.** A schedule only fires while Deskfish
  runs and the machine is awake. Deskfish runs in the background from the first time VS Code
  starts it until the computer restarts or you stop it, so closing VS Code does not stop a
  schedule. If the laptop was off or asleep at the due time and Deskfish only sees the moment
  later, the occurrence is
  **missed**: a notice appears in the chat, the log and her journal, and the
  task waits for its next time. A report meant for 7:00 should not quietly run at lunchtime.
  The one exception is a short grace, five minutes by default
  (`deskfish.scheduleGraceMinutes`), for the case where Deskfish started a moment late.

Shutting the laptop ten times before Monday changes nothing. Only the due moment matters.

## Things to know

- The agent is told in the task that it was scheduled and that nobody is necessarily
  watching. If a site asks for a code only you have, she knocks on the glass and waits; the
  task sits paused until you look. Sites that need two-factor codes are poor candidates.
- Anything with consequences on a timer needs a fence. Put the limits and the "skip if"
  conditions in the task text. `deskfish.maxCostUsd` applies to scheduled runs like any other,
  where Deskfish can see the cost; it limits model spending, not what the agent buys.
- A schedule is created with the command, not by asking in the chat. Telling the agent "do
  this every Monday" does not register one. Repeats are at least five minutes apart.
- Times are local. A one-off schedule is removed after it fires or is missed.
- Not yet implemented: attaching files to a scheduled task, a budget per schedule, and running
  schedules without VS Code open. An always-on Deskfish is a separate, larger step.
