// A message typed while she reflects: the loop refuses to inject it (say() → false, the adapter
// never sees it), the HeldMessage slot keeps it for afterwards (a second one joins the first),
// and a normal task still takes mid-task messages as before.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { AgentRunner } from '../src/agent/loop';
import { HeldMessage } from '../src/agent/held';
import { SelfStore, newSelfKey } from '../src/agent/self';
import { JournalStore } from '../src/agent/journal';
import type { ComputerProvider } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

// ---------- the slot ----------
{
  const h = new HeldMessage<{ name: string }>();
  ok(!h.pending && h.take() === undefined, 'empty slot');
  ok(h.add('first', [{ name: 'a.pdf' }]) === 'held' && h.pending, 'first message is held');
  ok(h.add('second') === 'joined', 'a second message joins the first');
  const got = h.take();
  ok(got?.text === 'first\n\nsecond' && got.attachments.length === 1 && got.attachments[0].name === 'a.pdf', `joined text and attachments kept: ${JSON.stringify(got)}`);
  ok(!h.pending && h.take() === undefined, 'take() empties the slot');
  h.add('x');
  h.clear();
  ok(!h.pending, 'clear() drops it (new chat, stop)');
}

// ---------- the loop ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-held-'));
const self = new SelfStore(path.join(dir, 'self.md'), newSelfKey());
const journal = new JournalStore(path.join(dir, 'journal.md'));
self.ensureSeed('I am a test fish.\n\n## How I work\n\n- carefully.\n\n## My story\n\nDay one.\n\n## People\n\n**Iman** — made me.');
const png = PNG.sync.write(new PNG({ width: 320, height: 200 }));
const computer: ComputerProvider = {
  name: 'fake',
  async displaySize() { return { width: 320, height: 200 }; },
  async screenshot() { return { png, width: 320, height: 200 }; },
  async execute(a) { return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : { ok: true }; },
};
const delivered: string[] = [];
let turn = 0;
let runner: AgentRunner;
let saidDuringReflection: boolean | undefined;
let saidDuringTask: boolean | undefined;
const adapter = {
  name: 'scripted',
  start() {},
  addUserMessage(t: string) { delivered.push(t); },
  async step(_obs: Observation): Promise<ModelTurn> {
    turn++;
    if (turn === 1) {
      // Mid-task: the person's message is a follow-up and must reach the model.
      saidDuringTask = runner.say('mid-task follow-up');
      return { text: 'working', actions: [{ type: 'wait', seconds: 0 }] };
    }
    if (turn === 3) {
      // Mid-reflection: refused; the controller holds it for afterwards.
      saidDuringReflection = runner.say('there is new code in github');
      return { text: 'thinking', actions: [{ type: 'wait', seconds: 0 }] };
    }
    return { text: 'done', actions: [], done: true };
  },
} as unknown as ModelAdapter;
runner = new AgentRunner({ computer, adapter, self, journal, maxSteps: 6, screenshotWidth: 320, settleMs: 0, onEvent: () => {} });

await runner.run('a task');
ok(saidDuringTask === true && delivered.includes('mid-task follow-up'), `a mid-task message is delivered: ${delivered.join(' | ').slice(0, 80)}`);

delivered.length = 0;
await runner.reflect();
ok(saidDuringReflection === false, 'say() during a reflection returns false');
ok(!delivered.some((t) => t.includes('there is new code in github')), `the adapter never saw the mid-reflection message: ${delivered.map((t) => t.slice(0, 40)).join(' | ')}`);
ok(runner.currentStatus === 'done' && !runner.reflecting, 'the reflection finished on its own');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`held: ${n} checks passed`);
