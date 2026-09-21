// The sign-in card (`ask_fill`): a login the model never sees. Two halves.
//
// 1. The loop alone, with a scripted adapter and a counting computer: the `needs_fill` event (labels
//    and whether each is secret — never the find-queries, and no value, because none exists yet),
//    `fill()` typing each value as `focus` then `type {secret}` in the card's own order, the result
//    sentence that names the labels and nothing else, a resume without a card (an ordinary
//    hand-over), a stop, a card answered with the wrong labels, and a field whose query matches no
//    text control.
// 2. The whole road: a real service and gateway, the OpenAI-compatible adapter calling the tool as a
//    model would, the `fill` command over the wire, and then the search that matters — the two
//    values (`hunter2-XyZ-9931` and `swordfish-QqR-4417`, strings that cannot occur by chance) must
//    appear in exactly two places, the daemon's `type_text` calls, and in none of: the model's next
//    request, any event, the transcript on disk, the gateway's log, her journal, her chat file, or
//    what the MCP door answers to `status` and `transcript`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { AgentRunner, type AgentEvent } from '../src/agent/loop';
import { askFillAction } from '../src/agent/actions';
import { DeskfishService } from '../src/gateway/service';
import { GatewayServer } from '../src/gateway/server';
import { GatewayClient } from '../src/gateway/client';
import { DeskfishMcp } from '../src/gateway/mcp';
import type { DeskfishConfig } from '../src/gateway/config';
import { describeAction, type ComputerAction, type ComputerProvider, type PageInfo } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}
const listen = (server: http.Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));

/** Two values that cannot turn up by accident: every "is it written down anywhere?" check hunts these. */
const USER_VALUE = 'hunter2-XyZ-9931';
const PASS_VALUE = 'swordfish-QqR-4417';
const hasValue = (s: string) => s.includes(USER_VALUE) || s.includes(PASS_VALUE);

// ---------- the parser ----------
{
  const a = askFillAction({ reason: ' Sign in to LinkedIn ', fields: [{ label: ' Email or phone ', query: ' email field ' }, { label: 'Password', query: 'password field', secret: true }] });
  ok(a.type === 'ask_fill' && a.reason === 'Sign in to LinkedIn' && a.fields.length === 2, 'ask_fill parses and trims its reason');
  ok(a.type === 'ask_fill' && a.fields[0].label === 'Email or phone' && a.fields[0].query === 'email field' && a.fields[0].secret === undefined, 'a plain field keeps its label and query and is not secret');
  ok(a.type === 'ask_fill' && a.fields[1].secret === true, 'a password field is marked secret');
  assert.throws(() => askFillAction({ reason: 'x', fields: [] }), /at least one field/);
  assert.throws(() => askFillAction({ reason: 'x', fields: [{ label: 'Password' }] }), /needs a query/);
  assert.throws(() => askFillAction({ reason: 'x', fields: [{ query: 'password field' }] }), /needs a label/);
  assert.throws(() => askFillAction({ reason: 'x', fields: [{ label: 'A', query: 'a' }, { label: 'A', query: 'b' }] }), /both labelled/);
  n += 4;
  const many = askFillAction({ reason: 'x', fields: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, query: `q${i}` })) });
  ok(many.type === 'ask_fill' && many.fields.length === 6, 'a card asks for at most six fields');
  ok(describeAction(many).startsWith('ask to fill: L0, L1') && !describeAction(many).includes('q0'), `the step's words are the labels, never the queries: ${describeAction(many)}`);
}

// ---------- 1. the loop alone ----------
const png = PNG.sync.write(new PNG({ width: 320, height: 200 }));

/** A computer that answers `focus` for anything with "field" in the query, and records every call. */
function harness(fields: { label: string; query: string; secret?: boolean }[]) {
  const sent: ComputerAction[] = [];
  const page = (focused: boolean, name: string): PageInfo => ({
    url: 'https://example.com/in',
    title: 'Sign in',
    elements: [{ role: focused ? 'textbox' : 'button', name, state: 'empty', x: 100, y: 200, w: 80, h: 20, visible: true, score: 100 }],
    focused,
  });
  const computer: ComputerProvider = {
    name: 'card',
    async displaySize() { return { width: 320, height: 200 }; },
    async screenshot() { return { png, width: 320, height: 200 }; },
    async execute(a) {
      sent.push(JSON.parse(JSON.stringify(a)) as ComputerAction);
      if (a.type === 'cursor_position') return { ok: true, cursor: { x: 1, y: 1 } };
      if (a.type === 'focus') return /field/.test(a.query) ? { ok: true, page: page(true, a.query) } : { ok: true, page: page(false, 'Sign in') };
      return { ok: true };
    },
    async releaseInput() { return []; },
  };
  const results: (string | undefined)[] = [];
  const errors: (string | undefined)[] = [];
  let turn = 0;
  const adapter = {
    name: 'scripted', start() {}, addUserMessage() {},
    async step(obs: Observation): Promise<ModelTurn> {
      for (const r of obs.results) { results.push(r.message); errors.push(r.error); }
      turn++;
      return turn === 1
        ? { text: '', actions: [{ type: 'ask_fill', reason: 'Sign in to LinkedIn', fields }], done: false }
        : { text: 'Signed in.', actions: [], done: true };
    },
  } as unknown as ModelAdapter;
  const events: AgentEvent[] = [];
  const runner = new AgentRunner({ computer, adapter, maxSteps: 5, screenshotWidth: 320, settleMs: 0, onEvent: (e) => events.push(e) });
  return { runner, events, sent, results, errors, run: runner.run('sign in') };
}

