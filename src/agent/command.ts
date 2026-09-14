/**
 * run_command, the model's side: what a finished command looks like in its result, and the cut
 * that keeps a chatty command from flooding the context. The daemon captures up to a fixed
 * amount; this trims what the model gets to MAX_COMMAND_OUTPUT characters, keeping the head (the
 * beginning of a file, the first errors) and the tail (the verdict of a test run, the last error).
 */
import type { CommandOutput, ComputerAction } from '../computer/types';

/** Characters of a command result the model gets at most; the middle is cut, head and tail kept. */
export const MAX_COMMAND_OUTPUT = 20_000;
const HEAD = 14_000;

export function cutMiddle(text: string, max = MAX_COMMAND_OUTPUT): string {
  if (text.length <= max) return text;
  const tail = Math.max(0, max - HEAD);
  const omitted = text.length - HEAD - tail;
  return `${text.slice(0, HEAD)}\n… [${omitted.toLocaleString('en-US')} characters omitted] …\n${text.slice(text.length - tail)}`;
}

export type RunCommand = Extract<ComputerAction, { type: 'run_command' }>;

/** The model's view of a finished command: what ran, what came back, how it ended. */
export function renderCommand(action: RunCommand, out: CommandOutput): string {
  const secs = out.ms >= 100 ? `${(out.ms / 1000).toFixed(1)} s` : `${out.ms} ms`;
  const stdout = out.stdout.replace(/\s+$/, '');
  const stderr = out.stderr.replace(/\s+$/, '');
  const parts = [`$ ${action.command}`];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`[stderr]\n${stderr}`);
  if (!stdout && !stderr) parts.push('(no output)');
  if (out.timedOut) parts.push(`(timed out after ${action.timeoutSeconds ?? 60} s and was killed)`);
  else if (out.exit === null) parts.push('(killed before it finished)');
  else parts.push(`(exit ${out.exit} · ${secs})`);
  const text = cutMiddle(parts.join('\n'));
  return out.truncated ? `${text}\n(the tank stopped capturing: the output was too large — use ranges for big files)` : text;
}

/** One line for the log and the transcript. */
export function summarizeCommand(out: CommandOutput): string {
  if (out.timedOut) return `timed out after ${Math.round(out.ms / 1000)} s`;
  if (out.exit === null) return 'killed';
  const lines = `${out.stdout}${out.stderr}`.split('\n').filter((l) => l.trim()).length;
  return `exit ${out.exit} · ${(out.ms / 1000).toFixed(1)} s · ${lines} line${lines === 1 ? '' : 's'}`;
}
