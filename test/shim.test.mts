// The web page's stand-in for VS Code (web/shim.ts), without a browser. Gateway → views: a snapshot
// rebuilds the chat (newChat, the live transcript, usage, step, running status, desktop, header) and
// the Desktop view (status, connect to /vnc with the token, agent status, screenshot); every event
// becomes the messages ChatViewProvider and DesktopPanel send in VS Code. Views → gateway: every view
// message that is a command becomes a request the gateway's validator accepts; the rest is the page's
// own work (attach → POST /files, save → GET /files/…, key and model dialogs, docs, clipboard). The
// host over a fake socket: hello, the snapshot before later events, errors as toasts, the knock,
// reconnect, and a reload after three refused connections when the token is wrong. The Settings dialog:
// fields read into config values, a save sends only what the person changed (never the model's keys),
// a refusal names its field; the Schedules dialog: every call a schedules.* command the validator accepts.
import assert from 'node:assert/strict';
import { validate } from '../src/gateway/protocol';
import type { Snapshot } from '../src/gateway/protocol';
import { DEFAULT_CONFIG } from '../src/gateway/config';
import type { ToChat, ToDesktop } from '../src/webview/protocol';
import { Mirror, WebHost, fieldInput, readField, refusalOf, viewCommand, type HostUi, type ModelChoice, type ScheduleActions, type SettingsRefusal, type SocketLike } from '../web/shim';
import { applyConfigPatch, type DeskfishConfig } from '../src/gateway/config';
import { settingsSchema, type SettingsSchema } from '../src/gateway/settingsSchema';
import fs from 'node:fs';
import { PRESETS } from '../src/agent/presets';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VNC = 'ws://127.0.0.1:9980/vnc?token=tok';
const types = (ms: { type: string }[]) => ms.map((m) => m.type).join(',');

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  name: 'deskfish', version: 't', protocol: 1, dataDir: '/data', status: 'running', statusMessage: 'Working', screenFree: false, busy: true, queued: 0,
  chat: [{ kind: 'user', text: 'Open example.com' }, { kind: 'assistant', text: 'On it.' }],
  usage: { type: 'usage', input: 100, output: 20 },
  screenshot: { dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 800, step: 3 },
  desktop: { status: { state: 'on' } },
  config: { ...DEFAULT_CONFIG, vncPassword: 'pw' },
  keys: ['deskfish.apiKey.anthropic'],
  ...over,
});

// 1. A snapshot rebuilds both views
{
  const m = new Mirror(VNC);
  const out = m.absorbSnapshot(snapshot());
  ok(types(out.chat) === 'newChat,replay,event,event,event,desktop,config', `chat from a snapshot: ${types(out.chat)}`);
  const replay = out.chat[1] as Extract<ToChat, { type: 'replay' }>;
  ok(replay.live === true && replay.items.length === 2 && replay.title === '', 'the transcript is replayed live (no "past chat" line)');
  const [usage, shot, status] = out.chat.slice(2, 5).map((x) => (x as Extract<ToChat, { type: 'event' }>).event);
  ok(usage.type === 'usage' && shot.type === 'screenshot' && shot.step === 3 && shot.jpegBase64 === '' && status.type === 'status' && status.status === 'running', 'usage, the step counter without its image, the running status');
  const cfg = (out.chat[6] as Extract<ToChat, { type: 'config' }>).config;
  ok(cfg.model === DEFAULT_CONFIG.model && cfg.hasApiKey === true && cfg.keyStored === 'Stored in the gateway' && cfg.desktop.state === 'on', `header: ${JSON.stringify(cfg)}`);
  ok(types(out.desktop) === 'desktop,connect,agentStatus,screenshot', `desktop view from a snapshot: ${types(out.desktop)}`);
  const connect = out.desktop[1] as Extract<ToDesktop, { type: 'connect' }>;
  ok(connect.url === VNC && connect.password === 'pw', 'the live view connects to /vnc with the token and the VNC password');
  const idle = new Mirror(VNC).absorbSnapshot(snapshot({ status: 'done', chat: [], usage: undefined, screenshot: undefined, keys: [] }));
  ok(types(idle.chat) === 'newChat,desktop,config' && (idle.chat[2] as Extract<ToChat, { type: 'config' }>).config.hasApiKey === false, `a finished, empty chat: ${types(idle.chat)}, no key`);
}

