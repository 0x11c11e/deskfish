---
title: Schedules
description: Tasks that start themselves, once at a time or on a repeat, while Deskfish runs, and what happens when the time is missed.
section: Using Deskfish
order: 7
---

A schedule is a task with a time attached: *once on Tuesday at 22:00*, *every day at 22:00*,
*every Monday at 07:00*, or *every 90 minutes*. When the time comes, Deskfish starts the task
exactly as if you had typed it into the chat. The agent is not involved until then; she is
free to do other work in the meantime.

## Creating one

Open **Scheduled tasks**: **Deskfish: Scheduled Tasks…** in the chat's **…** menu or the command
palette, or the calendar icon in the web page's title bar. It is the same panel inside the chat
in both. Its form asks when, what, how much she should decide on her own when it runs, and a
budget for its runs (leave it empty for the setting); **Add** saves it. Times are the local time
of the computer Deskfish runs on. Write the task
the way you would in the chat, and since nobody may be watching when it runs, be explicit about
limits and what you want reported:

> Open the analytics dashboard I use, compare last week with the week before, and report the
> main changes with the date ranges and a link to each view. Do not change any settings; if
> the dashboard asks you to log in again, knock and wait.

The list at the top of the panel shows what is scheduled, with the next time, the fence when it
is not the default and the last outcome. **Run now** starts one (the panel closes so you watch it
in the chat); **Remove** asks once more on the same button. Schedules are kept in a small file in the
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
  schedule; **Deskfish: Keep Running When VS Code Is Closed** also brings her back when you log
  in, so a restart does not either. If the laptop was off or asleep at the due time and Deskfish
  only sees the moment later, the occurrence is
  **missed**: a notice appears in the chat, the log and her journal, and the
  task waits for its next time. A report meant for 7:00 should not quietly run at lunchtime.
  The one exception is a short grace, five minutes by default
  (`deskfish.scheduleGraceMinutes`), for the case where Deskfish started a moment late.

Shutting the laptop ten times before Monday changes nothing. Only the due moment matters.

## The fence on a run nobody is watching

A task you type is watched: you see each step and can press Stop. A scheduled task is not, so it
runs with two limits you do not have to think about:

- **It behaves as `guided`** — it asks before anything irreversible and uses no credentials you
  did not give it — even when `deskfish.autonomy` is `free`. Pick *Free, like a task you type
  yourself* when the schedule is asked for to lift that for this one schedule.
- **It has a cost budget**, `deskfish.unattendedMaxCostUsd`, two dollars by default. At 80% she
  is told to wrap up; at the budget she takes no more actions and writes a summary. `0` turns it
  off. The same caveat as `deskfish.maxCostUsd` applies: the budget can only act where the cost
  is known (Claude, Kimi or Grok used directly, or an endpoint that reports the charge). A budget
  typed when the schedule is made is kept on that schedule and wins over the setting.

Both are hers only while nobody asked for the run. **Run it now** is your click, so it runs with
your own settings, like anything you type.

## When a scheduled task is interrupted

If Deskfish stops in the middle of a run — the computer restarts, an update replaces her, the
process is killed — she notices at her next start. One line goes in her journal (*"Interrupted
after 23 steps: … — 41 minutes ago"*), and the next task she runs is told what was going on
before she does anything: the task, the last ledger, what you said while it ran, the last action
that finished, whether the tank restarted, and that she must read the screen before acting. She
decides from there whether to carry the old task on. See
[Running tasks](running-tasks#if-deskfish-is-interrupted).

## Things to know

- The agent is told in the task that it was scheduled and that nobody is necessarily
  watching. If a site asks for a code only you have, she knocks on the glass and waits; the
  task sits paused until you look. Sites that need two-factor codes are poor candidates.
- Anything with consequences on a timer needs a fence of its own too. Put the limits and the
  "skip if" conditions in the task text: `deskfish.unattendedMaxCostUsd` limits model spending,
  not what the agent buys.
- A schedule is created with the command, not by asking in the chat. Telling the agent "do
  this every Monday" does not register one. Repeats are at least five minutes apart.
- Times are local to the computer Deskfish runs on (which matters only when you open the web page
  from somewhere in another time zone). A one-off schedule is removed after it fires or is missed.
- Not yet implemented: attaching files to a scheduled task.
