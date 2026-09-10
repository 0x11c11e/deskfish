// Pause sequencing and stuck-input releases: "paused" is announced only after the current action
// finished and input was released; standby wakes on pause; releases happen at run start, at the
// gate, and after resume; what was held is reported as a `released` event.
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { AgentRunner, type AgentEvent } from '../src/agent/loop';
import type { ComputerProvider } from '../src/computer/types';
import type { ModelAdapter, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const png = (() => { const p = new PNG({ width: 320, height: 200 }); return PNG.sync.write(p); })();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A computer whose "type" takes a while, and which reports a held Alt on the first release only.
const timeline: string[] = [];
let releases = 0;
const computer: ComputerProvider = {
  name: 'slow',
  async displaySize() { return { width: 320, height: 200 }; },
  async screenshot() { return { png, width: 320, height: 200 }; },
  async execute(a) {
    if (a.type === 'type') { timeline.push('type:start'); await sleep(400); timeline.push('type:end'); }
    return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : { ok: true };
  },
  async releaseInput() { releases++; timeline.push(`release#${releases}`); return releases === 1 ? ['Alt_L', 'button 1'] : []; },
};

let turn = 0;
const adapter = {
  name: 'scripted', start() {}, addUserMessage() {},
  async step(_obs: Observation) {
    turn++;
    if (turn === 1) return { text: '', actions: [{ type: 'type', text: 'hello' }, { type: 'type', text: 'world' }] };
    if (turn === 2) return { text: '', actions: [{ type: 'wait_for', reason: 'a long standby', minutes: 60 }] };
    return { text: 'done', actions: [], done: true };
  },
} as unknown as ModelAdapter;

const events: AgentEvent[] = [];
const runner = new AgentRunner({ computer, adapter, maxSteps: 10, screenshotWidth: 320, settleMs: 0, standbyPollMs: 30, onEvent: (e) => { events.push(e); if (e.type === 'status') timeline.push(`status:${e.status}${e.message ? `:${e.message}` : ''}`); } });
const run = runner.run('t');

// Pause while the first "type" is in progress.
await sleep(150);
runner.pause('Paused — you have the desktop');
await sleep(50);
ok(runner.currentStatus === 'running' && timeline.includes('status:running:Pausing — finishing the current action…') && !timeline.some((t) => t.startsWith('status:paused')), `not yet paused while an action runs: ${timeline.join(' | ')}`);
await sleep(500);
const idxPaused = timeline.findIndex((t) => t.startsWith('status:paused'));
const idxTypeEnd = timeline.indexOf('type:end');
const idxRelease = timeline.indexOf('release#2');
ok(idxPaused > 0 && idxTypeEnd >= 0 && idxTypeEnd < idxRelease && idxRelease < idxPaused, `paused only after the action ended and input was released: ${timeline.join(' | ')}`);
ok(timeline.filter((t) => t === 'type:start').length === 1, 'the second action of the batch did not run while paused');
const rel = events.filter((e) => e.type === 'released') as Extract<AgentEvent, { type: 'released' }>[];
ok(rel.length === 1 && rel[0].reason === 'start' && rel[0].held.join(',') === 'Alt_L,button 1', `run start released what was held and reported it: ${JSON.stringify(rel)}`);

// Resume: another release, then the second type runs, then the standby starts.
runner.resume();
await sleep(700);
ok(timeline.indexOf('release#3') > idxPaused && timeline.filter((t) => t === 'type:start').length === 2, `release after resume, then the batch continued: ${timeline.join(' | ')}`);
ok(timeline.some((t) => t.startsWith('status:running:Standing by')), 'standby started');

// Pause during standby: the sleep wakes at once and "paused" follows quickly (not after the next poll only).
const before = Date.now();
runner.pause();
await sleep(200);
ok(runner.currentStatus === 'paused' && Date.now() - before < 400, `standby paused promptly (${runner.currentStatus})`);
runner.stop();
await run;
ok(runner.currentStatus === 'stopped', 'stopped from a paused standby');

console.log(`pause: ${n} checks passed`);
