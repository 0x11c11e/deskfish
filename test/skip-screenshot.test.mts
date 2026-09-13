// observe() only recaptures the screen when the turn before it could have changed it. A turn
// that only ran passive tools (recall, read_docs, remember, …) reuses the last frame instead of
// paying for another capture/scale — the UI still gets a screenshot event, just the same image.
// ask_user and wait_for are passive tools too, but each is its own exception: the screen can
// change while the loop isn't acting (a human takeover, time passing during a standby), so a
// turn containing only one of those must still force a fresh capture, never the stale one from
// before the handover or the standby.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { AgentRunner, type AgentEvent } from '../src/agent/loop';
import { JournalStore } from '../src/agent/journal';
import type { ComputerProvider } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A frame whose content depends on `v`, so two captures can be told apart by their bytes alone —
 * standing in for a screen that keeps changing (a human acting on it, time passing). */
function frame(v: number): Buffer {
  const png = new PNG({ width: 320, height: 200 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 20; png.data[i + 1] = 20; png.data[i + 2] = 20; png.data[i + 3] = 255; }
  const g = v % 256;
  for (let y = 40; y < 120; y++) for (let x = 20; x < 120; x++) { const i = (y * 320 + x) * 4; png.data[i] = g; png.data[i + 1] = g; png.data[i + 2] = g; }
  return PNG.sync.write(png);
}

/** A computer that hands out a fresh, distinct frame every time screenshot() is called. */
function makeChangingComputer() {
  let counter = 0;
  let captures = 0;
  const computer: ComputerProvider = {
    name: 'fake',
    async displaySize() { return { width: 320, height: 200 }; },
    async screenshot() { captures++; return { png: frame(counter++), width: 320, height: 200 }; },
    async execute(a) { return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : { ok: true }; },
    async releaseInput() { return []; },
  };
  return { computer, captures: () => captures };
}

// --- Case 1: an all-passive turn (recall only) reuses the frame; a real action forces a capture.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-skipshot-'));
  const journal = new JournalStore(path.join(dir, 'journal.md'));
  const png = PNG.sync.write(new PNG({ width: 320, height: 200 }));
  let captures = 0;
  const computer: ComputerProvider = {
    name: 'fake',
    async displaySize() { return { width: 320, height: 200 }; },
    async screenshot() { captures++; return { png, width: 320, height: 200 }; },
    async execute(a) { return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : { ok: true }; },
  };

  const screenshotEvents: number[] = [];
  let turn = 0;
  const adapter: ModelAdapter = {
    name: 'scripted',
    start() {},
    addUserMessage() {},
    async step(_obs: Observation): Promise<ModelTurn> {
      turn++;
      if (turn === 1) return { text: 'looking something up', actions: [{ type: 'recall', query: 'anything' }] };
      if (turn === 2) return { text: 'now acting', actions: [{ type: 'wait', seconds: 0 }] };
      return { text: 'done', actions: [], done: true };
    },
  };

  const runner = new AgentRunner({
    computer,
    adapter,
    maxSteps: 10,
    screenshotWidth: 320,
    settleMs: 0,
    journal,
    onEvent: (e) => { if (e.type === 'screenshot') screenshotEvents.push(e.step); },
  });

  await runner.run('a task with one passive turn then one real one');

  ok(captures === 2, `only 2 real captures for 3 turns (initial + after the real 'wait' turn), got ${captures}`);
  ok(screenshotEvents.length === 3, `the UI still sees a screenshot event for every turn (3), got ${screenshotEvents.length}`);
}

// --- Case 2: a turn whose only action is ask_user still forces a fresh capture. Without it, the
// model would be shown the frame from before the handover even though the human had the desktop.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-skipshot-'));
  const journal = new JournalStore(path.join(dir, 'journal.md'));
  const { computer, captures } = makeChangingComputer();

  const shots: string[] = [];
  let turn = 0;
  const adapter: ModelAdapter = {
    name: 'scripted',
    start() {},
    addUserMessage() {},
    async step(_obs: Observation): Promise<ModelTurn> {
      turn++;
      if (turn === 1) return { text: '', actions: [{ type: 'ask_user', reason: 'need a hand' }] };
      return { text: 'done', actions: [], done: true };
    },
  };

  const runner = new AgentRunner({
    computer, adapter, maxSteps: 10, screenshotWidth: 320, settleMs: 0, journal,
    onEvent: (e) => { if (e.type === 'screenshot') shots.push(e.jpegBase64); },
  });
  const run = runner.run('a task that hands over once');
  await sleep(50);
  ok(runner.currentStatus === 'paused', `paused waiting on ask_user, got ${runner.currentStatus}`);
  runner.resume();
  await run;

  ok(captures() >= 2, `at least 2 real captures (initial + after the hand-over), got ${captures()}`);
  ok(shots.length === 2, `2 screenshot events (initial + after the ask_user-only turn), got ${shots.length}`);
  ok(shots[0] !== shots[1], 'the frame shown after the hand-over is a fresh capture, not the pre-handover one');
}

// --- Case 3: a turn whose only action is wait_for still forces a fresh capture. Without it, the
// model would be shown the pre-standby frame even though standby's whole job is to wait for the
// screen to change (or time to pass) before the model looks again.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-skipshot-'));
  const journal = new JournalStore(path.join(dir, 'journal.md'));
  const { computer, captures } = makeChangingComputer();

  const shots: string[] = [];
  let turn = 0;
  const adapter: ModelAdapter = {
    name: 'scripted',
    start() {},
    addUserMessage() {},
    async step(_obs: Observation): Promise<ModelTurn> {
      turn++;
      if (turn === 1) return { text: '', actions: [{ type: 'wait_for', reason: 'something to finish', minutes: 0.005, until: 'time' }] };
      return { text: 'done', actions: [], done: true };
    },
  };

  const runner = new AgentRunner({
    computer, adapter, maxSteps: 10, screenshotWidth: 320, settleMs: 0, standbyPollMs: 20, journal,
    onEvent: (e) => { if (e.type === 'screenshot') shots.push(e.jpegBase64); },
  });
  await runner.run('a task that stands by once');

  ok(captures() >= 2, `at least 2 real captures (initial + after the standby), got ${captures()}`);
  ok(shots.length === 2, `2 screenshot events (initial + after the wait_for-only turn), got ${shots.length}`);
  ok(shots[0] !== shots[1], 'the frame shown after standby is a fresh capture, not the pre-standby one');
}

console.log(`skip-screenshot: ${n} checks passed`);
