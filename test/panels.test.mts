// The chat view's panels (gateway plan step 6B). The bridge through the real gateway: an `ask` the
// view may make reaches the gateway and is answered, one it may not (key.set, shutdown) is answered
// with a refusal and never reaches it — from the page's host (WebHost over a real WebSocket) and from
// VS Code's path (answerAsk over a GatewayClient). History over the wire: `chats.open` gives the items
// parseTranscript gives, every row carries its outcome (done / stopped / error / needed you /
// unfinished), the chat still open is not listed, `chats.delete {name}` deletes one, refuses a path
// and the open chat, and without a name deletes every past chat but the open one. The pure parts:
// the day groups, the title cut, the filter, the past-chat line, the settings and schedule form helpers
// moved from the page, mdLite's links, the snapshot → chat messages, and the three-way settings merge
// (a settings.json edit made while VS Code was closed is pushed, not overwritten).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DeskfishService } from '../src/gateway/service';
import { GatewayServer } from '../src/gateway/server';
import { GatewayClient } from '../src/gateway/client';
import { DEFAULT_CONFIG, applyConfigPatch, type DeskfishConfig } from '../src/gateway/config';
import { ConfigSync, changedKeys, mergeOnConnect, type SettingWrite } from '../src/gateway/configSync';
import { SETTINGS_KEYS, settingsSchema } from '../src/gateway/settingsSchema';
import { validate, type ChatInfo, type Snapshot } from '../src/gateway/protocol';
import { outcomeOf, parseTranscript } from '../src/agent/chats';
import { VIEW_COMMANDS, answerAsk, isViewCommand, snapshotChat } from '../src/webview/bridge';
import { budgetHint, chatTitle, dayLabel, fieldInput, filterChats, groupChats, outcomeLabel, pastChatLine, readField, refusalOf } from '../src/webview/forms';
import { mdLite } from '../src/webview/markdown';
import { WebHost, type HostUi, type SocketLike } from '../web/shim';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}

// ---------- 1. pure: history ----------
{
  const now = new Date(2026, 8, 16, 14, 30); // Wednesday 16 September 2026
  const chat = (startedAt: string, firstTask: string, outcome?: ChatInfo['outcome']): ChatInfo => ({ name: `${startedAt}.md`, startedAt, firstTask, bytes: 10, ...(outcome ? { outcome } : {}) });
  const list = [chat('2026-09-16 09:12', 'Order paper', 'done'), chat('2026-09-16 08:00', 'Check mail'), chat('2026-09-15 22:10', 'Book a table', 'stopped'), chat('2026-09-14 10:00', 'Pay the bill', 'needs_user'), chat('2026-09-01 10:00', 'Old one', 'error'), chat('2025-12-31 23:59', 'Last year')];
  const groups = groupChats(list, now);
  ok(groups.map((g) => `${g.label}:${g.chats.length}`).join(' | ') === 'Today:2 | Yesterday:1 | Monday, 14 September:1 | Tuesday, 1 September:1 | Wednesday, 31 December 2025:1', `grouped by day, newest first: ${groups.map((g) => `${g.label}:${g.chats.length}`).join(' | ')}`);
  ok(dayLabel('2026-01-01', new Date(2026, 0, 2)) === 'Yesterday' && dayLabel('2025-12-31', new Date(2026, 0, 1)) === 'Yesterday' && dayLabel('garbage', now) === 'Earlier', 'yesterday across a month and a year; a start time it cannot read');
  const long = 'Search the web for the three cheapest flights from Madrid to Lisbon next Friday morning and compare the luggage rules';
  const cut = chatTitle(long);
  ok(cut.length <= 70 && cut.endsWith('…') && long.startsWith(cut.slice(0, -1)) && !/\s…$/.test(cut), `a long first task is cut at a word before 70 characters: "${cut}"`);
  ok(chatTitle('  Open\n example.com  ') === 'Open example.com' && chatTitle('') === '(no task)' && chatTitle('x'.repeat(90)).length === 70, 'spaces collapsed, an empty task named, one long word cut hard');
  ok(filterChats(list, '').length === list.length && filterChats(list, 'BOOK').map((c) => c.firstTask).join() === 'Book a table' && filterChats(list, 'pay bill').length === 1 && filterChats(list, 'pay table').length === 0, 'the filter: any case, every word must be in the title');
  ok(['done', 'stopped', 'error', 'needs_user', undefined].map((o) => outcomeLabel(o as ChatInfo['outcome'])).join() === 'Done,Stopped,Error,Needed you,Unfinished', 'outcomes in words');
  ok(pastChatLine(list[0], now) === 'Past chat · Today · 09:12' && pastChatLine(list[3], now) === 'Past chat · Mon, 14 Sep · 10:00', `the bar over a past chat: ${pastChatLine(list[3], now)}`);
}

