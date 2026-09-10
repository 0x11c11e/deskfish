// The stall detector (v2): a stall is the same action batch repeated while the screen does not
// measurably change — a nudge on the first trigger, a hand-over on the second, then resume and
// carry on. Scrolling a page that really scrolls and ticking a form's boxes are not stalls. Plus the
// optional cost budget: a warning at 80% and a wrap-up at 100%, from a list price or a reported cost.
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { AgentRunner, type AgentEvent, type AgentRunnerOptions } from '../src/agent/loop';
import { frameDiff, scalePng } from '../src/image/resize';
import type { ComputerProvider } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

const W = 320, H = 200; // the change thumbnail is 320 wide too: 64,000 pixels, so an 8×8 tick is 0.1% of them (threshold 0.3%)
/** Dark background; a bright "window" whose position is `variant`; `ticks` bright 8×8 checkboxes along the bottom. */
function frame(variant: number, ticks = 0): Buffer {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 30; png.data[i + 1] = 34; png.data[i + 2] = 40; png.data[i + 3] = 255; }
  const box = (x0: number, y0: number, w: number, h: number, v: number) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * W + x) * 4; png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; } };
  box(20 + variant * 40, 40, 100, 80, 230);
  for (let t = 0; t < ticks; t++) box(40 + t * 40, 160, 8, 8, 255);
  return PNG.sync.write(png);
}

// 1. frameDiff: the pointer crosshair is not a change; a moved window is; one tick is real but below the threshold
{
  const a = scalePng(frame(0), W);
  ok(frameDiff(a, scalePng(frame(0), W, 80, { x: 100, y: 100 })) === 0 && frameDiff(a, scalePng(frame(2), W)) > 0.05, 'crosshair ignored (0), moved window seen (>5%)');
  const tick = frameDiff(a, scalePng(frame(0, 1), W));
  ok(tick > 0 && tick < 0.003, `one ticked 8×8 box measures ${(tick * 100).toFixed(2)}%: real, and below the 0.3% stall threshold`);
}

type Script = (turn: number, obs: Observation) => ModelTurn;
function harness(frames: () => Buffer, script: Script, opts: { hook?: (e: AgentEvent) => void; runner?: Partial<AgentRunnerOptions> } = {}) {
  const computer: ComputerProvider = {
    name: 'fake',
    async displaySize() { return { width: W, height: H }; },
    async screenshot() { return { png: frames(), width: W, height: H }; },
    async execute(a) { return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : { ok: true }; },
  };
  const events: AgentEvent[] = [];
  const notes: { turn: number; note: string }[] = [];
  const userMessages: string[] = [];
  let turn = 0;
  const adapter = {
    name: 'scripted', start() {}, addUserMessage(t: string) { userMessages.push(t); },
    async step(obs: Observation) { turn++; if (obs.note) notes.push({ turn, note: obs.note }); return script(turn, obs); },
  } as unknown as ModelAdapter;
  const runner = new AgentRunner({ computer, adapter, maxSteps: 30, screenshotWidth: W, settleMs: 0, onEvent: (e) => { events.push(e); opts.hook?.(e); }, ...opts.runner });
  const nudges = () => notes.filter((x) => /repeated the same actions/.test(x.note));
  const handOvers = () => events.filter((e) => e.type === 'needs_user') as Extract<AgentEvent, { type: 'needs_user' }>[];
  return { runner, events, notes, userMessages, calls: () => turn, nudges, handOvers };
}
const click = (x: number, y: number): ModelTurn => ({ text: '', actions: [{ type: 'click', x, y, button: 'left', count: 1 }], done: false });
const done: ModelTurn = { text: 'done', actions: [], done: true };

