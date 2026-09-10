// No step cap by default: maxSteps 0 means the loop runs until the model stops (or the user does).
// A scripted model works the mock desktop for 70 turns and ends the task itself: the first note says
// there is no fixed limit, no "steps remain" warning and no wrap-up message ever appear, status done.
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
const port = 9972;
const mock = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-daemon.mjs')], { env: { ...process.env, MOCK_PORT: String(port) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
try {
  const computer = new DesktopDaemonComputer(`http://127.0.0.1:${port}`);
  const TURNS = 70;
  const notes: string[] = [];
  const userMessages: string[] = [];
  let calls = 0;
  let firstImage: { width: number; height: number } | undefined;
  const adapter = {
    name: 'scripted', start() {}, addUserMessage(t: string) { userMessages.push(t); },
    async step(obs: Observation) {
      calls++;
      if (obs.note) notes.push(obs.note);
      firstImage ??= { width: obs.image.width, height: obs.image.height };
      if (calls >= TURNS) return { text: `Finished after ${calls} turns.`, actions: [], done: true };
      // A different move every turn: never the same batch twice in a row, so never a stall.
      return { text: '', actions: [{ type: 'mouse_move', x: 100 + (calls % 25) * 40, y: 300 + (calls % 7) * 40 }], done: false };
    },
  } as unknown as ModelAdapter;
  const events: AgentEvent[] = [];
  const runner = new AgentRunner({ computer, adapter, maxSteps: 0, settleMs: 0, onEvent: (e) => { events.push(e); } });
  await runner.run('Move the mouse around for a while');

  ok(calls === TURNS && firstImage?.width === 1280 && firstImage.height === 720, `the model saw the 1920×1080 mock at 1280×720 and ran ${calls} turns, ending the task itself`);
  ok(/^It is .*\nThere is no fixed step limit for this task: work until it is done\./.test(notes[0] ?? ''), `first note says there is no fixed step limit: ${JSON.stringify(notes[0])}`);
  ok(notes.length === 1 && !notes.some((x) => /steps? remain/.test(x)), `no "steps remain" warning in any later note (${notes.length} note in all)`);
  ok(!notes.some((x) => /repeated the same actions/.test(x)) && !events.some((e) => e.type === 'needs_user'), 'no stall nudge or hand-over');
  ok(userMessages.length === 0, 'no wrap-up message was injected');
  const last = events.filter((e) => e.type === 'status').pop() as Extract<AgentEvent, { type: 'status' }>;
  ok(last.status === 'done' && last.message === 'Task finished' && runner.currentStatus === 'done' && events.some((e) => e.type === 'assistant' && /^Finished after 70 turns/.test(e.text)), `status ${last.status}: ${last.message}`);
} finally {
  mock.kill();
}

console.log(`unlimited: ${n} checks passed`);
