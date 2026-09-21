// A batch that could not have changed the screen earns no new screenshot: the loop takes none, the
// observation carries no image, and both wires say so in one sentence instead of sending the same
// picture again. 41 of the 89 steps of a real task were a find or a read_page and carried a fresh
// frame of a screen nobody had touched (decision 123). Here: which batches keep the frame and which
// do not, that the step counter advances either way, and that the cached prefix stays byte-stable.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import { AgentRunner, type AgentEvent } from '../src/agent/loop';
import { AnthropicAdapter } from '../src/agent/adapters/anthropic';
import { OpenAICompatAdapter } from '../src/agent/adapters/openaiCompat';
import { changesScreen, describeAction, type ComputerAction, type ComputerProvider } from '../src/computer/types';
import { SCREEN_UNCHANGED_NOTE, type ModelAdapter, type ModelTurn, type Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

// ---------- the predicate ----------
const passive: ComputerAction[] = [
  { type: 'find', query: 'x' },
  { type: 'read_page', scope: 'text' },
  { type: 'zoom', x: 1, y: 1 },
  { type: 'read_docs', page: 'memory' },
  { type: 'recall', query: 'x' },
  { type: 'read_playbook', title: 'x' },
  { type: 'remember', text: 'x' },
  { type: 'forget', query: 'x' },
  { type: 'note', text: 'x' },
  { type: 'revise_self', section: 'a', text: 'b' },
  { type: 'restore_self' },
  { type: 'self_history' },
  { type: 'archive_story', section: 'My story', startsWith: 'a' },
  { type: 'save_playbook', title: 'a', text: 'b' },
  { type: 'cursor_position' },
  { type: 'screenshot' },
];
const active: ComputerAction[] = [
  { type: 'click', x: 1, y: 1, button: 'left', count: 1 },
  { type: 'click_element', query: 'Sign in' },
  { type: 'scroll_to', query: 'Accounts' },
  { type: 'select_option', query: 'Country', option: 'Norway' },
  { type: 'type', text: 'hello' },
  { type: 'key', keys: ['Return'] },
  { type: 'scroll', direction: 'down', amount: 3 },
  { type: 'drag', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } },
  { type: 'mouse_move', x: 1, y: 1 },
  { type: 'wait', seconds: 1 },
  { type: 'wait_for', reason: 'a page', minutes: 1, until: 'change' },
  { type: 'run_command', command: 'ls' },
  { type: 'ask_user', reason: 'a code' },
  // The second knock: it hands over a form rather than the desktop, and a person types into the
  // page while it waits — so it is on ask_user's side of the line, and a fresh frame follows it.
  { type: 'ask_fill', reason: 'Sign in to LinkedIn', fields: [{ label: 'Password', query: 'password field', secret: true }] },
  { type: 'focus', query: 'password field' },
];
ok(passive.every((a) => !changesScreen(a)), `${passive.length} passive actions change nothing (screenshot among them: the loop still frames a batch that asks for one, below)`);
ok(active.every(changesScreen), `${active.length} actions that can change the screen keep theirs (run_command opens windows; wait_for, ask_user and ask_fill watch the world act; focus moves the caret)`);

// ---------- the loop ----------
const W = 320, H = 200;
function frame(v: number): Buffer {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 20 + v * 40; png.data[i + 1] = 30; png.data[i + 2] = 40; png.data[i + 3] = 255; }
  return PNG.sync.write(png);
}

type Script = (turn: number) => ModelTurn;
function harness(script: Script) {
  let shots = 0;
  let variant = 0;
  const computer: ComputerProvider = {
    name: 'counting',
    async displaySize() { return { width: W, height: H }; },
    async screenshot() { shots++; return { png: frame(variant++ % 2), width: W, height: H }; },
    async execute(a) {
      if (a.type === 'cursor_position') return { ok: true, cursor: { x: 1, y: 1 } };
      if (a.type === 'find' || a.type === 'read_page') return { ok: true, page: { url: 'https://example.com/', title: 'T', elements: [{ role: 'button', name: 'Sign in', x: 40, y: 50, w: 10, h: 10, visible: true, score: 100 }] } };
      if (a.type === 'run_command') return { ok: true, command: { stdout: 'hi\n', stderr: '', exit: 0, timedOut: false, ms: 1 } };
      return { ok: true };
    },
  };
  const events: AgentEvent[] = [];
  const seen: { turn: number; image: boolean }[] = [];
  let turn = 0;
  const adapter = {
    name: 'scripted', start() {}, addUserMessage() {},
    async step(obs: Observation) { seen.push({ turn, image: !!obs.image }); turn++; return script(turn); },
  } as unknown as ModelAdapter;
  const runner = new AgentRunner({ computer, adapter, maxSteps: 12, screenshotWidth: W, settleMs: 0, standbyPollMs: 20, onEvent: (e) => events.push(e) });
  const shotsTaken = () => shots;
  const frames = () => events.filter((e): e is Extract<AgentEvent, { type: 'screenshot' }> => e.type === 'screenshot');
  return { runner, events, seen, shotsTaken, frames };
}