// 2. static screen + the same click every turn → nudge, then hand-over at step 7; the user changes the screen and hands back; done
{
  let variant = 0, handedOver = false;
  const h = harness(() => frame(variant), () => (handedOver ? done : click(100, 100)), {
    hook: (e) => { if (e.type === 'needs_user') { handedOver = true; setTimeout(() => { variant = 1; h.runner.resume(); }, 30); } },
  });
  await h.runner.run('t');
  ok(h.nudges().length === 1 && h.nudges()[0].turn === 5, `one nudge, delivered with the observation after the fourth identical batch (turn ${h.nudges()[0]?.turn})`);
  ok(h.handOvers().length === 1 && h.handOvers()[0].step === 7 && /I seem to be stuck/.test(h.handOvers()[0].reason), `hand-over at step 7: ${h.handOvers()[0]?.reason}`);
  ok(h.events.some((e) => e.type === 'status' && e.status === 'paused' && /^Waiting for you/.test(e.message ?? '')) && h.notes.some((x) => x.turn === 8 && /handed it back/.test(x.note)), 'paused while waiting, then the model was told the user handed back');
  ok(h.runner.currentStatus === 'done' && h.calls() === 8, `resumed on a changed screen and ended done after ${h.calls()} turns`);
}

// 3. identical "scroll down ×3" batches while the page really scrolls (the frame alternates) → no nudge, no hand-over
{
  let shots = 0;
  const h = harness(() => frame(shots++ % 2 ? 2 : 0), (t) => (t <= 8 ? { text: '', actions: [{ type: 'scroll', direction: 'down', amount: 3 }], done: false } : done));
  await h.runner.run('t');
  ok(h.nudges().length === 0, 'eight identical scrolls on a page that scrolls: no nudge');
  ok(h.handOvers().length === 0 && h.runner.currentStatus === 'done', 'no hand-over, ended done');
}

// 4. a form: six clicks ticking different boxes (0.1% each), then the same "Next" button six times while the page changes → no stall
{
  let ticks = 0, page = 0;
  const h = harness(() => frame(page, ticks), (t) => {
    if (t <= 6) { ticks = t; return click(44 + (t - 1) * 40, 164); }
    if (t <= 12) { page = t % 3; return click(300, 20); }
    return done;
  });
  await h.runner.run('t');
  ok(h.nudges().length === 0 && h.calls() === 13, `ticking boxes below the change threshold, then Next on a changing page: no nudge (${h.calls()} turns)`);
  ok(h.handOvers().length === 0 && h.runner.currentStatus === 'done', 'no hand-over, ended done');
}

// 5. cost budget $1.20 at $0.50 a turn from the list price → warned after turn 2, wrapped up after turn 3, four calls in all
{
  const usage = { input: 250_000, output: 250_000 };
  const h = harness(() => frame(0), (t) => ({ text: t === 4 ? 'summary' : '', actions: [{ type: 'mouse_move', x: t * 30, y: 50 }], done: false, usage }), {
    runner: { budgetUsd: 1.2, price: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
  });
  await h.runner.run('t');
  ok(h.notes.some((x) => x.turn === 3 && /used about 8\d% of this task's cost budget \(\$1\.00 of \$1\.20\)/.test(x.note)), 'the 80% warning came with the third turn');
  ok(h.userMessages.length === 1 && /cost budget \(\$1\.20\) is used up \(\$1\.50 so far\)/.test(h.userMessages[0]) && h.calls() === 4, `one wrap-up message after the third turn, four calls (${h.calls()})`);
  const last = h.events.filter((e) => e.type === 'status').pop() as Extract<AgentEvent, { type: 'status' }>;
  ok(last.status === 'done' && /^Stopped at the cost budget \(\$1\.20\)/.test(last.message ?? '') && h.events.some((e) => e.type === 'assistant' && e.text === 'summary'), `ended done with the summary: ${last.message}`);
}

// 6. the same budget from a provider-reported cost (usage.costUsd), no list price
{
  const h = harness(() => frame(0), (t) => ({ text: '', actions: [{ type: 'mouse_move', x: t * 30, y: 50 }], done: false, usage: { input: 1, output: 1, costUsd: 0.5 } }), { runner: { budgetUsd: 1.2 } });
  await h.runner.run('t');
  const usages = h.events.filter((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>[];
  ok(h.calls() === 4 && h.runner.currentStatus === 'done' && usages.length === 4 && usages.every((u) => u.costUsd === 0.5), `a reported cost works without a price; every usage event carries it (${h.calls()} calls)`);
}

console.log(`stall: ${n} checks passed`);
