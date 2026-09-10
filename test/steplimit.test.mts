// The step limit: maxSteps 4 with a model that never finishes → the budget is stated at the start, the
// last three steps warn, the limit asks for a summary (one wrap-up message, one extra model call), the
// summary reaches the chat, status ends done "Stopped at the step limit (4)", and a second run() on the
// same runner continues the conversation instead of starting over.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRunner, type AgentEvent } from '../src/agent/loop';
import { DesktopDaemonComputer } from '../src/computer/daemon';
import type { ModelAdapter, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 9973;
const mock = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-daemon.mjs')], { env: { ...process.env, MOCK_PORT: String(port) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
try {
  const computer = new DesktopDaemonComputer(`http://127.0.0.1:${port}`);
  const notes: { turn: number; note: string }[] = [];
  const userMessages: string[] = [];
  let starts = 0, calls = 0;
  const adapter = {
    name: 'scripted', start() { starts++; }, addUserMessage(t: string) { userMessages.push(t); },
    async step(obs: Observation) {
      calls++;
      if (obs.note) notes.push({ turn: calls, note: obs.note });
      if (calls === 5) return { text: 'Summary: I clicked around and found nothing yet.', actions: [], done: true };
      if (calls >= 6) return { text: 'Continued and finished.', actions: [], done: true };
      // A different click every turn, so the stall detector has nothing to say.
      return { text: '', actions: [{ type: 'click', x: 100 + calls * 60, y: 200, button: 'left', count: 1 }], done: false };
    },
  } as unknown as ModelAdapter;
  const events: AgentEvent[] = [];
  const status = () => events.filter((e) => e.type === 'status').pop() as Extract<AgentEvent, { type: 'status' }>;
  const runner = new AgentRunner({ computer, adapter, maxSteps: 4, settleMs: 0, onEvent: (e) => { events.push(e); } });
  await runner.run('Find the settings page');

  ok(notes[0]?.turn === 1 && /You have up to 4 steps \(model turns\) for this task; use them economically\./.test(notes[0].note), `first note states the budget: ${JSON.stringify(notes[0]?.note)}`);
  ok(notes.some((x) => x.turn === 2 && /^Only 3 steps remain \(including this one\) before the task is cut off\. Wrap up now/.test(x.note)), 'warning with 3 steps left');
  ok(notes.some((x) => x.turn === 4 && /^Only 1 step remains \(including this one\) before the task is cut off\./.test(x.note)), 'warning with 1 step left');
  const wraps = userMessages.filter((m) => /^The step limit \(4\) is reached\. Take no more actions/.test(m));
  ok(wraps.length === 1 && userMessages.length === 1, `one wrap-up user message: ${wraps[0]}`);
  ok(calls === 5, `4 steps + 1 wrap-up call (${calls})`);
  ok(events.some((e) => e.type === 'assistant' && /^Summary:/.test(e.text)), 'the summary surfaces as an assistant event');
  ok(status().status === 'done' && (status().message ?? '').startsWith('Stopped at the step limit (4)') && runner.currentStatus === 'done', `final status: ${status().status}:${status().message}`);

  // "continue": the same runner, the same conversation
  await runner.run('continue');
  ok(starts === 1 && userMessages.length === 2 && userMessages[1] === 'continue', 'a second run() does not restart the adapter; the task arrives as a user message');
  ok(calls === 6 && runner.currentStatus === 'done' && status().message === 'Task finished' && events.some((e) => e.type === 'assistant' && e.text === 'Continued and finished.'), `the follow-up ran in the same conversation and finished (${calls} calls)`);
} finally {
  mock.kill();
}

console.log(`steplimit: ${n} checks passed`);
