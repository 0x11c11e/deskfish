// `deskfish mcp` (src/gateway/mcp.ts + the cli subcommand): the MCP door a coding agent talks to.
// A real GatewayServer on a random port with a mock daemon and a scripted model; the test spawns the
// CLI through tsx exactly as a registration does (`deskfish mcp --port --data-dir`) and speaks to it
// with the SDK's own client over stdio. It checks the tool surface (the table's names, nothing that
// writes her files), a task watched through `wait`, a second task queued, `say` refused when she is
// idle, a passive screenshot at the configured width, her four files, `stop` ending a standby, the
// hint and exit 1 when no gateway answers or the token is wrong, and that the gateway's log names
// `mcp` as the client kind.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DeskfishService } from '../src/gateway/service';
import { GatewayServer } from '../src/gateway/server';
import type { DeskfishConfig } from '../src/gateway/config';
import { costOf, ItemLog } from '../src/gateway/mcp';
import type { AgentEvent } from '../src/agent/loop';
import type { ComputerAction } from '../src/computer/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}
const listen = (server: http.Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));

/** The text of an MCP tool result (the server never throws for a refusal). */
const said = (r: any): string => (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
const asJson = (r: any): any => JSON.parse(said(r));

// ---------- mock daemon: a 320-px frame through the POST action, like the other suites ----------
const png = PNG.sync.write(new PNG({ width: 320, height: 200 })).toString('base64');
const daemon = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200); res.end('mock daemon'); return; }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const reply = (r: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); };
    switch (body.action) {
      case 'screenshot': return reply({ success: true, data: { image: png } });
      case 'cursor_position': return reply({ success: true, data: { x: 1, y: 1 } });
      case 'list_files': return reply({ success: true, data: { entries: [] } });
      case 'release_input': return reply({ success: true, data: { released: [], blind: false } });
      case 'input_state': return reply({ success: true, data: { keys: [], buttons: [] } });
      default: return reply({ success: true });
    }
  });
});
const daemonUrl = `http://127.0.0.1:${await listen(daemon)}`;

// ---------- scripted model ----------
type Msg = Record<string, unknown>;
const done = (text: string): Msg => ({ role: 'assistant', content: text });
const standby = (id: string): Msg => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'wait_for', arguments: JSON.stringify({ reason: 'the page', minutes: 60, until: 'change' }) } }] });
const knockOnGlass = (id: string): Msg => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ reason: 'the login page wants a code from your phone' }) } }] });
let script: Msg[] = [];
let gate: Promise<void> | undefined;
let openGate = () => {};
const closeGate = () => { gate = new Promise<void>((r) => (openGate = () => { gate = undefined; r(); })); };
let calls = 0;
const model = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    calls++;
    if (gate) await gate;
    const message = script.shift() ?? done('All done here.');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.02 } }));
  });
});
const baseUrl = `http://127.0.0.1:${await listen(model)}/v1`;

// ---------- service + gateway ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-mcp-'));
const cfg: DeskfishConfig = {
  provider: 'openai-compatible', autonomy: 'free', baseUrl, model: 'model-a', anthropicWorkspaceId: '', maxSteps: 0, maxCostUsd: 0,
  reflectEvery: 0, userName: '', ledgerEvery: 0, ledgerTokens: 0, cacheTtl: '1h', effort: '', scheduleGraceMinutes: 5, promptCaching: 'off',
  temperature: null, screenshotWidth: 160, settleMs: 0, daemonUrl, daemonToken: 'daemon-secret', vncUrl: '', vncPassword: '', composeFile: '',
  containerCli: 'auto', screen: '320x200x24', autoStart: false, openDesktopOnRun: true,
};
const probe = async () => { try { return (await fetch(daemonUrl + '/')).ok; } catch { return false; } };
const logLines: string[] = [];
const service = new DeskfishService({
  dataDir, resourceDir: ROOT, config: cfg, log: (l) => logLines.push(l),
  createEngine: () => ({ isHealthy: probe, start: async () => {}, stop: async () => {}, inspectNetworkMode: async () => 'isolated' as const, networkMode: 'isolated' as const }),
});
service.setKey('deskfish.apiKey.127.0.0.1', 'model-key-never-sent-back');
service.init();
const TOKEN = 'm'.repeat(64);
fs.writeFileSync(path.join(dataDir, 'gateway.token'), TOKEN, { mode: 0o600 });
const server = new GatewayServer({ service, token: TOKEN, port: 0, logTail: () => [], log: (l) => logLines.push(l) });
const port = await server.listen();