const TWO = [{ label: 'Email or phone', query: 'email field' }, { label: 'Password', query: 'password field', secret: true }];

// The card goes up, is filled, and the values land in the page.
{
  const h = harness(TWO);
  await until(() => h.events.some((e) => e.type === 'needs_fill'), 'the card');
  const card = h.events.find((e) => e.type === 'needs_fill') as Extract<AgentEvent, { type: 'needs_fill' }>;
  ok(card.reason === 'Sign in to LinkedIn' && card.step === 1 && card.width === 320, 'the card carries her reason, the step and the screen');
  ok(JSON.stringify(card.fields) === JSON.stringify([{ label: 'Email or phone' }, { label: 'Password', secret: true }]), `the labels and which is secret — and no query, which the view has no use for: ${JSON.stringify(card.fields)}`);
  await until(() => h.runner.currentStatus === 'paused', 'paused');
  ok(h.runner.waitingForUser, 'she is waiting for a person, as at a knock');

  const wrong = h.runner.fill([{ label: 'Email or phone', value: USER_VALUE }, { label: 'Passphrase', value: PASS_VALUE }]);
  ok(!wrong.ok && wrong.error.includes('no field "Password"') && wrong.error.includes('Nothing was filled in'), `labels that do not match the waiting card are refused in a sentence: ${wrong.ok ? '' : wrong.error}`);
  const tooFew = h.runner.fill([{ label: 'Email or phone', value: USER_VALUE }, { label: 'Password', value: PASS_VALUE }, { label: 'Extra', value: 'x' }]);
  ok(!tooFew.ok && tooFew.error.includes('has 2 fields'), `a card with the wrong number of values is refused too: ${tooFew.ok ? '' : tooFew.error}`);
  ok(h.runner.currentStatus === 'paused' && !h.sent.some((a) => a.type === 'type'), 'and after a refusal she is still waiting, with nothing typed');

  ok(h.runner.fill([{ label: 'Email or phone', value: USER_VALUE }, { label: 'Password', value: PASS_VALUE }]).ok, 'the right labels are accepted');
  const again = h.runner.fill([{ label: 'Email or phone', value: 'someone-else' }, { label: 'Password', value: 'someone-else' }]);
  ok(!again.ok && again.error.includes('already been filled in'), `a second submit of the same card changes nothing: ${again.ok ? '' : again.error}`);
  await h.run;
  ok(h.runner.currentStatus === 'done', `the task finished (${h.runner.currentStatus})`);

  const acted = h.sent.filter((a) => a.type === 'focus' || a.type === 'type');
  ok(JSON.stringify(acted) === JSON.stringify([
    { type: 'focus', query: 'email field' },
    { type: 'type', text: USER_VALUE },
    { type: 'focus', query: 'password field' },
    { type: 'type', text: PASS_VALUE, secret: true },
  ]), `field by field, the caret first and then the keystrokes, in the card's order: ${JSON.stringify(acted)}`);
  ok(!h.sent.some((a) => a.type === 'key' || (a.type as string) === 'paste'), 'nothing is pasted: the clipboard leaves this computer');

  const said = h.results.filter(Boolean).join(' ');
  ok(said.includes('Filled 2 fields into the page (Email or phone, Password).') && said.includes('The values were never shown to you.') && said.includes('Press the sign-in button yourself') && said.includes('call ask_user'), `the result names the labels and what to do next: ${said}`);
  ok(!hasValue(said), 'and carries no value');
  ok(!hasValue(JSON.stringify(h.events)), `not one event holds a value (${h.events.length} events)`);
  const step = h.events.find((e) => e.type === 'action' && e.action.type === 'ask_fill') as Extract<AgentEvent, { type: 'action' }>;
  ok(step.describe === 'ask to fill: Email or phone, Password' && !JSON.stringify(step.action).includes(USER_VALUE), `the step's words are the labels: ${step.describe}`);
  ok(JSON.stringify(step.action).includes('email field'), 'the action is the one she called, queries and all — she wrote those herself');
}

