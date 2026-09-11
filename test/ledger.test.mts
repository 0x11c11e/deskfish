// The ledger: every `ledgerEvery` steps the loop asks her for a ledger, announces it, restarts the
// adapter's conversation from task + ledger (+ what the user said meanwhile), and takes a fresh
// look. Off by default; never inside a reflection; the first message after a restart carries the
// observation note.
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { AgentRunner, type AgentEvent } from '../src/agent/loop';
import { continuationTask, ledgerPrompt } from '../src/agent/prompts';
import type { ComputerProvider } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

function frame(k: number): Buffer {
  const png = new PNG({ width: 320, height: 200 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 30; png.data[i + 1] = 34; png.data[i + 2] = 40; png.data[i + 3] = 255; }
  for (let y = 40; y < 140; y++) for (let x = 20 + (k % 4) * 60; x < 120 + (k % 4) * 60; x++) { const i = (y * 320 + x) * 4; png.data[i] = 230; png.data[i + 1] = 230; png.data[i + 2] = 230; }
  return PNG.sync.write(png);
}
let shots = 0;
const computer: ComputerProvider = {
  name: 'fake',
  async displaySize() { return { width: 320, height: 200 }; },
  async screenshot() { shots++; return { png: frame(shots), width: 320, height: 200 }; },
  async execute(a) { return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : { ok: true }; },
};

/** A recording adapter: counts conversations, keeps the user messages, answers the ledger prompt with a ledger. */
function adapter(totalSteps: number, onTurn?: (turn: number) => void) {
  const starts: string[] = [];
  const userMessages: string[] = [];
  const notes: (string | undefined)[] = [];
  let turn = 0;
  let awaitingLedger = false;
  const a = {
    name: 'rec',
    start(task: string) { starts.push(task); },
    addUserMessage(t: string) { userMessages.push(t); if (t.startsWith('Ledger time.')) awaitingLedger = true; },
    async step(obs: Observation): Promise<ModelTurn> {
      notes.push(obs.note);
      if (awaitingLedger) {
        awaitingLedger = false;
        return { text: `Goal: click through the boxes.\nDone: ${turn} clicks, box ids 1-${turn}.\nLeft: the rest.\nState: box page, nothing pending.\nWatch out: nothing.`, actions: [] };
      }
      turn++;
      onTurn?.(turn);
      if (turn > totalSteps) return { text: 'done', actions: [], done: true };
      return { text: '', actions: [{ type: 'click', x: 10 + (turn % 20) * 10, y: 50 + (turn % 5) * 10, button: 'left', count: 1 }] };
    },
  } as unknown as ModelAdapter;
  return { a, starts, userMessages, notes, turns: () => turn };
}

// Prompt helpers.
ok(ledgerPrompt(40).includes('40 steps') && /Goal:.*Done:.*Left:.*State:.*Watch out:/s.test(ledgerPrompt(40)), 'ledger prompt names the headings');
const cont = continuationTask('Buy milk', 'Goal: milk', 40, ['use the corner shop']);
ok(cont.startsWith('Buy milk') && cont.includes('40 steps into this task') && cont.includes('Ledger:\nGoal: milk') && cont.includes('- use the corner shop'), `continuation task carries task, ledger and follow-ups: ${cont.slice(0, 80)}`);

// 1. 90 steps with ledgerEvery 40 → ledgers after 40 and 80, three conversations, events, fresh look each time.
{
  let runner!: AgentRunner;
  const rec = adapter(90, (t) => { if (t === 5) runner.say('skip the red ones'); });
  const events: AgentEvent[] = [];
  runner = new AgentRunner({ computer, adapter: rec.a, maxSteps: 120, screenshotWidth: 320, settleMs: 0, ledgerEvery: 40, onEvent: (e) => events.push(e) });
  await runner.run('Click through the boxes');
  ok(runner.currentStatus === 'done', `finished (${runner.currentStatus})`);
  const ledgers = events.filter((e) => e.type === 'ledger') as Extract<AgentEvent, { type: 'ledger' }>[];
  ok(ledgers.length === 2 && ledgers[0].step === 40 && ledgers[1].step === 80, `two ledgers at 40 and 80: ${ledgers.map((l) => l.step)}`);
  ok(ledgers[0].text.startsWith('Goal: click through the boxes.') && ledgers[0].text.includes('Done: 40 clicks'), `the ledger is her text: ${ledgers[0].text.slice(0, 60)}`);
  ok(rec.starts.length === 3, `three conversations (initial + two restarts): ${rec.starts.length}`);
  ok(rec.starts[1].startsWith('Click through the boxes') && rec.starts[1].includes('40 steps into this task') && rec.starts[1].includes('Done: 40 clicks'), 'the restart task carries the original task and the ledger');
  ok(rec.starts[1].includes('- skip the red ones') || rec.starts[2].includes('- skip the red ones'), 'what the user said mid-task travels with the restart');
  ok(rec.userMessages.filter((m) => m.startsWith('Ledger time.')).length === 2, 'the ledger prompt was sent twice');
  ok(rec.notes.some((t) => t?.includes('Continuing after 40 steps from your ledger')), 'the fresh look after the cut carries a continuation note');
  ok(rec.notes.some((t) => t?.includes('Continuing after 40 steps') && /^It is \w+day, \d{4}-\d{2}-\d{2} \d{2}:\d{2} local time/.test(t)), 'the fresh look after the cut carries the clock too (without it she dates things by older notes)');
  ok(rec.turns() === 91, `model took 91 turns (90 actions + done): ${rec.turns()}`);
  ok(events.filter((e) => e.type === 'status' && e.status === 'done').length === 1, 'one done');
}

// 2. ledgerEvery 0 (default) → never.
{
  const rec = adapter(50);
  const events: AgentEvent[] = [];
  const runner = new AgentRunner({ computer, adapter: rec.a, maxSteps: 60, screenshotWidth: 320, settleMs: 0, onEvent: (e) => events.push(e) });
  await runner.run('t');
  ok(rec.starts.length === 1 && !events.some((e) => e.type === 'ledger'), 'no ledger when the option is off');
}

// 3. Stop during the ledger turn ends the run cleanly, no restart.
{
  const rec = adapter(50);
  const events: AgentEvent[] = [];
  const runner = new AgentRunner({ computer, adapter: rec.a, maxSteps: 60, screenshotWidth: 320, settleMs: 0, ledgerEvery: 10, onEvent: (e) => { events.push(e); if (e.type === 'ledger') runner.stop(); } });
  await runner.run('t');
  ok(runner.currentStatus === 'stopped' && rec.starts.length === 1, `stop right after the ledger: no restart (${runner.currentStatus}, ${rec.starts.length} start)`);
}

console.log(`ledger: ${n} checks passed`);
