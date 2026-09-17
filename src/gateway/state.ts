import * as fs from 'node:fs';
import * as path from 'node:path';
import { writePrivate } from './storage';

/**
 * `state.json`: what she is doing right now, on disk, so an interruption is not a hole.
 *
 * The gateway can stop between two steps — the machine reboots, the process is killed, an update
 * replaces it. The next start reads this file, writes one line in her journal, and hands the next
 * run a note: the task, what was said, the last ledger, how long ago it stopped, the last action
 * that finished (everything after it is unknown), whether the tank restarted, and the rule she
 * asked for herself — look at the screen first, never continue with a click queued in her head.
 *
 * It is operational, not hers: it is not in `HER_FILES`, not in the export bundle, and only the
 * service writes it. Pure Node; no `vscode` import.
 */

export const STATE_FILE = 'state.json';

export interface RunState {
  /** The task as it was submitted ('a reflection' for a reflection). */
  task: string;
  reflection?: boolean;
  unattended?: boolean;
  /** Why it was started without anyone watching ('schedule'). */
  reason?: string;
  startedAt: string;
  steps: number;
  lastStepAt: string;
  /** The latest ledger she wrote in this run. */
  ledger?: { step: number; text: string };
  /** What the user said while it ran, in order. */
  said: string[];
  /** The last thing she said in the chat. */
  lastAssistant?: string;
  /** The last action that finished. Whatever came after it was never recorded. */
  lastAction?: { step: number; describe: string; ok: boolean };
  /** The tank's container id when the run started: a different one now means the desktop restarted. */
  containerId?: string;
  /** A gateway start already wrote the journal line for this interruption (so a second start does not repeat it). */
  noted?: boolean;
}

export function stateFile(dataDir: string): string {
  return path.join(dataDir, STATE_FILE);
}

/** 0600 through a temp file + rename, like every other file of hers the gateway writes. */
export function writeState(dataDir: string, state: RunState): void {
  writePrivate(stateFile(dataDir), JSON.stringify(state, null, 1) + '\n');
}

export function clearState(dataDir: string): void {
  try {
    fs.rmSync(stateFile(dataDir));
  } catch {
    /* nothing to clear */
  }
}

/** The running task the last gateway left behind, or undefined (no file, or one that makes no sense). */
export function readState(dataDir: string): RunState | undefined {
  let raw: Partial<RunState>;
  try {
    raw = JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8')) as Partial<RunState>;
  } catch {
    return undefined;
  }
  if (!raw || typeof raw.task !== 'string' || !raw.task || typeof raw.startedAt !== 'string') return undefined;
  const led = raw.ledger;
  const act = raw.lastAction;
  return {
    task: raw.task,
    reflection: !!raw.reflection,
    unattended: !!raw.unattended,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    startedAt: raw.startedAt,
    steps: typeof raw.steps === 'number' && Number.isFinite(raw.steps) ? raw.steps : 0,
    lastStepAt: typeof raw.lastStepAt === 'string' ? raw.lastStepAt : raw.startedAt,
    ledger: led && typeof led.text === 'string' ? { step: Number(led.step) || 0, text: led.text } : undefined,
    said: Array.isArray(raw.said) ? raw.said.filter((x): x is string => typeof x === 'string') : [],
    lastAssistant: typeof raw.lastAssistant === 'string' ? raw.lastAssistant : undefined,
    lastAction: act && typeof act.describe === 'string' ? { step: Number(act.step) || 0, describe: act.describe, ok: !!act.ok } : undefined,
    containerId: typeof raw.containerId === 'string' ? raw.containerId : undefined,
    noted: !!raw.noted,
  };
}

/** "41 minutes", "3 hours", "2 days" — how long the gap was, in words she can act on. */
export function describeGap(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** The one line her journal gets when a gateway starts over a run that never finished. */
export function interruptedLine(state: RunState, now: number): string {
  const gap = describeGap(now - Date.parse(state.lastStepAt));
  const what = state.reflection ? 'a reflection' : `"${short(state.task.replace(/\s+/g, ' ').trim(), 160)}"`;
  return `Interrupted after ${state.steps} step${state.steps === 1 ? '' : 's'}: ${what} — ${gap} ago.`;
}

export interface ResumeContext {
  state: RunState;
  now: number;
  /** The tank's container id now (undefined when the tank is off or unknown). */
  containerId?: string;
  /** Is the tank on at all right now? */
  desktopOn: boolean;
  /** Schedules that fired or were missed between the gateway coming back and this run. */
  schedules?: { kind: 'fired' | 'missed'; task: string }[];
}

/**
 * The note prepended to the first observation of the next run after an interruption (her
 * requirement 3: resume, not a zombie). Prose, not fields: it has to be read and acted on.
 */
export function resumeNote(o: ResumeContext): string {
  const s = o.state;
  const gap = describeGap(o.now - Date.parse(s.lastStepAt));
  const lines: string[] = [];
  lines.push(
    `Before anything else, a note from Deskfish itself, not from the user: your previous run did not finish. The program you run in stopped ${gap} ago — it was restarted, updated, or the machine was — and this is the first run since.`,
  );
  lines.push(`What you were doing: "${short(s.task.replace(/\s+/g, ' ').trim(), 600)}"${s.unattended ? ` (started without anyone watching${s.reason ? `, by a ${s.reason}` : ''})` : ''}. It ran ${s.steps} step${s.steps === 1 ? '' : 's'}.`);
  if (s.lastAssistant) lines.push(`The last thing you said in that chat: "${short(s.lastAssistant.replace(/\s+/g, ' ').trim(), 400)}"`);
  if (s.said.length) lines.push(`What the user said while it ran, in order: ${s.said.map((t) => `"${short(t.replace(/\s+/g, ' ').trim(), 300)}"`).join('; ')}`);
  if (s.ledger) lines.push(`Your last ledger (written after ${s.ledger.step} steps):\n${s.ledger.text}`);
  lines.push(
    s.lastAction
      ? `The last action that finished was step ${s.lastAction.step}: ${s.lastAction.describe}${s.lastAction.ok ? '' : ' — it failed'}. Whatever you did after that was never recorded: it is unknown, and you must not assume it happened or that it did not.`
      : 'No action of that run was recorded as finished, so what it managed to do is unknown.',
  );
  if (!o.desktopOn) lines.push('The tank is off right now; it will be turned on for this run as a fresh session. Assume nothing in its windows survived.');
  else if (s.containerId && o.containerId && s.containerId !== o.containerId) lines.push('The tank itself restarted since then (it is a different container): assume nothing in its windows survived — no open page, no half-filled form, no unsaved file.');
  else if (s.containerId && o.containerId) lines.push('The tank kept running through it (the same container), so its windows are probably as you left them — but check, do not trust it.');
  if (o.schedules?.length) lines.push(`While you were away: ${o.schedules.map((x) => `a scheduled task ${x.kind === 'fired' ? 'ran' : 'was missed'} — "${short(x.task.replace(/\s+/g, ' ').trim(), 160)}"`).join('; ')}.`);
  lines.push(
    'So: look first. Read the screen as it is now before you touch anything, and never continue with an action you had queued in your head — it belongs to a screen that may no longer exist. Then decide for yourself whether the task below carries the old one on, replaces it, or is unrelated.',
  );
  return lines.join('\n');
}