// A card answered in the tick it appears — before the loop has even let go of the keyboard. The
// live check of 2026-09-21 did this by accident (a client that answers the event synchronously) and
// was refused; the card is armed before it is announced, so an instant answer is a normal one.
{
  const fields = TWO;
  const sent: ComputerAction[] = [];
  const events: AgentEvent[] = [];
  let runner!: AgentRunner;
  const computer: ComputerProvider = {
    name: 'card',
    async displaySize() { return { width: 320, height: 200 }; },
    async screenshot() { return { png, width: 320, height: 200 }; },
    async execute(a) {
      sent.push(JSON.parse(JSON.stringify(a)) as ComputerAction);
      if (a.type === 'cursor_position') return { ok: true, cursor: { x: 1, y: 1 } };
      if (a.type === 'focus') return { ok: true, page: { url: 'u', title: 't', focused: true, elements: [{ role: 'textbox', name: a.query, state: '', x: 1, y: 1, w: 1, h: 1, visible: true, score: 100 }] } };
      return { ok: true };
    },
    async releaseInput() { return []; },
  };
  let turn = 0;
  const adapter = {
    name: 'scripted', start() {}, addUserMessage() {},
    async step(): Promise<ModelTurn> {
      turn++;
      return turn === 1 ? { text: '', actions: [{ type: 'ask_fill', reason: 'Sign in', fields }], done: false } : { text: 'ok', actions: [], done: true };
    },
  } as unknown as ModelAdapter;
  let answered: { ok: boolean } | undefined;
  runner = new AgentRunner({
    computer, adapter, maxSteps: 5, screenshotWidth: 320, settleMs: 0,
    onEvent: (e) => {
      events.push(e);
      // In the same tick the card is announced, as a client that reacts to the event does.
      if (e.type === 'needs_fill') answered = runner.fill([{ label: 'Email or phone', value: USER_VALUE }, { label: 'Password', value: PASS_VALUE }]);
    },
  });
  await runner.run('sign in');
  ok(answered?.ok === true, 'a card answered in the tick it is shown is accepted, not refused');
  ok(sent.filter((a) => a.type === 'type').length === 2, 'and both values are typed');
  ok(!events.some((e) => e.type === 'status' && e.status === 'paused'), 'a card that was already answered never pauses her: the chat shows no knock that was over before it was drawn');
  ok(!hasValue(JSON.stringify(events)), 'still no value in any event');
}

// Resumed without a card: they typed it on the desktop, which is an ordinary hand-over.
{
  const h = harness(TWO);
  await until(() => h.runner.currentStatus === 'paused', 'paused');
  h.runner.resume();
  await h.run;
  ok(h.runner.currentStatus === 'done' && !h.sent.some((a) => a.type === 'focus' || a.type === 'type'), 'a resume without a card types nothing');
  ok(h.results.filter(Boolean).join(' ').startsWith('The user handled it and handed the desktop back.'), `and reads to her exactly as a hand-over does: ${h.results.filter(Boolean)[0]}`);
}

// Stopped at the card.
{
  const h = harness(TWO);
  await until(() => h.runner.currentStatus === 'paused', 'paused');
  h.runner.stop();
  await h.run;
  ok(h.runner.currentStatus === 'stopped' && !h.sent.some((a) => a.type === 'type'), 'Stop at a card ends the task and types nothing');
  ok(!h.runner.fill([{ label: 'Email or phone', value: USER_VALUE }, { label: 'Password', value: PASS_VALUE }]).ok, 'and a card that arrives afterwards is refused, its values dropped unread');
}

// A field whose query matches no text control: the others are still typed, and it is named.
{
  const h = harness([{ label: 'Email or phone', query: 'email field' }, { label: 'Password', query: 'the sign-in button' }]);
  await until(() => h.runner.currentStatus === 'paused', 'paused');
  h.runner.fill([{ label: 'Email or phone', value: USER_VALUE }, { label: 'Password', value: PASS_VALUE }]);
  await h.run;
  const typed = h.sent.filter((a) => a.type === 'type');
  ok(typed.length === 1 && (typed[0] as { text: string }).text === USER_VALUE, 'the field that was found is filled; the one that was not is not typed anywhere else');
  const said = h.results.filter(Boolean).join(' ') + h.errors.filter(Boolean).join(' ');
  ok(said.includes('Filled 1 field into the page (Email or phone).') && said.includes('These were not filled: Password: nothing matching "the sign-in button" is a field that can be typed into.'), `the failure is named with its reason, and the rest went in: ${said}`);
  ok(!hasValue(said) && !hasValue(JSON.stringify(h.events)), 'and still no value anywhere');
}