// 2. Events → the two views
{
  const m = new Mirror(VNC);
  m.absorbSnapshot(snapshot({ desktop: { status: { state: 'off' } }, screenshot: undefined }));
  let o = m.event('event', { type: 'status', status: 'paused', message: 'Waiting for you', screenFree: false });
  ok(types(o.chat) === 'event' && types(o.desktop) === 'agentStatus' && (o.desktop[0] as any).message === 'Waiting for you', 'status → chat event + agentStatus');
  o = m.event('event', { type: 'action', step: 1, action: { type: 'click', x: 1, y: 2, button: 'left', count: 1 }, result: { ok: true } } as any);
  ok(types(o.chat) === 'event' && types(o.desktop) === 'agentAction', 'action → chat event + her pointer');
  o = m.event('event', { type: 'screenshot', step: 2, jpegBase64: 'BBBB', width: 10, height: 20 });
  ok(types(o.desktop) === 'screenshot' && (o.desktop[0] as any).dataUrl === 'data:image/jpeg;base64,BBBB' && m.screenshot?.width === 10, 'screenshot → the Desktop placeholder');
  ok(types(m.event('event', { type: 'screenshot', step: 2, jpegBase64: '', width: 10, height: 20 }).desktop) === '', 'a screenshot without an image reaches only the chat');
  o = m.event('desktop', { state: 'on' });
  ok(types(o.chat) === 'desktop' && types(o.desktop) === 'desktop,connect', `off → on: status to both, and the live view connects (${types(o.desktop)})`);
  o = m.event('desktop', { state: 'on' });
  ok(!o.chat.length && !o.desktop.length, 'a repeated "still on" is not news');
  o = m.event('desktop', { state: 'on', message: 'x' });
  ok(types(o.desktop) === 'desktop', 'a new message on an "on" desktop: no reconnect');
  m.event('desktop', { state: 'stopping' });
  ok(m.screenshot === undefined, 'the old screenshot is dropped once the desktop is not on');
  ok(types(m.event('reset', undefined).chat) === 'newChat', 'reset → newChat');
  o = m.event('replay', { title: 'Chat of 2026-09-14', items: [{ kind: 'user', text: 'hi' }] });
  ok(types(o.chat) === 'replay' && !(o.chat[0] as any).live && (o.chat[0] as any).title === 'Chat of 2026-09-14', 'a reopened past chat keeps its "past chat" line');
  ok((m.event('schedule', { kind: 'fired', text: 'Every day: coffee', task: 'coffee', auto: true }).chat[0] as any).type === 'user', 'a fired schedule shows as the task');
  ok((m.event('schedule', { kind: 'missed', text: 'Missed: coffee', task: 'coffee', auto: true }).chat[0] as any).type === 'notice', 'a missed one as a notice');
  ok((m.event('notice', { text: 'queued' }).chat[0] as any).text === 'queued', 'notice');
  o = m.event('download', { name: 'r.pdf', path: '/home/bot/Downloads/r.pdf', size: 5, extra: 1 } as any);
  ok(JSON.stringify((o.chat[0] as any).file) === JSON.stringify({ name: 'r.pdf', path: '/home/bot/Downloads/r.pdf', size: 5 }), 'download → a card with name, path and size only');
  o = m.event('config', { ...DEFAULT_CONFIG, provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'm' });
  ok((o.chat[0] as any).config.model === 'm' && (o.chat[0] as any).config.hasApiKey === false, 'config → header (no key for openrouter yet)');
  o = m.event('keys', ['deskfish.apiKey.openrouter.ai']);
  ok((o.chat[0] as any).config.hasApiKey === true, 'keys → the key row flips to stored');
  for (const name of ['task', 'log', 'desktop.hostNetwork', 'desktop.startFailed', 'desktop.stopFailed'] as const) {
    const x = m.event(name, (name === 'task' ? { text: 't' } : 'x') as never);
    ok(!x.chat.length && !x.desktop.length, `${name}: nothing for the views`);
  }
}

