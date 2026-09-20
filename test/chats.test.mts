// ChatStore: the transcript format (header, You/Deskfish sections, step lines with a failed
// action, the memory pill, a hand-over, the status line, the end), parseTranscript, list newest
// first named by the first task, search with chat context across chats, dump/restore without
// duplicates, the loop's recall merging journal + chats, the no-hit error, delete all; each listed
// chat's outcome read from its tail (step 6B); the end line that carries a task's steps and tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { ChatStore, outcomeOf, parseTranscript } from '../src/agent/chats';
import { JournalStore } from '../src/agent/journal';
import { SelfStore, newSelfKey } from '../src/agent/self';
import { DEFAULT_SELF } from '../src/agent/seed';
import { AgentRunner } from '../src/agent/loop';
import { describeAction, type ComputerProvider } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLOCK = /\d{2}:\d{2}/;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-chats-'));
try {
  const store = new ChatStore(path.join(dir, 'chats'));
  ok(store.list().length === 0 && store.deleteAll() === 0, 'no directory yet → nothing listed');

  // ---------- transcript format ----------
  const t1 = store.start('Order 3 boxes of paper from Acme', { model: 'test-model', provider: 'mock' });
  ok(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2} - Order 3 boxes of paper from Acme\.md$/.test(path.basename(t1.file)), `named by date and first task: ${path.basename(t1.file)}`);
  ok(/^# Chat — \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\nmodel: test-model \(mock\)\n\n$/.test(fs.readFileSync(t1.file, 'utf8')), 'the header carries the start time and the model');
  t1.user('Order 3 boxes of paper from Acme');
  t1.action(1, 'left click at (10, 20)', true);
  t1.action(1, 'type "acme"', false);
  t1.action(2, 'press Return', true);
  // click_element writes what it hit, not just what was asked for: the transcript is where the user
  // (and a teacher reading it later) sees which control the words actually landed on.
  t1.action(2, describeAction({ type: 'click_element', query: '60 days late', hit: 'button at (1001, 445)' }), true);
  t1.action(3, describeAction({ type: 'click_element', query: 'accept all' }), false);
  t1.note('Remembered: Acme  orders need\na PO number');
  t1.needsUser('Please log in to Acme');
  t1.assistant('Ordered 3 boxes, reference #123.');
  t1.status('done · 2 steps');
  t1.end();
  const text = fs.readFileSync(t1.file, 'utf8');
  ok(new RegExp('\\n## You \\(\\d{2}:\\d{2}\\)\\n\\nOrder 3 boxes of paper from Acme\\n\\n').test(text) && new RegExp('\\n## Deskfish \\(\\d{2}:\\d{2}\\)\\n\\nOrdered 3 boxes, reference #123\\.\\n\\n').test(text), 'You / Deskfish sections with a clock');
  ok(text.includes('\n_step 1_: left click at (10, 20) · type "acme" (failed)\n\n_step 2_: press Return · click "60 days late" → button at (1001, 445)\n\n'), 'one step line per step, actions joined, the failed one marked; a click_element line names the control it hit');
  ok(text.includes('\n_step 3_: click "accept all" (failed)\n\n'), 'a click_element that clicked nothing is a failed step line, with no hit after it');
  ok(text.includes('\n> Remembered: Acme orders need a PO number\n\n') && text.includes('\n> **Deskfish needs you:** Please log in to Acme\n\n'), 'the memory pill (one line) and the hand-over');
  ok(text.includes('\n_done · 2 steps_\n\n') && /— chat ended \d{2}:\d{2} —\n$/.test(text), 'the status line and the end marker');
  const items = parseTranscript(text);
  ok(items.map((i) => i.kind).join(',') === 'user,actions,actions,actions,note,needs_user,assistant,status', `parseTranscript replays the blocks in order: ${items.map((i) => i.kind).join(',')}`);
  const st1 = items[1] as Extract<(typeof items)[number], { kind: 'actions' }>;
  ok(st1.step === 1 && st1.actions.length === 2 && st1.actions[1].failed && st1.actions[1].text === 'type "acme"' && !st1.actions[0].failed && (items[0] as any).at && CLOCK.test((items[0] as any).at), 'step, actions and the failed flag survive the round trip');

  // ---------- list: newest first, named by the first task ----------
  await sleep(20);
  const t2 = store.start('Book a table for two at Luigi', { model: 'm', provider: 'p' });
  t2.user('Book a table for two at Luigi');
  t2.assistant('Booked for 19:00 under the name Sam.');
  t2.end();
  fs.writeFileSync(path.join(store.dir, '2025-01-01 09-00 - Old task about printers.md'), '# Chat — 2025-01-01 09:00\n\nmodel: x (y)\n\n## You (09:00)\n\nOld task about printers\n\n## Deskfish (09:01)\n\nThe printer queue was cleared.\n\n— chat ended 09:02 —\n');
  const list = store.list();
  ok(list.length === 3 && list.map((c) => c.firstTask).join(' | ') === 'Book a table for two at Luigi | Order 3 boxes of paper from Acme | Old task about printers', `newest first, first task from the first You block: ${list.map((c) => c.firstTask).join(' | ')}`);
  ok(list[2].startedAt === '2025-01-01 09:00' && list[2].name.endsWith('Old task about printers.md') && list[0].bytes > 0, 'start time and name come from the file');
  ok(list[1].outcome === 'done' && list[0].outcome === undefined && list[2].outcome === undefined, `the outcome from each file's tail: a status line → done, none → unfinished (${list.map((c) => c.outcome ?? '-').join(', ')})`);
  const t3 = store.start('Fix "quotes" / slashes?! and a very long task name that goes on and on beyond forty-eight characters', { model: 'm', provider: 'p' });
  const slug = path.basename(t3.file).replace(/^\S+ \S+ - /, '').replace(/\.md$/, '');
  ok(!/["/?!]/.test(slug) && slug.length <= 48 && slug.startsWith('Fix quotes  slashes') && path.basename(store.start('   ', { model: 'm', provider: 'p' }).file).endsWith(' - chat.md'), `the slug is sanitised and cut at 48: "${slug}"`);
  const dup = store.start('Book a table for two at Luigi', { model: 'm', provider: 'p' });
  ok(path.basename(dup.file) !== path.basename(t2.file) && / \(2\)\.md$/.test(path.basename(dup.file)), `a second chat in the same minute with the same task gets a suffix: ${path.basename(dup.file)}`);

  // ---------- search ----------
  const s1 = store.search('queue cleared');
  ok(s1.ok && s1.message.startsWith('From your past chats (1 of 1 matching lines):\n') && s1.message.includes('- [2025-01-01 09:00 · Old task about printers] The printer queue was cleared.'), `a hit carries the chat's date and first task: ${s1.ok ? s1.message : s1.error}`);
  const s2 = store.search('boxes table', 10);
  ok(s2.ok && s2.message.includes('· Order 3 boxes of paper from Acme] Order 3 boxes') && s2.message.includes('· Book a table for two at Luigi] Book a table') && !s2.message.includes('# Chat'), 'search spans chats, skipping headers');
  const s3 = store.search('zzzzqq');
  ok(!s3.ok && s3.error === 'nothing in your past chats matches "zzzzqq"' && !store.search('ab').ok, 'no hit and a too-short query are errors');

  // ---------- dump / restore ----------
  const dump = store.dump();
  ok(dump.length === 6 && dump.every((d) => d.name.endsWith('.md') && d.text.startsWith('# Chat — ')) && store.restore(dump) === 0 && store.list().length === 6, 'dump has every transcript; restoring it writes nothing twice');
  const extra = { name: '2024-05-05 05-05 - Restored task.md', text: '# Chat — 2024-05-05 05:05\n\nmodel: a (b)\n\n## You (05:05)\n\nRestored task\n\n' };
  ok(store.restore([extra, { name: '../escape.md', text: 'x' }, { name: 'bad', text: 1 as unknown as string }]) === 1 && store.list().length === 7 && store.list().at(-1)?.firstTask === 'Restored task', 'restore writes new transcripts only, and never outside the directory');

  // ---------- the loop's recall merges journal + chats ----------
  const journal = new JournalStore(path.join(dir, 'journal.md'));
  journal.appendNote('Cleared the printer queue for Sam');
  const self = new SelfStore(path.join(dir, 'self.md'), newSelfKey());
  self.ensureSeed(DEFAULT_SELF);
  const png = (() => PNG.sync.write(new PNG({ width: 320, height: 200 })))();
  const computer: ComputerProvider = {
    name: 'static',
    async displaySize() { return { width: 320, height: 200 }; },
    async screenshot() { return { png, width: 320, height: 200 }; },
    async execute(a) { return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : { ok: true }; },
  };
  let turn = 0;
  const seen: Observation[] = [];
  const adapter = {
    name: 'scripted', start() {}, addUserMessage() {},
    async step(obs: Observation): Promise<ModelTurn> {
      seen.push(obs);
      turn++;
      if (turn === 1) return { text: '', actions: [{ type: 'recall', query: 'printer queue' }, { type: 'recall', query: 'table Luigi' }, { type: 'recall', query: 'zzzzqq' }], done: false };
      return { text: 'Found it.', actions: [], done: true };
    },
  } as unknown as ModelAdapter;
  const runner = new AgentRunner({ computer, adapter, maxSteps: 5, screenshotWidth: 320, settleMs: 0, journal, self, chats: store, onEvent: () => {} });
  await runner.run('What did I do about the printer?');
  const [r1, r2, r3] = seen[1].results;
  ok(r1.ok && r1.message!.startsWith('From your journal (1 of 1 entries):\n') && r1.message!.includes('note — Cleared the printer queue for Sam') && r1.message!.includes('\n\nFrom your past chats (') && r1.message!.includes('The printer queue was cleared.'), `recall merges the journal and past chats: ${r1.message}`);
  ok(r2.ok && !r2.message!.includes('From your journal') && r2.message!.startsWith('From your past chats (') && r2.message!.includes('· Book a table for two at Luigi] Book a table for two at Luigi'), `a chats-only hit still answers: ${r2.message}`);
  ok(!r3.ok && r3.error === 'nothing in your journal matches "zzzzqq"', `no hit anywhere → error: ${JSON.stringify(r3)}`);

  // ---------- delete all ----------
  ok(store.deleteAll() === 7 && store.list().length === 0 && fs.readdirSync(store.dir).filter((f) => f.endsWith('.md')).length === 0, 'deleteAll removes every transcript');

  // ---------- the end line with the task's counts ----------
  // The gateway writes `_done — Task finished · 16 steps · 471k tokens (61k fresh)_` (decision 127's E);
  // the outcome reader and the replay must still see a done chat in it.
  const endStore = new ChatStore(path.join(dir, 'end'));
  const te = endStore.start('Count the towers', { model: 'm', provider: 'p' });
  te.user('Count the towers');
  te.assistant('Six.');
  te.status('done — Task finished · 16 steps · 471k tokens (61k fresh)');
  te.end();
  const endText = fs.readFileSync(te.file, 'utf8');
  ok(endText.includes('\n_done — Task finished · 16 steps · 471k tokens (61k fresh)_\n\n'), 'the status line carries the counts');
  ok(outcomeOf(endText) === 'done' && endStore.list()[0]?.outcome === 'done', `outcomeOf still reads done from it: ${outcomeOf(endText)}`);
  const endItems = parseTranscript(endText);
  ok(endItems.at(-1)?.kind === 'status' && (endItems.at(-1) as any).text === 'done — Task finished · 16 steps · 471k tokens (61k fresh)', 'and the replay keeps the line whole');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`chats: ${n} checks passed`);