/** The registration line a person writes, run through tsx because CI has no dist/ when the suites run. */
const spawnArgs = (extra: string[] = []) => ({ command: process.execPath, args: [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/gateway/cli.ts'), 'mcp', '--port', String(port), '--data-dir', dataDir, ...extra], cwd: ROOT });

const client = new Client({ name: 'teacher-test', version: '1' });
const transport = new StdioClientTransport({ ...spawnArgs(), stderr: 'pipe' });

try {
  await client.connect(transport);

  // ---------- 0. a step's words travel with the event ----------
  // A door process older than the build that added an action has no describeAction case for it —
  // click_element steps showed as items with no text in lesson 4 (decision 127). The runner's own
  // description rides on the event and the log prefers it; a known action without one still renders.
  {
    const log = new ItemLog();
    const future = { type: 'some_future_action', query: 'x' } as unknown as ComputerAction;
    log.absorb({ type: 'action', step: 3, action: future, result: { ok: true }, describe: 'do the future thing "x"' } as AgentEvent);
    log.absorb({ type: 'action', step: 3, action: { type: 'find', query: 'y' }, result: { ok: false, error: 'no' } });
    log.absorb({ type: 'status', status: 'done', message: 'Task finished', end: { steps: 16, tokens: { input: 61_000, output: 3_000, cacheRead: 410_000, cacheWrite: 5_000 } } });
    const step = log.items[0];
    ok(step?.kind === 'actions' && step.step === 3 && step.actions[0].text === 'do the future thing "x"' && !step.actions[0].failed, `an action this client does not know still has its words: ${JSON.stringify(step)}`);
    ok(step?.kind === 'actions' && step.actions[1].text === 'find on the page: "y"' && step.actions[1].failed, 'an action it knows, without the field, renders as before');
    ok(log.items[1]?.kind === 'status' && log.items[1].text === 'done — Task finished · 16 steps · 471k tokens (61k fresh)', `the end item carries the task's counts: ${JSON.stringify(log.items[1])}`);
  }

  // ---------- 1. the tool surface ----------
  const EXPECTED = ['run', 'say', 'wait', 'status', 'transcript', 'screenshot', 'stop', 'new_chat', 'chats', 'self', 'journal', 'playbooks', 'memory', 'reflect'];
  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name).sort();
  ok(JSON.stringify(names) === JSON.stringify([...EXPECTED].sort()), `exactly the table's tools: ${names.join(', ')}`);
  ok(!names.some((t) => /write|save|delete|remove|forget|revise|key|config|setting|schedule|upload/.test(t)), 'no tool writes a file of hers, sets a key or changes a setting');
  ok(tools.every((t) => t.description && t.description.length > 40), 'every tool describes itself for the teacher');
  ok(['wait', 'status', 'transcript', 'screenshot', 'chats', 'self', 'journal', 'playbooks', 'memory'].every((t) => tools.find((x) => x.name === t)?.annotations?.readOnlyHint === true), 'the reading tools are marked read-only');
  ok(tools.find((t) => t.name === 'wait')!.description!.includes('knock'), 'wait tells the teacher to loop until idle or a knock');

  // ---------- 2. her files, read-only ----------
  const selfText = said(await client.callTool({ name: 'self', arguments: {} }));
  ok(selfText.includes(fs.readFileSync(path.join(dataDir, 'self.md'), 'utf8').split('\n')[0]!), 'self returns her page');
  const journalText = said(await client.callTool({ name: 'journal', arguments: {} }));
  ok(journalText.trim() === fs.readFileSync(path.join(dataDir, 'journal.md'), 'utf8').trim(), 'journal equals the file');
  const playbookText = said(await client.callTool({ name: 'playbooks', arguments: {} }));
  ok(playbookText.trim() === fs.readFileSync(path.join(dataDir, 'playbook.md'), 'utf8').trim(), 'playbooks equal the file');
  const mem = said(await client.callTool({ name: 'memory', arguments: {} }));
  ok(mem.includes('fact') && mem.startsWith(fs.readFileSync(path.join(dataDir, 'memory.md'), 'utf8').slice(0, 20)), 'memory defaults to memory.md and counts the facts');
  const charter = said(await client.callTool({ name: 'memory', arguments: { file: 'charter.md' } }));
  ok(charter.length > 100 && charter !== mem, 'memory can read the charter too');

  // ---------- 3. say is refused while she is idle ----------
  const idleSay = said(await client.callTool({ name: 'say', arguments: { text: 'hello?' } }));
  ok(/She is idle — use run; a run in the same chat continues the conversation\./.test(idleSay), `say when idle is refused with the sentence: ${idleSay}`);
  ok(!(await client.callTool({ name: 'say', arguments: { text: 'hello?' } }) as any).isError, 'a refusal is a sentence, not an error');

  // ---------- 4. a task, watched with wait ----------
  const started = asJson(await client.callTool({ name: 'run', arguments: { task: 'Tell me what is on the screen.' } }));
  ok(started.accepted === true && started.queued === 0, `run is accepted: ${JSON.stringify(started)}`);
  let cursor = started.cursor ?? 0;
  let seen: any[] = [];
  let last: any;
  for (let i = 0; i < 10; i++) {
    last = asJson(await client.callTool({ name: 'wait', arguments: { timeoutSeconds: 5, since: cursor } }));
    cursor = last.cursor;
    seen = seen.concat(last.items);
    if (!last.busy) break;
  }
  ok(last.busy === false && last.status === 'done', `wait ends when she is done: ${last.status}`);
  ok(seen.some((i) => i.kind === 'user' && i.text.includes('what is on the screen')), 'the items carry the task');
  ok(seen.some((i) => i.kind === 'assistant' && i.text.includes('All done here')), 'and her reply');
  ok(seen.some((i) => i.kind === 'status' && i.text.startsWith('done')), 'and how it ended');
  // The fake model reports 10 prompt tokens a turn: the end item and the journal line keep the task's
  // counts, which `status` loses the moment she is idle (decision 127).
  const endItem = seen.find((i) => i.kind === 'status' && i.text.startsWith('done'));
  ok(/^done — Task finished · \d+ steps? · \d+ tokens \(\d+ fresh\)$/.test(endItem?.text ?? ''), `the end item carries the steps and the tokens: ${endItem?.text}`);
  ok(seen.filter((i) => i.kind === 'actions').every((i: any) => i.actions.every((a: any) => typeof a.text === 'string' && a.text.length > 0)), 'every step item has its words');
  ok(!JSON.stringify(seen).includes('jpegBase64') && !JSON.stringify(seen).includes('data:image'), 'items are text only — never an image');

  // ---------- 5. the run carries its reason into the log and the journal ----------
  ok(logLines.some((l) => l.startsWith('▶ task (lesson)')), `the log says what put the task there: ${logLines.find((l) => l.startsWith('▶ task')) ?? '(none)'}`);
  ok(/^- \[[^\]]+\] done · \d+ steps? .*· lesson/m.test(fs.readFileSync(path.join(dataDir, 'journal.md'), 'utf8')), 'the journal line names the reason');
  ok(/^- \[[^\]]+\] done · \d+ steps? · \$[\d.]+ · \d+ tokens \(\d+ fresh\) · lesson/m.test(fs.readFileSync(path.join(dataDir, 'journal.md'), 'utf8')), `the journal line keeps the task's tokens after the cost: ${fs.readFileSync(path.join(dataDir, 'journal.md'), 'utf8').split('\n').find((l) => l.includes('lesson'))}`);

  // ---------- 6. status and transcript ----------
  const st = asJson(await client.callTool({ name: 'status', arguments: {} }));
  ok(st.status === 'done' && st.busy === false && st.model === 'model-a' && st.provider === 'openai-compatible', `status reports her setup: ${JSON.stringify(st)}`);
  ok(st.desktop === 'on' && typeof st.step === 'number' && st.costUsd > 0, 'status reports the tank, the step and the cost');
  ok(st.costEstimated === undefined, 'a cost the provider reported is not marked as an estimate');
  // Without a reported cost, status prices the chat at the list price like the chat's usage line and the
  // journal do (lesson 1, 2026-09-18: grok-4.6 read "$0" over MCP while the journal said $0.22) — and
  // with neither, it says nothing rather than "0".
  const grokUsage = { type: 'usage' as const, input: 68423, output: 238, cacheRead: 169472, cacheWrite: 0 };
  const grok = costOf(grokUsage, { provider: 'openai-compatible', model: 'grok-4.6', baseUrl: 'https://api.x.ai/v1' } as DeskfishConfig);
  ok(grok?.costEstimated === true && Math.abs(grok.costUsd - 0.223) < 0.001, `no reported cost + a list price → an estimate (${JSON.stringify(grok)})`);
  ok(costOf(grokUsage, { provider: 'openai-compatible', model: 'model-a', baseUrl } as DeskfishConfig) === undefined, 'no reported cost and no list price → no cost field, not $0');
  ok(costOf({ ...grokUsage, costUsd: 0.02 }, { provider: 'openai-compatible', model: 'grok-4.6', baseUrl: 'https://api.x.ai/v1' } as DeskfishConfig)?.costUsd === 0.02, 'a reported cost wins over the estimate');
  // Signed in with Grok: the run draws a pool the plan paid for. A dollar figure — reported, estimated
  // or zero — would all be lies, so the teacher is told what kind of billing it is instead.
  const signedIn = costOf(grokUsage, { provider: 'openai-compatible', model: 'grok-4.6', baseUrl: 'https://api.x.ai/v1', auth: 'xai-oauth' } as DeskfishConfig);
  ok(signedIn?.billing === 'subscription' && signedIn.costUsd === undefined && signedIn.costEstimated === undefined, `signed in → billing: "subscription" and no cost at all (${JSON.stringify(signedIn)})`);
  ok(costOf({ ...grokUsage, costUsd: 0.02 }, { provider: 'openai-compatible', model: 'grok-4.6', baseUrl: 'https://api.x.ai/v1', auth: 'xai-oauth' } as DeskfishConfig)?.costUsd === undefined, "signed in: even a figure the provider reports is not money the person spent, so it is not shown as cost");
  const tr = asJson(await client.callTool({ name: 'transcript', arguments: {} }));
  ok(tr.items.some((i: any) => i.kind === 'assistant') && tr.items.some((i: any) => i.kind === 'user'), 'transcript shows the chat she is in now');

  // ---------- 7. a passive screenshot, scaled like the frames she sees ----------
  const shot: any = await client.callTool({ name: 'screenshot', arguments: {} });
  const image = shot.content.find((c: any) => c.type === 'image');
  ok(!!image && image.mimeType === 'image/jpeg' && image.data.length > 100, 'screenshot answers with a JPEG');
  ok(/160×100/.test(said(shot)), `the frame is scaled to screenshotWidth: ${said(shot)}`);
  const lastFrame = said(await client.callTool({ name: 'screenshot', arguments: { fresh: false } }));
  ok(/The last frame she saw \(step \d+\)/.test(lastFrame), `fresh false gives the frame she saw: ${lastFrame}`);

  // ---------- 8. a second task while she is busy is queued ----------
  closeGate();
  const first = asJson(await client.callTool({ name: 'run', arguments: { task: 'A long one.' } }));
  ok(first.queued === 0, 'the first task is not queued');
  await until(() => calls > 0 && service.busy, 'she is busy');
  const second = asJson(await client.callTool({ name: 'run', arguments: { task: 'The next one.', reason: 'lesson 2' } }));
  ok(second.accepted === true && second.queued === 1, `a task while she works is queued: ${JSON.stringify(second)}`);
  ok(/number 1 in her queue/.test(second.note), 'and says so in words');

  // ---------- 9. say reaches her while she works ----------
  const midSay = said(await client.callTool({ name: 'say', arguments: { text: 'One more thing: be quick.' } }));
  ok(/Said\./.test(midSay), `say works mid-task: ${midSay}`);

  // ---------- 10. stop ends a standby, and the queue with it ----------
  script = [standby('s1')];
  openGate();
  await until(() => logLines.some((l) => l.includes('Standing by')) || service.snapshot().statusMessage?.startsWith('Standing by') === true, 'she is standing by', 25_000);
  const stopped = said(await client.callTool({ name: 'stop', arguments: {} }));
  ok(/Stopped\./.test(stopped), `stop answers plainly: ${stopped}`);
  await until(() => !service.busy, 'the standby ended at once', 5000);
  ok(!service.busy, 'a 60-minute standby ends the moment the teacher stops it');

  // ---------- 10b. a knock ends the wait, and say answers it ----------
  script = [knockOnGlass('k1'), done('Thanks, in we go.')];
  const knockRun = asJson(await client.callTool({ name: 'run', arguments: { task: 'Sign in for me.' } }));
  let knocked: any;
  for (let i = 0; i < 6; i++) {
    knocked = asJson(await client.callTool({ name: 'wait', arguments: { timeoutSeconds: 8, since: knockRun.cursor } }));
    if (knocked.knock || !knocked.busy) break;
  }
  ok(knocked.knock === 'the login page wants a code from your phone', `wait returns on a knock with its reason: ${JSON.stringify(knocked.knock)}`);
  ok(knocked.busy === true && knocked.items.some((i: any) => i.kind === 'needs_user'), 'she is still busy, and the knock is an item too');
  const stKnock = asJson(await client.callTool({ name: 'status', arguments: {} }));
  ok(stKnock.knock === knocked.knock, 'status shows the knock as long as she waits');
  ok(/Said\./.test(said(await client.callTool({ name: 'say', arguments: { text: 'The code is 123456.' } }))), 'the teacher answers the knock with say');
  let after: any;
  for (let i = 0; i < 6; i++) {
    after = asJson(await client.callTool({ name: 'wait', arguments: { timeoutSeconds: 8, since: knocked.cursor } }));
    if (!after.busy) break;
  }
  ok(after.busy === false && after.knock === undefined, `answering releases her and the knock is gone: ${JSON.stringify({ busy: after.busy, knock: after.knock })}`);

  // ---------- 11. a new chat is the lesson boundary ----------
  const fresh = said(await client.callTool({ name: 'new_chat', arguments: {} }));
  ok(/New chat\./.test(fresh), 'new_chat files the old one');
  const list = asJson(await client.callTool({ name: 'chats', arguments: {} }));
  ok(Array.isArray(list.chats) && list.chats.length >= 1 && list.chats[0].firstTask, `chats lists the history: ${list.chats.length}`);
  const filtered = asJson(await client.callTool({ name: 'chats', arguments: { filter: 'zzz-nothing-matches' } }));
  ok(filtered.chats.length === 0, 'the filter filters');
  const past = asJson(await client.callTool({ name: 'transcript', arguments: { chat: list.chats[0].name } }));
  ok(past.items.length > 0 && past.chat.name === list.chats[0].name, 'a past chat can be read by name');
  const nowEmpty = asJson(await client.callTool({ name: 'transcript', arguments: {} }));
  ok(nowEmpty.items.length === 0, 'and the new chat is empty');

  // ---------- 12. the gateway knows what kind of client this is ----------
  ok(logLines.some((l) => /— mcp client connected/.test(l)), `the log names the client kind: ${logLines.find((l) => /client connected/.test(l))}`);

  await client.close();

  // ---------- 13. no gateway, and a wrong token: the hint, and exit 1 ----------
  const runCli = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number; err: string }>((resolve) => {
    const a = spawnArgs(args);
    const p = spawn(a.command, a.args, { cwd: a.cwd, env: { ...process.env, ...env } });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code: code ?? -1, err }));
    setTimeout(() => p.kill('SIGKILL'), 20_000);
  });
  const t0 = Date.now();
  const noGateway = await runCli(['--url', 'http://127.0.0.1:9', '--port', '9'], { DESKFISH_GATEWAY_TOKEN: TOKEN });
  ok(noGateway.code === 1 && /deskfish serve/.test(noGateway.err), `no gateway: the hint and exit 1 (${noGateway.code}): ${noGateway.err.trim()}`);
  ok(Date.now() - t0 < 20_000, 'and it does not hang waiting for one');
  const badToken = await runCli(['--url', `http://127.0.0.1:${port}`], { DESKFISH_GATEWAY_TOKEN: 'x'.repeat(64) });
  ok(badToken.code === 1 && /refused the token|did not answer/.test(badToken.err), `a wrong token is refused, exit 1: ${badToken.err.trim()}`);
  const noToken = await runCli(['--url', `http://127.0.0.1:${port}`], { DESKFISH_GATEWAY_TOKEN: '' });
  ok(noToken.code === 1 && /DESKFISH_GATEWAY_TOKEN/.test(noToken.err), '--url without the environment token says which variable it needs');

  console.log(`mcp: ${n} checks passed`);
} finally {
  await client.close().catch(() => {});
  service.dispose();
  await server.close().catch(() => {});
  daemon.close();
  model.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