// Every field failing is a failed step, not a quiet success.
{
  const h = harness([{ label: 'Password', query: 'the sign-in button' }]);
  await until(() => h.runner.currentStatus === 'paused', 'paused');
  h.runner.fill([{ label: 'Password', value: PASS_VALUE }]);
  await h.run;
  const step = h.events.find((e) => e.type === 'action' && e.action.type === 'ask_fill') as Extract<AgentEvent, { type: 'action' }>;
  ok(!step.result.ok && (step.result.error ?? '').startsWith('Nothing was filled into the page.') && (step.result.error ?? '').includes('find the fields again'), `nothing filled is a failure with a next move: ${step.result.error}`);
}

// ---------- 2. the whole road: model → gateway → the page, and nothing written down ----------

// The tank: every request body is kept, so the search below can look at what really reached it.
const daemonCalls: Record<string, unknown>[] = [];
const shot = PNG.sync.write(new PNG({ width: 320, height: 200 })).toString('base64');
const daemon = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200); res.end('mock daemon'); return; }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    daemonCalls.push(body);
    const reply = (r: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); };
    switch (body.action) {
      case 'screenshot': return reply({ success: true, data: { image: shot } });
      case 'cursor_position': return reply({ success: true, data: { x: 1, y: 1 } });
      case 'list_files': return reply({ success: true, data: { entries: [] } });
      case 'release_input': return reply({ success: true, data: { released: [], blind: false } });
      case 'page_focus': return reply({ success: true, data: { url: 'https://example.com/in', title: 'Sign in', focused: true, elements: [{ role: 'textbox', name: String(body.query), state: 'empty', x: 10, y: 20, w: 40, h: 10, visible: true, score: 100 }] } });
      default: return reply({ success: true });
    }
  });
});
const daemonUrl = `http://127.0.0.1:${await listen(daemon)}`;

// The model: one ask_fill tool call, then a reply. Every request body is kept for the search.
const modelBodies: string[] = [];
const card = {
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ask_fill', arguments: JSON.stringify({ reason: 'Sign in to LinkedIn', fields: [{ label: 'Email or phone', query: 'email field' }, { label: 'Password', query: 'password field', secret: true }] }) } }],
};
let modelTurn = 0;
const model = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    modelBodies.push(raw);
    const message = modelTurn++ === 0 ? card : { role: 'assistant', content: 'I am signed in to LinkedIn now.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
});
const baseUrl = `http://127.0.0.1:${await listen(model)}/v1`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-fill-'));
const cfg: DeskfishConfig = {
  provider: 'openai-compatible', autonomy: 'free', baseUrl, model: 'model-a', anthropicWorkspaceId: '', auth: '', maxSteps: 0, maxCostUsd: 0,
  reflectEvery: 0, userName: '', ledgerEvery: 0, ledgerTokens: 0, cacheTtl: '1h', effort: '', scheduleGraceMinutes: 5, promptCaching: 'off',
  temperature: null, screenshotWidth: 320, settleMs: 0, daemonUrl, daemonToken: '', vncUrl: '', vncPassword: '', composeFile: '',
  containerCli: 'auto', screen: '320x200x24', autoStart: false, openDesktopOnRun: true,
};
const probe = async () => { try { return (await fetch(daemonUrl + '/')).ok; } catch { return false; } };
const logLines: string[] = [];
const service = new DeskfishService({
  dataDir, resourceDir: ROOT, config: cfg, log: (l) => logLines.push(l),
  createEngine: () => ({ isHealthy: probe, start: async () => {}, stop: async () => {}, inspectNetworkMode: async () => 'isolated' as const, networkMode: 'isolated' as const }),
});
service.setKey('deskfish.apiKey.127.0.0.1', 'dummy');
service.init();
const TOKEN = 'f'.repeat(64);
const server = new GatewayServer({ service, token: TOKEN, port: 0, logTail: () => logLines.slice(-200), log: (l) => logLines.push(l) });
const port = await server.listen();
const client = new GatewayClient({ url: `http://127.0.0.1:${port}`, token: TOKEN, client: 'mcp', version: 'test' });
const mcp = new DeskfishMcp(client);
const events: AgentEvent[] = [];
service.on('event', (e: AgentEvent) => events.push(e));