// 3. View messages → commands the gateway accepts; the rest stays in the page
{
  const file = { name: 'a.txt', path: '/home/bot/Uploads/a.txt', size: 3, extra: true } as any;
  const cases: [Parameters<typeof viewCommand>[0], any, string][] = [
    ['chat', { type: 'run', task: 'do it', attachments: [file] }, 'run'],
    ['chat', { type: 'run', task: 'do it', attachments: [] }, 'run'],
    ['chat', { type: 'say', text: 'also this' }, 'say'],
    ['chat', { type: 'stop' }, 'stop'],
    ['chat', { type: 'pause' }, 'pause'],
    ['chat', { type: 'resume' }, 'resume'],
    ['chat', { type: 'startDesktop' }, 'desktop.on'],
    ['chat', { type: 'stopDesktop' }, 'desktop.off'],
    ['chat', { type: 'restartDesktop' }, 'desktop.restart'],
    ['desktop', { type: 'takeover' }, 'pause'],
    ['desktop', { type: 'handback' }, 'resume'],
    ['desktop', { type: 'startDesktop' }, 'desktop.on'],
    ['desktop', { type: 'releaseInput' }, 'releaseInput'],
  ];
  for (const [pane, msg, cmd] of cases) {
    const c = viewCommand(pane, msg);
    const v = validate({ id: 1, cmd: c?.cmd, ...(c?.args ? { args: c.args } : {}) });
    ok(c?.cmd === cmd && v.ok, `${pane} ${msg.type} → ${c?.cmd} ${JSON.stringify(c?.args ?? {})} (${v.ok ? 'valid' : (v as any).error})`);
  }
  ok(JSON.stringify(viewCommand('chat', cases[0][1])?.args) === JSON.stringify({ task: 'do it', attachments: [{ name: 'a.txt', path: '/home/bot/Uploads/a.txt', size: 3 }] }), 'attachments travel as name, path, size');
  ok(!('attachments' in (viewCommand('chat', cases[1][1])?.args ?? {})), 'no attachments key for none');
  for (const t of ['ready', 'refresh', 'attach', 'saveFile', 'revealFile', 'openDesktop', 'setApiKey', 'openSettings', 'showLog', 'openDocs', 'copy', 'installRuntime']) ok(viewCommand('chat', { type: t } as any) === undefined, `chat ${t}: the page's own work`);
  for (const t of ['ready', 'clipboardSync', 'clipboardChanged', 'log']) ok(viewCommand('desktop', { type: t } as any) === undefined, `desktop ${t}: the page's own work`);
}

