import type { CommandName, Snapshot } from '../gateway/protocol';
import type { ToChat } from './protocol';

/**
 * The chat view's line to the gateway (gateway plan step 6B): the view posts `ask {id, cmd, args}`,
 * the host (VS Code's `ChatViewProvider`, the page's shim) forwards the commands named here and posts
 * the `answer`. Everything else a view can do stays a host message of its own. Pure; no `vscode`.
 */

/** What the view's panels may ask the gateway. */
export const VIEW_COMMANDS = [
  'chats.list',
  'chats.open',
  'chats.delete',
  'chats.continue',
  'config.get',
  'config.schema',
  'config.set',
  'schedules.list',
  'schedules.add',
  'schedules.remove',
  'schedules.runNow',
  'memory.read',
  'memory.write',
  'memory.clearFacts',
  'self.read',
  'journal.read',
  'playbook.read',
  'reflect',
  'export',
  'import',
  'snapshot',
] as const satisfies readonly CommandName[];

export type ViewCommand = (typeof VIEW_COMMANDS)[number];

export function isViewCommand(cmd: unknown): cmd is ViewCommand {
  return typeof cmd === 'string' && (VIEW_COMMANDS as readonly string[]).includes(cmd);
}

type Answer = Extract<ToChat, { type: 'answer' }>;
const text = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The answer to one `ask`: `call` runs only for a command the view may ask, and a refusal or a
 * failure is an answer too, never a throw. `call` may post the answer itself inside the frame that
 * carried it (a snapshot must land before the events after it); then it resolves with `undefined`
 * and `respond` is not called again.
 */
export async function answerAsk(m: { id: number; cmd: unknown; args?: unknown }, call: (cmd: ViewCommand, args: Record<string, unknown> | undefined, respond: (a: Answer) => void) => Promise<unknown>, respond: (a: Answer) => void): Promise<void> {
  if (!isViewCommand(m.cmd)) {
    respond({ type: 'answer', id: m.id, ok: false, error: `the chat view may not ask ${String(m.cmd)}` });
    return;
  }
  let answered = false;
  const once = (a: Answer) => {
    if (answered) return;
    answered = true;
    respond(a);
  };
  try {
    const result = await call(m.cmd, m.args && typeof m.args === 'object' ? (m.args as Record<string, unknown>) : undefined, once);
    once({ type: 'answer', id: m.id, ok: true, result });
  } catch (err) {
    once({ type: 'answer', id: m.id, ok: false, error: text(err) });
  }
}

/** The messages that rebuild the chat from a snapshot: VS Code on (re)connect, the page's mirror, the view's Back from a past chat. */
export function snapshotChat(s: Snapshot): ToChat[] {
  const out: ToChat[] = [{ type: 'newChat' }];
  if (s.chat.length) out.push({ type: 'replay', title: '', items: s.chat, live: true });
  if (s.usage) out.push({ type: 'event', event: s.usage });
  if (s.screenshot) out.push({ type: 'event', event: { type: 'screenshot', step: s.screenshot.step, jpegBase64: '', width: s.screenshot.width, height: s.screenshot.height } });
  // A finished run's status line is already in the transcript; only a live one is re-announced.
  if (s.status === 'running' || s.status === 'paused') out.push({ type: 'event', event: { type: 'status', status: s.status, message: s.statusMessage, ...(s.screenFree ? { screenFree: true } : {}) } });
  out.push({ type: 'desktop', status: s.desktop.status });
  return out;
}