try {
  await client.connect();

  await service.run('Sign me in to LinkedIn');
  await until(() => events.some((e) => e.type === 'needs_fill'), 'the card, through the adapter');
  const shown = events.find((e) => e.type === 'needs_fill') as Extract<AgentEvent, { type: 'needs_fill' }>;
  ok(shown.reason === 'Sign in to LinkedIn' && shown.fields.length === 2 && shown.fields[1].secret === true, 'the model called ask_fill through the OpenAI-compatible adapter and the card reached the clients');
  ok(!JSON.stringify(shown.fields).includes('email field'), 'with the labels only');

  // A card that does not match is refused on the wire, and the values go no further.
  await assert.rejects(client.call('fill', { values: [{ label: 'Nope', value: PASS_VALUE }] }), /no field "Email or phone"|has 2 fields/);
  n++;
  // And the wire refuses a shape that is not a card at all, before it reaches her.
  await assert.rejects(client.call('fill', { values: [{ label: 'Email or phone', value: USER_VALUE, extra: 1 }] } as never), /values must be fill/);
  n++;

  await client.call('fill', { values: [{ label: 'Email or phone', value: USER_VALUE }, { label: 'Password', value: PASS_VALUE }] });
  await until(() => !service.busy, 'the task ends');

  // What reached the tank: the caret, then the keystrokes, the password marked secret.
  const acted = daemonCalls.filter((c) => c.action === 'page_focus' || c.action === 'type_text');
  ok(JSON.stringify(acted.map((c) => [c.action, c.query ?? c.text, c.secret ?? false])) === JSON.stringify([
    ['page_focus', 'email field', false],
    ['type_text', USER_VALUE, false],
    ['page_focus', 'password field', false],
    ['type_text', PASS_VALUE, true],
  ]), `the two values reached the page, and only the page: ${JSON.stringify(acted.map((c) => c.action))}`);

  // The one search that matters. Everything a value could have leaked into, in one list.
  const chatFile = service.chats.list()[0]?.file ?? path.join(dataDir, 'chats');
  const places: [string, string][] = [
    ['the model\'s next request', modelBodies.join('\n')],
    ['the events the gateway pushed', JSON.stringify(events)],
    ['the gateway log', logLines.join('\n')],
    ['the transcript on disk', fs.readFileSync(chatFile, 'utf8')],
    ['her journal', fs.readFileSync(path.join(dataDir, 'journal.md'), 'utf8')],
    ['her self page', fs.readFileSync(path.join(dataDir, 'self.md'), 'utf8')],
    ['the snapshot every client gets', JSON.stringify(service.snapshot())],
    ['the MCP door\'s status', JSON.stringify(await mcp.status())],
    ['the MCP door\'s transcript', JSON.stringify(await mcp.transcript())],
    ['the log tail a client can ask for', logLines.slice(-500).join('\n')],
  ];
  for (const [what, body] of places) ok(!hasValue(body), `no value in ${what}`);

  // The model got the labels and the next move; the person's transcript got the knock and the step.
  ok(modelBodies.some((b) => b.includes('Filled 2 fields into the page (Email or phone, Password).')), 'the model is told which fields went in');
  const transcript = fs.readFileSync(chatFile, 'utf8');
  ok(transcript.includes('**Deskfish needs you:** Sign in to LinkedIn') && transcript.includes('ask to fill: Email or phone, Password'), `the transcript carries the knock and the step: ${transcript.split('\n').filter((l) => /needs you|ask to fill/.test(l)).join(' | ')}`);
  ok(logLines.some((l) => l.includes('✋ needs a login: Sign in to LinkedIn (Email or phone, Password)')) && logLines.some((l) => l.includes('the sign-in card was filled into the page (2 fields; the values are written nowhere)')), 'the log says a card went up and was filled, and names no value');
  const status = JSON.parse((await mcp.status()).content[0].text) as { status: string; knock?: string };
  ok(status.status === 'done' && !status.knock, 'the MCP door sees the task through to the end');
  const items = (JSON.parse((await mcp.transcript()).content[0].text) as { items: { kind: string; text?: string; actions?: { text: string }[] }[] }).items;
  ok(items.some((i) => i.kind === 'needs_user' && i.text === 'Sign in to LinkedIn'), 'a teacher watching through MCP sees the card as a knock');
  ok(items.some((i) => i.kind === 'actions' && (i.actions ?? []).some((a) => a.text === 'ask to fill: Email or phone, Password')), 'and the step in the labels she chose');
} finally {
  client.close();
  await server.close();
  service.dispose();
  daemon.close();
  model.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`fill: ${n} checks passed`);
process.exit(0);