// ---------- 2. pure: the transcript's outcome ----------
{
  const head = '# Chat — 2026-09-16 09:00\n\nmodel: m (mock)\n\n## You (09:00)\n\nDo it\n\n';
  ok(outcomeOf(`${head}## Deskfish (09:01)\n\nDone.\n\n_done — Finished in 3 steps_\n\n— chat ended 09:02 —\n`) === 'done', 'done');
  ok(outcomeOf(`${head}_step 1_: click\n\n_stopped — Stopped by the user_\n\n`) === 'stopped', 'stopped');
  ok(outcomeOf(`${head}_error — the model refused_\n\n`) === 'error', 'error');
  ok(outcomeOf(`${head}_step 2_: type\n\n> **Deskfish needs you:** Log in to the bank\n\n— chat ended 09:05 —\n`) === 'needs_user', 'a knock with nothing after it: needed you');
  ok(outcomeOf(`${head}> **Deskfish needs you:** code\n\n## You (09:03)\n\nthere\n\n_done — ok_\n\n`) === 'done', 'a knock answered and then finished: done');
  ok(outcomeOf(`${head}_done — first task_\n\n## You (09:10)\n\nand now this\n\n_step 1_: click\n\n— chat ended 09:11 —\n`) === 'done' && outcomeOf(head) === undefined && outcomeOf(`${head}_step 1_: click (failed)\n\n`) === undefined, 'the last status counts; no status at all: unfinished');
  ok(outcomeOf('_step 3_: press Return_stopped — Stopped_') === 'stopped', 'the first format, where a status ran into a step line');
}

// ---------- 3. pure: the forms (moved from the page in 6B) ----------
{
  const schema = settingsSchema(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));
  const entry = (k: keyof DeskfishConfig) => schema.find((e) => e.key === k)!;
  ok(JSON.stringify(readField(entry('temperature'), '')) === '{"value":null}' && JSON.stringify(readField(entry('temperature'), '0.4')) === '{"value":0.4}', 'temperature: empty = null, a number = that number');
  ok('error' in readField(entry('maxSteps'), '') && 'error' in readField(entry('maxSteps'), 'lots') && JSON.stringify(readField(entry('maxSteps'), '25')) === '{"value":25}', 'a number field needs a number');
  ok(JSON.stringify(readField(entry('autoStart'), false)) === '{"value":false}' && JSON.stringify(readField(entry('effort'), '')) === '{"value":""}' && 'error' in readField(entry('effort'), 'extreme'), 'a checkbox, an enum (empty = default), a value outside the enum');
  ok(JSON.stringify(readField(entry('userName'), '  Iman ')) === '{"value":"Iman"}' && JSON.stringify(readField(entry('vncPassword'), ' pw ')) === '{"value":" pw "}', 'the name is trimmed as VS Code reads it; a password is not');
  ok(fieldInput(entry('temperature'), DEFAULT_CONFIG) === '' && fieldInput(entry('autoStart'), DEFAULT_CONFIG) === true && fieldInput(entry('maxSteps'), DEFAULT_CONFIG) === '0', 'the form shows null as empty');
  ok(refusalOf('bad value for effort').key === 'effort' && refusalOf('unknown setting: colour').key === ('colour' as any) && refusalOf('Deskfish is not connected').key === undefined, 'a refusal names its field when the gateway says which');
  ok(/\$2\.00/.test(budgetHint(2)) && /no budget/.test(budgetHint(0)), 'the budget hint names the setting\'s value');
}

