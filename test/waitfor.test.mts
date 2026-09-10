// wait_for (standby): a computer whose frames the test controls + a scripted model. Wakes on
// change-and-settle, waits out the time when asked, ignores small animation and changes outside
// the region, stops at once on Stop, never counts as a repeated action for the stall detector,
// and announces itself with a `standby` event for the chat.
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { AgentRunner, type AgentEvent } from '../src/agent/loop';
import { waitForAction } from '../src/agent/actions';
import { frameDiff, scalePng } from '../src/image/resize';
import { describeAction } from '../src/computer/types';
import type { ComputerProvider } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

/** 320×200 frame: dark background; a bright box whose position is `variant`; a small "spinner" dot when `tick` is set; a "clock" pixel when `clock` is set. */
function frame(variant: number, tick = 0, clock = 0): Buffer {
  const png = new PNG({ width: 320, height: 200 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 30; png.data[i + 1] = 34; png.data[i + 2] = 40; png.data[i + 3] = 255; }
  const box = (x0: number, y0: number, w: number, h: number, v: number) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * 320 + x) * 4; png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; } };
  box(20 + variant * 40, 40, 100, 80, 230);
  if (tick) box(280 + (tick % 2) * 10, 170, 8, 8, 255); // a dot that hops: animation
  if (clock) box(300, 10, 2, 2, 255); // a couple of pixels: below the change threshold
  return PNG.sync.write(png);
}

// frameDiff with a region
{
  const a = scalePng(frame(0), 320), b = scalePng(frame(2), 320);
  ok(frameDiff(a, b) > 0.05, 'moved box changes the whole-frame diff');
  ok(frameDiff(a, b, { x0: 0.8, y0: 0.8, x1: 1, y1: 1 }) === 0, 'nothing changed in the bottom-right region');
  ok(frameDiff(a, b, { x0: 0, y0: 0, x1: 0.6, y1: 0.7 }) > 0.1, 'the box region sees it, proportionally more');
}

// parser
{
  const a = waitForAction({ reason: ' the upload ', minutes: 500, until: 'time', region: [10, 20, 30, 40] }) as any;
  ok(a.type === 'wait_for' && a.reason === 'the upload' && a.minutes === 120 && a.until === 'time' && a.region.w === 30, 'parses and caps minutes');
  const b = waitForAction({ minutes: 0.01 }) as any;
  ok(b.minutes === 0.5 && b.until === 'change' && b.reason && !b.region, 'floors minutes, defaults');
  ok(describeAction(a).startsWith('stand by up to 120 min: the upload'), `describe: ${describeAction(a)}`);
}

type Script = (turn: number, obs: Observation) => ModelTurn;
function run(frames: () => Buffer, script: Script) {
  const computer: ComputerProvider = {
    name: 'fake',
    async displaySize() { return { width: 320, height: 200 }; },
    async screenshot() { return { png: frames(), width: 320, height: 200 }; },
    async execute(a) { return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : { ok: true }; },
  };
  const results: string[] = [];
  const events: AgentEvent[] = [];
  let turn = 0;
  const adapter = {
    name: 'scripted', start() {}, addUserMessage() {},
    async step(obs: Observation) { turn++; for (const r of obs.results) if (r.message) results.push(r.message); return script(turn, obs); },
  } as unknown as ModelAdapter;
  const runner = new AgentRunner({ computer, adapter, maxSteps: 20, screenshotWidth: 320, settleMs: 0, standbyPollMs: 40, onEvent: (e) => { events.push(e); } });
  return { runner, results, events };
}

// 1. until "change": the screen changes after a few polls and holds → wakes early with a fresh screenshot
{
  let polls = 0;
  const t0 = Date.now();
  const { runner, results, events } = run(() => { polls++; return frame(polls > 6 ? 2 : 0); }, (t) =>
    t === 1 ? { text: '', actions: [{ type: 'wait_for', reason: 'the page to load', minutes: 0.05, until: 'change' }] } : { text: 'done', actions: [], done: true });
  await runner.run('t');
  const took = Date.now() - t0;
  ok(results.length === 1 && /changed \(about \d+% of it\) and has settled/.test(results[0]), `wakes on change+settle: ${results[0]}`);
  ok(took < 2500, `woke early (${took} ms of a 3 s wait)`);
  ok(events.some((e) => e.type === 'status' && /Standing by — the page to load · 0:0\d left/.test(e.message ?? '')), 'status row says Standing by with time left');
  ok(events.some((e) => e.type === 'action' && e.action.type === 'wait_for' && e.result.ok), 'action event carries the result');
  const sb = events.find((e) => e.type === 'standby') as Extract<AgentEvent, { type: 'standby' }> | undefined;
  ok(!!sb && sb.reason === 'the page to load' && sb.until === 'change' && Math.abs(sb.endsAt - (t0 + 3000)) < 1500, `standby event announces the wait for the chat: ${JSON.stringify(sb)}`);
  const iS = events.findIndex((e) => e.type === 'standby'), iA = events.findIndex((e) => e.type === 'action' && e.action.type === 'wait_for');
  ok(iS >= 0 && iA > iS, 'standby event comes before its result');
}