const done: ModelTurn = { text: 'done', actions: [], done: true };
const batch = (...actions: ComputerAction[]): ModelTurn => ({ text: '', actions, done: false });

{
  // turn 1: find + read_page (passive) · 2: a click · 3: run_command · 4: a zoom · 5: wait_for · then done.
  const h = harness((t) =>
    t === 1 ? batch({ type: 'find', query: 'sign in' }, { type: 'read_page', scope: 'interactive' })
    : t === 2 ? batch({ type: 'click', x: 10, y: 10, button: 'left', count: 1 })
    : t === 3 ? batch({ type: 'run_command', command: 'ls' })
    : t === 4 ? batch({ type: 'zoom', x: 10, y: 10 })
    : t === 5 ? batch({ type: 'wait_for', reason: 'a page', minutes: 0.006, until: 'change' })
    : done);
  const before = { shots: 0 };
  await h.runner.run('t');
  ok(h.seen[0]?.image === true, 'the first observation of a task always carries a screenshot');
  ok(h.seen[1]?.image === false, 'after find + read_page the observation carries no image');
  ok(h.seen[2]?.image === true, 'after a click it does');
  ok(h.seen[3]?.image === true, 'after run_command it does (a command can open a window)');
  ok(h.seen[4]?.image === false, 'after a zoom alone it does not (the magnified view is in the result)');
  ok(h.seen[5]?.image === true, 'after a standby it does');
  const f = h.frames();
  ok(f.map((e) => e.step).join(',') === '0,1,2,3,4,5', `the step counter advances on every step, image or not (${f.map((e) => e.step).join(',')})`);
  ok(f.filter((e) => e.fresh === false).length === 2 && f.every((e) => (e.fresh === false) === (e.jpegBase64 === '')), 'the two frameless events say fresh:false and carry no jpeg; every other one carries one');
  ok(f.filter((e) => e.fresh !== false).every((e) => e.width === W && e.height > 0), 'a real frame still carries its size');
  // The step's words ride on the event (decision 127): a client older than the build that added an
  // action still shows the step in words instead of as an item with no text.
  const acts = h.events.filter((e): e is Extract<AgentEvent, { type: 'action' }> => e.type === 'action');
  ok(acts.length === 6 && acts.every((e) => typeof e.describe === 'string' && e.describe === describeAction(e.action)), `every action event carries its description, equal to describeAction of its action (${acts.map((e) => e.describe).join(' | ')})`);
  const end = h.events.find((e): e is Extract<AgentEvent, { type: 'status' }> => e.type === 'status' && e.status === 'done');
  ok(end?.end?.steps === 6 && end.end.tokens?.input === 0 && !h.events.some((e) => e.type === 'status' && e.status === 'running' && e.end), `the done status carries the task's end (6 turns, the closing one included, as the journal counts them; a model that reports no usage leaves the counts at zero), running statuses carry none: ${JSON.stringify(end?.end)}`);
  void before;
}

{
  // The screenshot() calls themselves: a passive batch costs none, a zoom costs its own one.
  const h = harness((t) => (t === 1 ? batch({ type: 'find', query: 'sign in' }, { type: 'read_page', scope: 'text' }) : t === 2 ? batch({ type: 'read_docs', page: 'memory' }, { type: 'cursor_position' }) : done));
  await h.runner.run('t');
  ok(h.shotsTaken() === 1, `two passive batches after the first look cost no screenshot at all (${h.shotsTaken()} taken)`);
}

{
  // A screenshot she asks for is a look she gets: the action changes nothing and executes nothing,
  // the frame after the batch is its whole answer — so a batch of just that one takes a frame.
  const h = harness((t) => (t === 1 ? batch({ type: 'find', query: 'sign in' }) : t === 2 ? batch({ type: 'screenshot' }) : done));
  await h.runner.run('t');
  ok(h.seen[1]?.image === false && h.seen[2]?.image === true && h.shotsTaken() === 2, `an explicit screenshot after a passive step takes one and the observation carries it (${h.shotsTaken()} taken)`);
}

{
  const h = harness((t) => (t === 1 ? batch({ type: 'zoom', x: 10, y: 10 }) : done));
  await h.runner.run('t');
  ok(h.shotsTaken() === 2, `a zoom takes its own frame to crop and no observation frame (${h.shotsTaken()})`);
}

{
  // A click that fails still earns a look: the decision is made from the action, not from its result.
  let shots = 0;
  const computer: ComputerProvider = {
    name: 'failing',
    async displaySize() { return { width: W, height: H }; },
    async screenshot() { shots++; return { png: frame(0), width: W, height: H }; },
    async execute(a) { return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : a.type === 'click' ? { ok: false, error: 'the click failed' } : { ok: true }; },
  };
  let turn = 0;
  const images: boolean[] = [];
  const adapter = {
    name: 's', start() {}, addUserMessage() {},
    async step(obs: Observation) { images.push(!!obs.image); turn++; return turn === 1 ? batch({ type: 'click', x: 1, y: 1, button: 'left', count: 1 }) : done; },
  } as unknown as ModelAdapter;
  await new AgentRunner({ computer, adapter, maxSteps: 4, screenshotWidth: W, settleMs: 0, onEvent: () => {} }).run('t');
  ok(images[1] === true && shots === 2, 'a failed click still gets a fresh screenshot');
}