// ---------- 4. pure: links in her replies ----------
{
  const link = (href: string, label = href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  ok(mdLite('See [the docs](https://deskfish.sh/docs?a=1&b=2).') === `See ${link('https://deskfish.sh/docs?a=1&amp;b=2', 'the docs')}.`, 'a markdown link, its & escaped');
  ok(mdLite('Go to https://example.com/path, then stop.') === `Go to ${link('https://example.com/path')}, then stop.`, 'a bare https URL; the comma after it is not part of it');
  ok(mdLite('http://127.0.0.1:9985/x') === link('http://127.0.0.1:9985/x'), 'http too');
  ok(mdLite('[x](javascript:alert(1))') === '[x](javascript:alert(1))' && !mdLite('javascript:alert(1) data:text/html,x').includes('<a'), 'a javascript: or data: URL stays text');
  const typed = mdLite('<a href="https://evil" onclick="x()">click</a><script>x()</script>');
  ok(!/<a href="https:\/\/evil" onclick/.test(typed) && !typed.includes('<script') && typed.startsWith('&lt;a href="'), `markup typed by a page never becomes a tag: ${typed}`);
  ok(!/<a [^>]*"[^>]*onmouseover/.test(mdLite('https://a.b/"onmouseover="x()')) && mdLite('https://a.b/"onmouseover="x()').startsWith(link('https://a.b/')), 'a quote ends a bare URL, so nothing escapes the href');
  ok(mdLite('`https://x.y` and **bold https://a.b**') === `<code>https://x.y</code> and <strong>bold ${link('https://a.b')}</strong>`, 'a URL in code stays code; bold around a link stays outside the href');
  ok(mdLite('**bold** `code`\n# Head') === '<strong>bold</strong> <code>code</code>\n<strong>Head</strong>' && mdLite('a & b < c') === 'a &amp; b &lt; c', 'bold, code, headings and escaping as before');
}

// ---------- 5. pure: the snapshot as chat messages; the allowlist ----------
{
  const snap = { status: 'running', statusMessage: 'Working', screenFree: false, chat: [{ kind: 'user', text: 'hi' }], usage: { type: 'usage', input: 1, output: 2 }, screenshot: { dataUrl: 'data:', width: 10, height: 20, step: 4 }, desktop: { status: { state: 'on' } } } as unknown as Snapshot;
  ok(snapshotChat(snap).map((m) => m.type).join() === 'newChat,replay,event,event,event,desktop' && (snapshotChat(snap)[1] as any).live === true, 'a snapshot → newChat, the live transcript, usage, step, status, desktop');
  ok(snapshotChat({ ...snap, status: 'done', chat: [], usage: undefined, screenshot: undefined }).map((m) => m.type).join() === 'newChat,desktop', 'a finished, empty chat: newChat and the desktop');
  for (const cmd of VIEW_COMMANDS) ok(validate({ id: 1, cmd }).ok || /must be|unknown argument/.test((validate({ id: 1, cmd }) as any).error), `${cmd} is a real command`);
  ok(!isViewCommand('key.set') && !isViewCommand('shutdown') && !isViewCommand('desktop.off') && !isViewCommand('run') && !isViewCommand('log.tail') && !isViewCommand(undefined), 'keys, shutdown, the desktop, runs and the log are not the view\'s to ask');
  // The sign-in is a credential, like a key: the view posts `setApiKey` to its host and the host
  // runs the flow. A panel that could start a sign-in, or sign out, would be a second writer.
  ok(!isViewCommand('auth.start') && !isViewCommand('auth.poll') && !isViewCommand('auth.signOut') && !isViewCommand('model.set'), 'the Grok sign-in and model.set are the host\'s, not the view\'s');
}

// ---------- 6. pure: the three-way merge on connect ----------
{
  const base = { ...DEFAULT_CONFIG, maxSteps: 40, reflectEvery: 5, userName: 'Iman', maxCostUsd: 5 };
  let m = mergeOnConnect({ ...base }, { ...base, reflectEvery: 7 }, base);
  ok(JSON.stringify(m.push) === '{"reflectEvery":7}' && !m.write.length && !m.conflicts.length, 'settings changed while away, the gateway not → pushed');
  m = mergeOnConnect({ ...base, maxSteps: 25 }, { ...base }, base);
  ok(!Object.keys(m.push).length && m.write.join() === 'maxSteps' && !m.conflicts.length, 'the gateway changed, settings not → written');
  m = mergeOnConnect({ ...base, userName: 'Sam' }, { ...base, userName: 'Alex' }, base);
  ok(!Object.keys(m.push).length && m.write.join() === 'userName' && m.conflicts.join() === 'userName', 'both changed to different values → the gateway wins, named as a conflict');
  m = mergeOnConnect({ ...base, maxCostUsd: 9 }, { ...base, maxCostUsd: 9 }, base);
  ok(!Object.keys(m.push).length && !m.write.length && !m.conflicts.length, 'both changed to the same value → nothing to do');
  m = mergeOnConnect({ ...base, maxSteps: 25 }, { ...DEFAULT_CONFIG, reflectEvery: 7 }, undefined);
  ok(!Object.keys(m.push).length && m.write.length === changedKeys({ ...base, maxSteps: 25 }, { ...DEFAULT_CONFIG, reflectEvery: 7 }).length && !m.conflicts.length, 'no base yet (a first connect) → the gateway wins every differing key, as before');

  // The whole story: VS Code and the gateway in sync; VS Code closes; settings.json is edited by hand, the page changes
  // the gateway, and both touch userName; VS Code opens again with the base it stored.
  const world = (gateway: DeskfishConfig, settings: DeskfishConfig, stored: { base?: DeskfishConfig }) => {
    const w = { gateway, settings, pushes: [] as Partial<DeskfishConfig>[], writes: [] as SettingWrite[], logs: [] as string[], sync: undefined as unknown as ConfigSync };
    w.sync = new ConfigSync(
      {
        readSettings: () => ({ ...w.settings }),
        push: async (patch) => {
          w.pushes.push(patch);
          w.gateway = applyConfigPatch(w.gateway, patch as Record<string, unknown>);
          await w.sync.config(w.gateway);
          return w.gateway;
        },
        write: async (x) => {
          w.writes.push(x);
          (w.settings as any)[x.key] = x.value === undefined ? DEFAULT_CONFIG[x.key] : x.value;
          void w.sync.settingsChanged((s) => s === x.setting);
        },
        pushKey: async () => {},
        log: (line) => void w.logs.push(line),
        saveBase: (cfg) => void (stored.base = { ...cfg }),
      },
      stored.base,
    );
    return w;
  };
  const stored: { base?: DeskfishConfig } = {};
  const gatewayStart = { ...DEFAULT_CONFIG, maxSteps: 40, userName: 'Iman' };
  let w = world({ ...gatewayStart }, { ...DEFAULT_CONFIG }, stored);
  ok((await w.sync.connected({ config: w.gateway, configSaved: true })) === 'mirrored' && changedKeys(w.gateway, w.settings).length === 0 && !!stored.base && changedKeys(stored.base, w.gateway).length === 0, 'first connect: settings follow the gateway, and the agreed config is stored');
  // VS Code is closed now.
  const settingsEdited = { ...w.settings, reflectEvery: 7, maxCostUsd: 3, userName: 'Alex' };
  const gatewayEdited = applyConfigPatch(w.gateway, { maxSteps: 25, userName: 'Sam' });
  // Reopened.
  w = world(gatewayEdited, settingsEdited, stored);
  ok((await w.sync.connected({ config: w.gateway, configSaved: true })) === 'merged', 'reopened with a stored base: merged');
  await sleep(5);
  ok(w.pushes.length === 1 && Object.keys(w.pushes[0]).length === 2 && w.pushes[0].reflectEvery === 7 && w.pushes[0].maxCostUsd === 3,`the hand edits made while VS Code was closed are pushed: ${JSON.stringify(w.pushes)}`);
  ok(w.gateway.reflectEvery === 7 && w.gateway.maxCostUsd === 3 && w.gateway.maxSteps === 25 && w.settings.maxSteps === 25, 'the page\'s change is written into settings, the hand edits reach the gateway');
  ok(w.gateway.userName === 'Sam' && w.settings.userName === 'Sam' && w.logs.some((l) => l.includes('deskfish.userName') && /gateway's value is kept/.test(l)), `both changed userName: the gateway wins, one log line names it (${w.logs.join(' | ')})`);
  ok(changedKeys(w.gateway, w.settings).length === 0 && changedKeys(stored.base!, w.gateway).length === 0, 'both sides agree, and that is the stored base');
  // Without the base (the rule before 6B) the same reopening loses the hand edits.
  const lost = world(gatewayEdited, { ...settingsEdited }, {});
  await lost.sync.connected({ config: lost.gateway, configSaved: true });
  ok(lost.pushes.length === 0 && lost.settings.reflectEvery === DEFAULT_CONFIG.reflectEvery, 'without a base the edits are overwritten — what the base fixes');
  ok(SETTINGS_KEYS.userName === 'deskfish.userName', 'the log line uses the setting\'s name');
}

// ---------- 7. the real gateway: the bridge, history over the wire ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-panels-'));
const dataDir = path.join(tmp, 'home');
const service = new DeskfishService({
  dataDir, resourceDir: ROOT, config: { ...DEFAULT_CONFIG, autoStart: false, daemonUrl: 'http://127.0.0.1:1', vncUrl: 'ws://127.0.0.1:1/websockify' },
  createEngine: () => ({ isHealthy: async () => false, start: async () => {}, stop: async () => {}, inspectNetworkMode: async () => 'isolated' as const, networkMode: 'isolated' as const }),
});
service.init();
const TOKEN = crypto.randomBytes(32).toString('hex');
const server = new GatewayServer({ service, token: TOKEN, port: 0 });
const port = await server.listen();
const clients: GatewayClient[] = [];
let host: WebHost | undefined;
try {
  const dir = service.chats.dir;
  fs.mkdirSync(dir, { recursive: true });
  const head = (at: string, task: string) => `# Chat — ${at}\n\nmodel: m (mock)\n\n## You (${at.slice(11)})\n\n${task}\n\n`;
  const files: Record<string, string> = {
    '2026-09-14 10-00 - Pay the bill.md': `${head('2026-09-14 10:00', 'Pay the bill')}_step 1_: left click at (1, 2) · type "x" (failed)\n\n> **Deskfish needs you:** Log in to the bank\n\n— chat ended 10:05 —\n`,
    '2026-09-15 09-00 - Order paper.md': `${head('2026-09-15 09:00', 'Order paper')}## Deskfish (09:01)\n\nOrdered, see https://acme.example/order/1.\n\n> Remembered: Acme needs a PO number\n\n_done — Finished_\n\n— chat ended 09:02 —\n`,
    '2026-09-15 11-00 - Book a table.md': `${head('2026-09-15 11:00', 'Book a table')}_stopped — Stopped by the user_\n\n`,
    '2026-09-15 12-00 - Broken.md': `${head('2026-09-15 12:00', 'Broken')}_error — the model refused_\n\n`,
    '2026-09-15 13-00 - Half done.md': `${head('2026-09-15 13:00', 'Half done')}_step 1_: click\n\n`,
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  // The chat still being written (as a run would have opened it).
  (service as any).transcript = service.chats.start('The current task', { model: 'm', provider: 'mock' });
  const currentName = path.basename((service as any).transcript.file);

  // The page's host over a real socket, the view played by this test.
  const answers: any[] = [];
  const posts: { pane: string; m: any }[] = [];
  const url = `http://127.0.0.1:${port}`;
  host = new WebHost({
    wsUrl: `ws://127.0.0.1:${port}/ws?token=${TOKEN}`, vncUrl: `ws://127.0.0.1:${port}/vnc?token=${TOKEN}`, token: TOKEN,
    openSocket: (u) => new WebSocket(u) as unknown as SocketLike,
    post: (pane, m) => { posts.push({ pane, m }); if ((m as any).type === 'answer') answers.push(m); },
    fetch: (u, init) => fetch(new URL(u, url), init),
    ui: { visible: () => false, connection() {}, toast() {}, knock() {}, reload() {} } as unknown as HostUi,
  });
  host.start();
  await until(() => host!.isConnected, 'the page host connected');
  host.api('chat').postMessage({ type: 'ready' });
  let id = 100;
  const viewAsk = async (cmd: string, args?: unknown) => {
    const my = ++id;
    host!.api('chat').postMessage({ type: 'ask', id: my, cmd, ...(args ? { args } : {}) });
    await until(() => answers.some((a) => a.id === my), `the answer to ${cmd}`);
    return answers.find((a) => a.id === my);
  };

  let a = await viewAsk('chats.list');
  const list = a.result as ChatInfo[];
  ok(a.ok && list.length === 5 && !list.some((c) => c.name === currentName), `chats.list from the view: the five past chats, not the one still open (${list.map((c) => c.firstTask).join(', ')})`);
  const byTask = (t: string) => list.find((c) => c.firstTask === t)!;
  ok(byTask('Order paper').outcome === 'done' && byTask('Book a table').outcome === 'stopped' && byTask('Broken').outcome === 'error' && byTask('Pay the bill').outcome === 'needs_user' && byTask('Half done').outcome === undefined && !('outcome' in byTask('Half done')), 'each row carries its outcome, read from the tail');
  ok(!list.some((c) => 'file' in c) && list[0].firstTask === 'Half done', 'no paths in a row; newest first');

  const name = byTask('Order paper').name;
  a = await viewAsk('chats.open', { name });
  ok(a.ok && a.result.info.name === name && a.result.info.outcome === 'done' && JSON.stringify(a.result.items) === JSON.stringify(parseTranscript(fs.readFileSync(path.join(dir, name), 'utf8'))), 'chats.open: the row and exactly the items parseTranscript gives');
  a = await viewAsk('chats.open', { name: '../secrets.json' });
  ok(!a.ok && a.error === 'no such chat', 'chats.open with a path: refused');

  // Refused asks never reach the gateway.
  const secretsBefore = fs.existsSync(path.join(dataDir, 'secrets.json')) ? fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8') : '';
  a = await viewAsk('key.set', { slot: 'deskfish.apiKey.anthropic', key: 'sk-from-a-view' });
  const b = await viewAsk('shutdown');
  const secretsAfter = fs.existsSync(path.join(dataDir, 'secrets.json')) ? fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8') : '';
  ok(!a.ok && !b.ok && /may not ask key\.set/.test(a.error) && secretsAfter === secretsBefore && !secretsAfter.includes('sk-from-a-view'), 'key.set from the view: refused, the secrets file untouched');
  ok((await fetch(`${url}/status`)).ok, 'shutdown from the view: refused, the gateway still answers');

  // Delete one, a path, the open chat, then all.
  a = await viewAsk('chats.delete', { name: byTask('Broken').name });
  ok(a.ok && a.result === 1 && !fs.existsSync(path.join(dir, byTask('Broken').name)), 'chats.delete {name}: that one file is gone');
  a = await viewAsk('chats.delete', { name: '../config.json' });
  ok(!a.ok && fs.readdirSync(dir).length === 5, 'chats.delete with a path: refused, nothing deleted');
  a = await viewAsk('chats.delete', { name: currentName });
  ok(!a.ok && /still open/.test(a.error) && fs.existsSync(path.join(dir, currentName)), 'the chat still open cannot be deleted by name');

  // VS Code's path: answerAsk over a GatewayClient.
  const vs = new GatewayClient({ url, token: TOKEN, client: 'vscode', version: 'test', log: () => {} });
  clients.push(vs);
  void vs.connect();
  await vs.whenConnected(5000);
  const vsAnswers: any[] = [];
  await answerAsk({ id: 1, cmd: 'chats.list' }, (cmd, args) => vs.call(cmd, args as never), (x) => vsAnswers.push(x));
  await answerAsk({ id: 2, cmd: 'shutdown' }, () => { throw new Error('must not be called'); }, (x) => vsAnswers.push(x));
  await answerAsk({ id: 3, cmd: 'snapshot' }, (_cmd, _args, respond) => vs.refreshSnapshot((snap) => respond({ type: 'answer', id: 3, ok: true, result: snap })), (x) => vsAnswers.push(x));
  ok(vsAnswers.length === 3 && vsAnswers[0].ok && vsAnswers[0].result.length === 4 && !vsAnswers[1].ok && vsAnswers[2].ok && vsAnswers[2].result.name === 'deskfish', 'VS Code\'s path: an allowed ask answered, a refused one never called, a snapshot answered once from inside its frame');

  a = await viewAsk('chats.delete');
  ok(a.ok && a.result === 4 && fs.readdirSync(dir).join() === currentName, `chats.delete without a name: every past chat (${a.result}), the open one kept`);
  a = await viewAsk('chats.list');
  ok(a.ok && a.result.length === 0, 'nothing left to list');
} finally {
  for (const c of clients) c.close();
  (host as any)?.ws?.close();
  (host as any)?.retry && clearTimeout((host as any).retry);
  await server.close();
  service.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`panels: ${n} checks passed`);
process.exit(0);