// 2. until "time": waits the whole time even though the screen changed
{
  let polls = 0;
  const t0 = Date.now();
  const { runner, results } = run(() => { polls++; return frame(polls > 3 ? 1 : 0); }, (t) =>
    t === 1 ? { text: '', actions: [{ type: 'wait_for', reason: 'five seconds', minutes: 0.02, until: 'time' }] } : { text: 'done', actions: [], done: true });
  await runner.run('t');
  const took = Date.now() - t0;
  ok(results.length === 1 && /Stood by .* as asked; time is up\. The screen changed meanwhile/.test(results[0]), `time mode reports: ${results[0]}`);
  ok(took >= 1100, `waited the full 1.2 s (${took} ms)`);
}

// 3. large animated content (a video, a page still laying out): frames keep changing → never "settled", reported at the deadline
{
  let polls = 0;
  const { runner, results } = run(() => { polls++; return frame(polls % 2 ? 3 : 0); }, (t) =>
    t === 1 ? { text: '', actions: [{ type: 'wait_for', reason: 'processing', minutes: 0.01 }] } : { text: 'done', actions: [], done: true });
  await runner.run('t');
  ok(results.length === 1 && /kept changing the whole time/.test(results[0]), `never settles: ${results[0]}`);
}

// 4. a small spinner and a ticking clock are below the threshold → "nothing changed"
{
  let polls = 0;
  const { runner, results } = run(() => { polls++; return frame(0, polls, polls % 2); }, (t) =>
    t === 1 ? { text: '', actions: [{ type: 'wait_for', reason: 'a reply', minutes: 0.01 }] } : { text: 'done', actions: [], done: true });
  await runner.run('t');
  ok(results.length === 1 && /nothing changed on the screen; time is up/.test(results[0]), `small spinner and clock ignored: ${results[0]}`);
}

// 5. region: the box moves, but the watched area is elsewhere → nothing changed in the watched area
{
  let polls = 0;
  const { runner, results } = run(() => { polls++; return frame(polls > 3 ? 2 : 0); }, (t) =>
    t === 1 ? { text: '', actions: [{ type: 'wait_for', reason: 'the status badge', minutes: 0.01, until: 'change', region: { x: 250, y: 150, w: 70, h: 50 } }] } : { text: 'done', actions: [], done: true });
  await runner.run('t');
  ok(results.length === 1 && /nothing changed on the screen in the watched area/.test(results[0]), `region respected: ${results[0]}`);
}

// 6. Stop ends a long standby at once
{
  const { runner, events } = run(() => frame(0), (t) =>
    t === 1 ? { text: '', actions: [{ type: 'wait_for', reason: 'an hour', minutes: 60 }] } : { text: 'done', actions: [], done: true });
  const t0 = Date.now();
  const p = runner.run('t');
  setTimeout(() => runner.stop(), 150);
  await p;
  ok(runner.currentStatus === 'stopped' && Date.now() - t0 < 1500, `stopped promptly (${Date.now() - t0} ms, ${runner.currentStatus})`);
  ok(!events.some((e) => e.type === 'action' && e.action.type === 'wait_for'), 'no result reported for a stopped standby');
}

// 7. repeated standbys on an unchanged screen are not a stall (no nudge, no hand-over)
{
  const { runner, events } = run(() => frame(0), (t) =>
    t <= 4 ? { text: '', actions: [{ type: 'wait_for', reason: 'the timer', minutes: 0.005, until: 'time' }] } : { text: 'done', actions: [], done: true });
  await runner.run('t');
  ok(runner.currentStatus === 'done' && !events.some((e) => e.type === 'needs_user'), 'four standbys in a row: no stall hand-over');
}

console.log(`wait_for: ${n} checks passed`);