// ---------- the wires ----------
const jpeg = Buffer.from('ffd8ffd9', 'hex');
const withImage = (results: Observation['results']): Observation => ({ image: { jpeg, width: 640, height: 400 }, results });
const without = (results: Observation['results']): Observation => ({ results });

// Anthropic: three turns, the middle one image-less.
{
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      bodies.push(JSON.parse(data));
      const i = bodies.length - 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `msg_${i}`, type: 'message', role: 'assistant', model: 'm', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
        content: i >= 3 ? [{ type: 'text', text: 'done' }] : [{ type: 'tool_use', id: `t_${i}`, name: 'find', input: { query: 'sign in' } }],
        stop_reason: i >= 3 ? 'end_turn' : 'tool_use',
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'claude-test', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'dummy', refusalFallback: false });
    adapter.start('look around', { width: 640, height: 400 });
    await adapter.step(withImage([]));
    await adapter.step(without([{ ok: true, message: 'Page "T" — https://example.com/' }]));
    await adapter.step(withImage([{ ok: true, message: 'ok' }]));
    await adapter.step(without([{ ok: true, message: 'ok' }]));
    // Request i is what step i+1 sent: the task's frame, then a passive turn, then an acting one, then a passive one.
    const images = (b: any) => JSON.stringify(b.messages).match(/"type":"image"/g)?.length ?? 0;
    ok(bodies.map(images).join(',') === '1,1,2,2', `an image-less turn adds no image and an acting one adds exactly one (${bodies.map(images).join(',')})`);
    const unchanged = (b: any) => JSON.stringify(b.messages).includes(SCREEN_UNCHANGED_NOTE.slice(0, 40));
    ok(!unchanged(bodies[0]) && unchanged(bodies[1]), 'the image-less message says the screen is unchanged');
    const acting = bodies[2].messages[bodies[2].messages.length - 1];
    ok(acting.content.some((b: any) => b.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c: any) => c.type === 'image')), 'the acting turn puts the screenshot back inside the tool result');
    const quiet = bodies[3].messages[bodies[3].messages.length - 1];
    ok(JSON.stringify(quiet).includes(SCREEN_UNCHANGED_NOTE) && !JSON.stringify(quiet).includes('"type":"image"'), 'the image-less message is the results plus that one sentence, nothing else');
    // The cache property: everything before the new message is byte-identical to the previous request.
    const strip = (b: any) => JSON.stringify(b.messages, (k, v) => (k === 'cache_control' ? undefined : v));
    let rewrites = 0;
    for (let i = 1; i < bodies.length; i++) if (!strip(bodies[i]).startsWith(strip(bodies[i - 1]).slice(0, -1))) rewrites++;
    ok(rewrites === 0, `the prefix before an image-less message is byte-identical to the previous request (${rewrites} rewrites)`);
  } finally {
    server.close();
  }
}

// OpenAI-compatible: the same, on the other wire.
{
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      bodies.push(JSON.parse(data));
      const i = bodies.length - 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl', object: 'chat.completion', usage: { prompt_tokens: 10, completion_tokens: 1 },
        choices: [{ index: 0, finish_reason: i >= 3 ? 'stop' : 'tool_calls', message: i >= 3 ? { role: 'assistant', content: 'done' } : { role: 'assistant', content: null, tool_calls: [{ id: `t_${i}`, type: 'function', function: { name: 'find', arguments: '{"query":"sign in"}' } }] } }],
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const adapter = new OpenAICompatAdapter({ provider: 'openai-compatible', model: 'm', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'dummy', promptCaching: 'off' });
    adapter.start('look around', { width: 640, height: 400 });
    await adapter.step(withImage([]));
    await adapter.step(without([{ ok: true, message: 'Page "T"' }]));
    await adapter.step(withImage([{ ok: true, message: 'ok' }]));
    await adapter.step(without([{ ok: true, message: 'ok' }]));
    const images = (b: any) => JSON.stringify(b.messages).match(/"type":"image_url"/g)?.length ?? 0;
    ok(bodies.map(images).join(',') === '1,1,2,2', `OpenAI path: no image part on an image-less turn (${bodies.map(images).join(',')})`);
    const users = bodies[1].messages.filter((m: any) => m.role === 'user');
    const last = users[users.length - 1];
    ok(last.content.length === 1 && last.content[0].type === 'text' && last.content[0].text.startsWith(SCREEN_UNCHANGED_NOTE), `the message is text only and says so: ${JSON.stringify(last.content[0].text).slice(0, 60)}`);
    let rewrites = 0;
    for (let i = 1; i < bodies.length; i++) if (!JSON.stringify(bodies[i].messages).startsWith(JSON.stringify(bodies[i - 1].messages).slice(0, -1))) rewrites++;
    ok(rewrites === 0, `OpenAI path: the prefix is byte-identical between requests (${rewrites} rewrites)`);
  } finally {
    server.close();
  }
}

console.log(`passive: ${n} checks passed`);
