// Stop is immediate: it aborts the model call in flight (the adapter honours the AbortSignal it is
// handed), ends a loop-handled `wait` and the settle sleep at once, says "Stopping…" then "stopped"
// (never "error"), releases the display's input, and makes no further model call — until the next run.
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { AgentRunner } from '../src/agent/loop';
import type { ComputerProvider } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const png = PNG.sync.write(new PNG({ width: 320, height: 200 }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A model whose every turn takes `ms` unless the loop aborts it, and a computer that counts input releases. */
function harness(ms: number, turns: (t: number) => ModelTurn, settleMs = 0) {
  let releases = 0, calls = 0, aborted = false;
  const computer: ComputerProvider = {
    name: 'fake',
    async displaySize() { return { width: 320, height: 200 }; },
    async screenshot() { return { png, width: 320, height: 200 }; },
    async execute(a) { return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : { ok: true }; },
    async releaseInput() { releases++; return []; },
  };
  const adapter = {
    name: 'slow', start() {}, addUserMessage() {},
    step(_obs: Observation, signal?: AbortSignal) {
      calls++;
      const turn = turns(calls);
      return new Promise<ModelTurn>((resolve, reject) => {
        const t = setTimeout(() => resolve(turn), ms);
        signal?.addEventListener('abort', () => { aborted = true; clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });
    },
  } as unknown as ModelAdapter;
  const statuses: string[] = [];
  const runner = new AgentRunner({ computer, adapter, maxSteps: 10, screenshotWidth: 320, settleMs, onEvent: (e) => { if (e.type === 'status') statuses.push(`${e.status}${e.message ? `:${e.message}` : ''}`); } });
  return { runner, statuses, calls: () => calls, aborted: () => aborted, releases: () => releases };
}
const finished: ModelTurn = { text: 'done', actions: [], done: true };

// 1. Stop during a 3 s model call: aborted at once, Stopping… → stopped, input released, no further call
{
  const h = harness(3000, () => finished);
  const t0 = Date.now();
  const run = h.runner.run('t');
  await sleep(200);
  const releasesBefore = h.releases();
  h.runner.stop();
  await run;
  const took = Date.now() - t0;
  ok(took < 800 && h.runner.currentStatus === 'stopped', `a 3 s model call was stopped in ${took} ms (${h.runner.currentStatus})`);
  ok(h.aborted() && h.calls() === 1, 'the adapter saw the abort on its signal and was not called again');
  const iStopping = h.statuses.indexOf('running:Stopping…'), iStopped = h.statuses.findIndex((s) => s.startsWith('stopped'));
  ok(iStopping >= 0 && iStopped > iStopping && !h.statuses.some((s) => s.startsWith('error')), `status went Stopping… → stopped, never error: ${h.statuses.join(' | ')}`);
  ok(h.releases() > releasesBefore, `input released on stop (${h.releases()} releases in all)`);
}

// 2. Stop during a loop-handled 5 s wait; then a new run on the same runner is not stopped
{
  const h = harness(0, (t) => (t === 1 ? { text: '', actions: [{ type: 'wait', seconds: 5 }], done: false } : finished));
  const t0 = Date.now();
  const run = h.runner.run('t');
  await sleep(200);
  h.runner.stop();
  await run;
  const took = Date.now() - t0;
  ok(took < 800 && h.runner.currentStatus === 'stopped' && h.calls() === 1, `a 5 s wait was cut short in ${took} ms; no further model call (${h.calls()})`);
  await h.runner.run('again');
  ok(h.runner.currentStatus === 'done' && h.calls() === 2 && h.statuses.at(-1) === 'done:Task finished', `the next run starts clean: ${h.statuses.at(-1)}`);
}

// 3. Stop during a 4 s settle sleep after an action
{
  const h = harness(0, (t) => (t === 1 ? { text: '', actions: [{ type: 'click', x: 10, y: 10, button: 'left', count: 1 }], done: false } : finished), 4000);
  const t0 = Date.now();
  const run = h.runner.run('t');
  await sleep(200);
  h.runner.stop();
  await run;
  const took = Date.now() - t0;
  ok(took < 800 && h.runner.currentStatus === 'stopped' && h.calls() === 1, `a 4 s settle was cut short in ${took} ms; no further model call (${h.calls()})`);
}

console.log(`stop: ${n} checks passed`);