// 4. The host over a fake socket
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: any[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); }
  frame(x: unknown) { this.onmessage?.({ data: JSON.stringify(x) }); }
  last(cmd: string) { return [...this.sent].reverse().find((s) => s.cmd === cmd); }
  reply(cmd: string, result: unknown, okay = true) { const r = this.last(cmd); this.frame(okay ? { id: r.id, ok: true, result } : { id: r.id, ok: false, error: result }); }
}
{
  const sockets: FakeSocket[] = [];
  const posts: { pane: string; m: any }[] = [];
  const toasts: string[] = [];
  const knocks: boolean[] = [];
  const fetches: { url: string; init?: RequestInit }[] = [];
  const saved: string[] = [];
  let connection: boolean | undefined;
  let reloads = 0;
  let keyAnswer: string | undefined = ' sk-ant-test ';
  let modelAnswer: ModelChoice | undefined;
  let docsLoader: (() => Promise<Blob>) | undefined;
  let clip: string | undefined = 'from the browser';
  let fetchReply = (url: string, init?: RequestInit): Response => new Response(JSON.stringify({ name: 'a.txt', path: '/home/bot/Uploads/a.txt', size: 3 }), { status: 200 });
  const ui: HostUi = {
    visible: () => true,
    connection: (c) => (connection = c),
    toast: (t) => toasts.push(t),
    knock: (on) => knocks.push(on),
    showDesktop: () => {},
    pickFiles: async () => [new File(['abc'], 'a b.txt')],
    saveBlob: (name) => saved.push(name),
    copy: async () => true,
    readClipboard: async () => clip,
    writeClipboard: async () => {},
    openDocs: (_pane, load) => (docsLoader = load),
    askKey: async () => keyAnswer,
    askModel: async () => modelAnswer,
    showLog: () => () => {},
    reload: () => reloads++,
  };
  const host = new WebHost({
    wsUrl: 'ws://gw/ws?token=tok', vncUrl: VNC, token: 'tok',
    openSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    post: (pane, m) => posts.push({ pane, m }),
    fetch: async (url, init) => { fetches.push({ url, init }); return fetchReply(url, init); },
    ui,
  });
  const tick = () => sleep(5);
  const postsFor = (pane: string, from = 0) => posts.slice(from).filter((p) => p.pane === pane).map((p) => p.m);

  host.api('desktop').postMessage({ type: 'ready' });
  host.api('chat').postMessage({ type: 'ready' });
  ok(posts.length === 0, `before the gateway answers: both views wait for the snapshot, no connect attempt on an unknown desktop (${posts.length} posted)`);
  host.start();
  const s = sockets[0];
  ok(s.url === 'ws://gw/ws?token=tok', 'the socket goes to /ws with the token');
  s.open();
  const hello = s.last('hello');
  ok(hello && hello.args.client === 'web' && validate(hello).ok, `hello as a web client: ${JSON.stringify(hello)}`);
  let mark = posts.length;
  s.reply('hello', snapshot());
  ok(connection === true && types(postsFor('chat', mark)) === 'newChat,replay,event,event,event,desktop,config' && types(postsFor('desktop', mark)) === 'desktop,connect,agentStatus,screenshot', 'connected: both views rebuilt from the snapshot');
  ok(s.last('desktop.poll')?.args.on === true, 'the desktop health poll is asked for while the page is visible');

  // the chat reopens: a fresh snapshot, rendered before the event that follows it
  host.api('chat').postMessage({ type: 'ready' });
  mark = posts.length;
  const snapReq = s.last('snapshot');
  s.frame({ id: snapReq.id, ok: true, result: snapshot({ chat: [], usage: undefined, status: 'idle', screenshot: undefined }) });
  s.frame({ event: 'event', data: { type: 'assistant', text: 'after' } });
  await tick();
  ok(types(postsFor('chat', mark)) === 'newChat,desktop,config,event', `snapshot first, then the event: ${types(postsFor('chat', mark))}`);

  // commands, errors, the knock
  host.api('chat').postMessage({ type: 'run', task: 'Open example.com' });
  ok(s.last('run')?.args.task === 'Open example.com', 'run goes over the socket');
  s.reply('run', 'the desktop did not come up', false);
  await tick();
  ok(toasts.at(-1) === 'Could not start the task: the desktop did not come up', `an error becomes a toast: ${toasts.at(-1)}`);
  host.api('desktop').postMessage({ type: 'takeover' });
  ok(s.last('pause'), 'Take over pauses');
  s.frame({ event: 'event', data: { type: 'needs_user', reason: 'log in', jpegBase64: '' } });
  s.frame({ event: 'event', data: { type: 'status', status: 'running' } });
  ok(knocks.join() === 'true,false', `the knock and its end reach the tab title: ${knocks.join()}`);

  // clipboard: only a paste reads the browser's clipboard
  host.api('desktop').postMessage({ type: 'clipboardSync', paste: false });
  await tick();
  ok(!s.last('clipboard.set'), 'focus and clicks read nothing');
  host.api('desktop').postMessage({ type: 'clipboardSync', paste: true });
  await tick();
  ok(s.last('clipboard.set')?.args.text === 'from the browser', 'a paste sends the browser clipboard into the tank');
  mark = posts.length;
  s.reply('clipboard.set', true);
  await tick();
  ok(JSON.stringify(postsFor('desktop', mark)[0]) === JSON.stringify({ type: 'clipboardSynced', ok: true, paste: true }), 'then the view pastes');
  clip = undefined;
  mark = posts.length;
  host.api('desktop').postMessage({ type: 'clipboardSync', paste: true });
  await tick();
  ok(postsFor('desktop', mark)[0]?.ok === false, 'a refused clipboard read still lets the view paste what the tank has');

  // attach: desktop.on, then POST /files with the token in a header
  host.api('chat').postMessage({ type: 'attach' });
  await tick();
  s.reply('desktop.on', true);
  await tick();
  const up = fetches.at(-1)!;
  ok(up.url === '/files?name=a%20b.txt' && up.init?.method === 'POST' && (up.init.headers as any).authorization === 'Bearer tok' && up.init.body instanceof File, `attach uploads with a Bearer header, no token in the URL: ${up.url}`);
  await tick();
  ok(posts.at(-1)?.m.type === 'attached' && posts.at(-1)?.m.files[0].path === '/home/bot/Uploads/a.txt', 'the uploaded file shows in the composer');

  // save: GET /files/<path> with the token in a header, to the browser's downloads
  s.frame({ event: 'desktop', data: { state: 'on' } });
  fetchReply = () => new Response('bytes', { status: 200 });
  host.api('chat').postMessage({ type: 'saveFile', file: { name: 'a b.txt', path: '/home/bot/Downloads/a b.txt', size: 5 } });
  await tick();
  ok(fetches.at(-1)!.url === '/files/home/bot/Downloads/a%20b.txt' && (fetches.at(-1)!.init?.headers as any).authorization === 'Bearer tok', `save downloads with a Bearer header: ${fetches.at(-1)!.url}`);
  ok(saved.at(-1) === 'a b.txt' && posts.at(-1)?.m.type === 'saveFailed' && posts.at(-1)?.m.error === '', 'handed to the browser, the card button comes back');
  fetchReply = () => new Response(JSON.stringify({ error: 'no such file' }), { status: 500 });
  host.api('chat').postMessage({ type: 'saveFile', file: { name: 'x', path: '/home/bot/Downloads/x', size: 1 } });
  await tick();
  ok(posts.at(-1)?.m.type === 'saveFailed' && posts.at(-1)?.m.error === 'no such file', 'a failed save says why on the card');

  // the key: the current provider's slot, trimmed; the header updates
  host.api('chat').postMessage({ type: 'setApiKey' });
  await tick();
  const keySet = s.last('key.set');
  ok(keySet?.args.slot === 'deskfish.apiKey.anthropic' && keySet.args.key === 'sk-ant-test' && validate(keySet).ok, `key.set for the current slot: ${keySet?.args.slot}`);
  mark = posts.length;
  s.reply('key.set', ['deskfish.apiKey.anthropic']);
  await tick();
  ok(postsFor('chat', mark)[0]?.config?.hasApiKey === true && /saved/.test(toasts.at(-1)!), 'header says stored, toast says saved');

  // the model: model.set, then the key when that place needs one and has none
  modelAnswer = { preset: PRESETS.find((p) => p.id === 'openrouter')!, provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5' };
  keyAnswer = undefined;
  host.api('chat').postMessage({ type: 'openSettings' });
  await tick();
  const ms = s.last('model.set');
  ok(ms && validate(ms).ok && ms.args.model === 'anthropic/claude-sonnet-5', 'model.set with a valid shape');
  let asked = false;
  ui.askKey = async (title) => { asked = /OpenRouter/.test(title); return undefined; };
  s.reply('model.set', { ...DEFAULT_CONFIG, provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5' });
  await tick();
  ok(asked, 'no OpenRouter key yet: the key dialog follows');

  // docs: fetched with the token in a header
  fetchReply = () => new Response('<!doctype html><title>docs</title>', { status: 200, headers: { 'content-type': 'text/html' } });
  host.api('chat').postMessage({ type: 'openDocs' });
  const blob = await docsLoader!();
  ok(fetches.at(-1)!.url === '/docs' && (fetches.at(-1)!.init?.headers as any).authorization === 'Bearer tok' && (await blob.text()).includes('docs'), 'docs come from /docs with a Bearer header');

  // the socket drops: pending calls fail, the banner, a new socket after the backoff
  host.api('chat').postMessage({ type: 'stop' });
  s.close();
  await tick();
  ok(connection === false && /Could not stop/.test(toasts.at(-1)!), 'a call in flight fails when the socket drops');
  await sleep(600);
  ok(sockets.length === 2, 'reconnects after the backoff');

  // three refused connections and a 401 on the probe: reload into the sign-in page
  fetchReply = () => new Response('', { status: 401 });
  for (let i = 0; i < 3; i++) {
    const cur = sockets.at(-1)!;
    cur.close();
    await sleep(i === 0 ? 1100 : i === 1 ? 2100 : 50);
  }
  await tick();
  ok(reloads === 1 && fetches.at(-1)!.url === '/docs' && fetches.at(-1)!.init?.method === 'HEAD', `refused three times and the token check says 401: reload (${reloads})`);
  host['retry'] && clearTimeout(host['retry']);
  (host as any).env.openSocket = () => new FakeSocket('x');
}

// 5. The Settings and Schedules dialogs
{
  const schema = settingsSchema(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
  const entry = (k: keyof DeskfishConfig) => schema.find((e) => e.key === k)!;
  ok(JSON.stringify(readField(entry('temperature'), '')) === '{"value":null}' && JSON.stringify(readField(entry('temperature'), '0.4')) === '{"value":0.4}', 'temperature: empty = null, a number = that number');
  ok('error' in readField(entry('maxSteps'), '') && 'error' in readField(entry('maxSteps'), 'lots') && JSON.stringify(readField(entry('maxSteps'), '25')) === '{"value":25}', 'a number field needs a number');
  ok(JSON.stringify(readField(entry('autoStart'), false)) === '{"value":false}' && JSON.stringify(readField(entry('effort'), '')) === '{"value":""}' && 'error' in readField(entry('effort'), 'extreme'), 'a checkbox, an enum (empty = default), a value outside the enum');
  ok(JSON.stringify(readField(entry('userName'), '  Iman ')) === '{"value":"Iman"}' && JSON.stringify(readField(entry('vncPassword'), ' pw ')) === '{"value":" pw "}', 'the name is trimmed as VS Code reads it; a password is not');
  ok(fieldInput(entry('temperature'), DEFAULT_CONFIG) === '' && fieldInput(entry('autoStart'), DEFAULT_CONFIG) === true && fieldInput(entry('maxSteps'), DEFAULT_CONFIG) === '0', 'the form shows null as empty');
  ok(refusalOf('bad value for effort').key === 'effort' && refusalOf('unknown setting: colour').key === ('colour' as any) && refusalOf('Deskfish is not connected').key === undefined, 'a refusal names its field when the gateway says which');

  const sockets: FakeSocket[] = [];
  let edit: { schema: SettingsSchema; cfg: DeskfishConfig; save: (v: DeskfishConfig) => Promise<SettingsRefusal | undefined> } | undefined;
  let actions: ScheduleActions | undefined;
  let closeSchedules = () => {};
  const rows: any[][] = [];
  const notes: string[] = [];
  const toasts: string[] = [];
  const ui = {
    visible: () => true, connection: () => {}, toast: (t: string) => toasts.push(t), knock: () => {}, showDesktop: () => {},
    editSettings: async (sch: SettingsSchema, cfg: DeskfishConfig, save: any) => { edit = { schema: sch, cfg, save }; },
    showSchedules: (a: ScheduleActions, onClose: () => void) => { actions = a; closeSchedules = onClose; return { rows: (r: any[]) => rows.push(r), note: (t: string) => notes.push(t) }; },
  } as unknown as HostUi;
  const host = new WebHost({ wsUrl: 'ws://gw/ws?token=tok', vncUrl: VNC, token: 'tok', openSocket: (url) => { const x = new FakeSocket(url); sockets.push(x); return x; }, post: () => {}, fetch: async () => new Response(''), ui });
  const tick = () => sleep(5);
  host.start();
  const s = sockets[0];
  s.open();
  s.reply('hello', snapshot({ status: 'idle', chat: [], usage: undefined, screenshot: undefined }));
  const valid = (cmd: string) => { const r = s.last(cmd); return !!r && validate(r).ok; };

  // Settings: the schema is asked once, the dialog opens on the config the page already has
  const opening = host.openSettings();
  ok(valid('config.schema') && !s.last('config.get'), 'Settings asks config.schema (and never config.get: the page has the config)');
  s.reply('config.schema', schema);
  await opening;
  ok(edit?.schema.length === 28 && edit.cfg.vncPassword === 'pw', 'the dialog gets the schema and the current config');
  const opened = edit!.cfg;
  let saving = edit!.save({ ...opened, maxSteps: 25, autoStart: false, model: 'sneaky-model' });
  await tick();
  const set = s.last('config.set');
  ok(valid('config.set') && JSON.stringify(set.args.patch) === '{"maxSteps":25,"autoStart":false}', `Save sends only what changed, never the model's keys: ${JSON.stringify(set.args.patch)}`);
  ok(!!applyConfigPatch(DEFAULT_CONFIG, set.args.patch), 'every value in the patch is one the gateway accepts');
  s.reply('config.set', { ...opened, maxSteps: 25, autoStart: false });
  ok((await saving) === undefined, 'saved: the dialog may close');
  const sent = s.sent.length;
  ok((await edit!.save({ ...opened })) === undefined && s.sent.length === sent, 'nothing changed: nothing sent, the dialog closes');
  saving = edit!.save({ ...opened, effort: 'extreme' as any });
  await tick();
  s.reply('config.set', 'bad value for effort', false);
  const refused = await saving;
  ok(refused?.key === 'effort' && /Not accepted: bad value for effort/.test(refused.message), `a refusal lands on its field: ${JSON.stringify(refused)}`);
  // Another client changes a setting while the dialog is open: Save does not send the old value back.
  s.frame({ event: 'config', data: { ...opened, maxCostUsd: 9 } });
  saving = edit!.save({ ...opened, reflectEvery: 3 });
  await tick();
  ok(JSON.stringify(s.last('config.set').args.patch) === '{"reflectEvery":3}', 'a value changed elsewhere while the dialog was open is not sent back');
  s.reply('config.set', { ...opened, maxCostUsd: 9, reflectEvery: 3 });
  await saving;
  const again = host.openSettings();
  await again;
  ok(s.sent.filter((x) => x.cmd === 'config.schema').length === 1 && edit!.cfg.maxCostUsd === 9, 'the schema is asked once per page; the dialog reopens on the newer config');

  // Schedules
  const listReply = { schedules: [{ id: 's1', task: 'water', when: { kind: 'daily', time: '09:00' }, createdAt: '2026-09-16T10:00:00Z' }], lines: ['every day at 09:00 — water · next 2026-09-17 09:00'] };
  const openingS = host.openSchedules();
  ok(/\$2\.00/.test(actions?.budgetHint ?? '') && valid('schedules.list'), `the dialog opens with the budget the setting gives (${actions?.budgetHint}) and lists`);
  s.reply('schedules.list', listReply);
  await openingS;
  ok(JSON.stringify(rows.at(-1)) === JSON.stringify([{ id: 's1', line: listReply.lines[0] }]), 'each row: the gateway\'s line, the schedule\'s id for its buttons');
  let adding = actions!.add({ kind: 'weekly', day: '1', time: '07:00', task: ' water the plants ', autonomy: 'free', budget: '1.5' });
  await tick();
  const add = s.last('schedules.add');
  ok(valid('schedules.add') && JSON.stringify(add.args) === JSON.stringify({ task: 'water the plants', when: { kind: 'weekly', day: 1, time: '07:00' }, autonomy: 'free', maxCostUsd: 1.5 }), `Add → schedules.add with the fence: ${JSON.stringify(add.args)}`);
  s.reply('schedules.add', { id: 's2', task: 'water the plants', when: add.args.when, createdAt: 'x', autonomy: 'free', maxCostUsd: 1.5 });
  await tick();
  s.reply('schedules.list', { schedules: [...listReply.schedules, { id: 's2' }], lines: [listReply.lines[0], 'every Monday at 07:00 — water the plants · free · budget $1.50'] });
  const added = await adding;
  ok('done' in added && /every Monday at 07:00 — water the plants/.test(added.done) && rows.at(-1)!.length === 2, `added, the list refreshed: ${JSON.stringify(added)}`);
  adding = actions!.add({ kind: 'once', at: '2030-01-02T07:30', task: 'call', autonomy: 'guided', budget: '' });
  await tick();
  ok(valid('schedules.add') && !('maxCostUsd' in s.last('schedules.add').args) && s.last('schedules.add').args.autonomy === 'guided', 'no budget typed: no maxCostUsd (the setting applies)');
  s.reply('schedules.add', 'that time has already passed', false);
  const late = await adding;
  ok('error' in late && /already passed/.test(late.error), 'the gateway\'s refusal is shown in the dialog');
  const before = s.sent.length;
  const bad1 = await actions!.add({ kind: 'every', minutes: '3', task: 'x', autonomy: 'guided', budget: '' });
  const bad2 = await actions!.add({ kind: 'daily', time: '09:00', task: 'x', autonomy: 'guided', budget: '-2' });
  const bad3 = await actions!.add({ kind: 'daily', time: '09:00', task: '  ', autonomy: 'guided', budget: '' });
  ok('error' in bad1 && 'error' in bad2 && 'error' in bad3 && s.sent.length === before, 'too often, a negative budget, no task: said in the dialog, nothing sent');
  const removing = actions!.remove('s1');
  await tick();
  ok(valid('schedules.remove') && s.last('schedules.remove').args.id === 's1', 'Remove → schedules.remove {id}');
  s.reply('schedules.remove', null);
  await tick();
  ok(s.sent.at(-1).cmd === 'schedules.list', 'the list refreshes after Remove');
  s.reply('schedules.list', { schedules: [], lines: [] });
  ok((await removing) === undefined && rows.at(-1)!.length === 0, 'removed');
  const running = actions!.runNow('s2');
  await tick();
  ok(valid('schedules.runNow') && s.last('schedules.runNow').args.id === 's2', 'Run now → schedules.runNow {id}');
  s.reply('schedules.runNow', null);
  await running;
  s.frame({ event: 'schedule', data: { kind: 'fired', text: '⏰ water', task: 'water', auto: true } });
  await tick();
  ok(s.sent.at(-1).cmd === 'schedules.list', 'a schedule event refreshes the open list');
  s.reply('schedules.list', { schedules: [], lines: [] });
  closeSchedules();
  const quiet = s.sent.length;
  s.frame({ event: 'schedule', data: { kind: 'missed', text: 'missed', task: 'water', auto: true } });
  await tick();
  ok(s.sent.length === quiet, 'closed: a schedule event asks nothing');
  (host as any).retry && clearTimeout((host as any).retry);
}

console.log(`shim: ${n} checks passed`);
process.exit(0);
