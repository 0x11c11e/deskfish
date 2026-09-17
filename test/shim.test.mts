// The web page's stand-in for VS Code (web/shim.ts), without a browser. Gateway → views: a snapshot
// rebuilds the chat (newChat, the live transcript, usage, step, running status, desktop, header) and
// the Desktop view (status, connect to /vnc with the token, agent status, screenshot); every event
// becomes the messages ChatViewProvider and DesktopPanel send in VS Code. Views → gateway: every view
// message that is a command becomes a request the gateway's validator accepts; the rest is the page's
// own work (attach → POST /files, save → GET /files/…, key and model dialogs, docs, clipboard). The
// host over a fake socket: hello, the snapshot before later events, errors as toasts, the knock,
// reconnect, and a reload after three refused connections when the token is wrong. Since step 6B the
// panels live in the chat view: its `ask` becomes the command when VIEW_COMMANDS names it (answered in
// the frame that carried it) and is refused without reaching the gateway otherwise; the title bar posts
// `open`; the … menu reflects, exports into the downloads, imports only after the confirm (then rebuilds
// from a snapshot) and deletes past chats after a confirm with the count.
import assert from 'node:assert/strict';
import { validate } from '../src/gateway/protocol';
import type { Snapshot } from '../src/gateway/protocol';
import { DEFAULT_CONFIG } from '../src/gateway/config';
import type { ToChat, ToDesktop } from '../src/webview/protocol';
import { Mirror, WebHost, viewCommand, type HostUi, type ModelChoice, type SocketLike } from '../web/shim';
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
  for (const t of ['ready', 'refresh', 'attach', 'saveFile', 'revealFile', 'openDesktop', 'setApiKey', 'openSettings', 'showLog', 'openDocs', 'copy', 'installRuntime', 'openFile']) ok(viewCommand('chat', { type: t } as any) === undefined, `chat ${t}: the page's own work`);
  for (const [cmd, args] of [['chats.list', undefined], ['chats.open', { name: 'a.md' }], ['chats.delete', { name: 'a.md' }], ['chats.delete', undefined], ['config.set', { patch: { maxSteps: 3 } }], ['schedules.runNow', { id: 's1' }], ['memory.write', { file: 'charter.md', text: 'x' }], ['snapshot', undefined]] as const) {
    const c = viewCommand('chat', { type: 'ask', id: 4, cmd, ...(args ? { args } : {}) } as any);
    const v = validate({ id: 1, cmd: c?.cmd, ...(c?.args ? { args: c.args } : {}) });
    ok(c?.cmd === cmd && v.ok, `ask ${cmd} → the command ${JSON.stringify(c?.args ?? {})} (${v.ok ? 'valid' : (v as any).error})`);
  }
  for (const cmd of ['key.set', 'shutdown', 'desktop.off', 'log.tail', 'nonsense']) ok(viewCommand('chat', { type: 'ask', id: 4, cmd } as any) === undefined, `ask ${cmd}: not a command the view may ask`);
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
    confirm: async () => false,
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

// 5. The panels' bridge, the title bar and the … menu
{
  const sockets: FakeSocket[] = [];
  const posts: { pane: string; m: any }[] = [];
  const toasts: string[] = [];
  const saved: { name: string; blob: Blob }[] = [];
  const confirms: string[] = [];
  const copies: string[] = [];
  let confirmAnswer = false;
  const ui = {
    visible: () => true, connection: () => {}, toast: (t: string) => toasts.push(t), knock: () => {}, showDesktop: () => {}, showLog: () => () => {},
    copy: async (_pane: string, text: string) => { copies.push(text); return true; },
    saveBlob: (name: string, blob: Blob) => saved.push({ name, blob }),
    confirm: async (text: string, action: string) => { confirms.push(`${action}: ${text}`); return confirmAnswer; },
  } as unknown as HostUi;
  const host = new WebHost({ wsUrl: 'ws://gw/ws?token=tok', vncUrl: VNC, token: 'tok', openSocket: (url) => { const x = new FakeSocket(url); sockets.push(x); return x; }, post: (pane, m) => posts.push({ pane, m }), fetch: async () => new Response(''), ui });
  const tick = () => sleep(5);
  const idle = () => snapshot({ status: 'idle', chat: [], usage: undefined, screenshot: undefined });
  const chatPosts = (from: number) => posts.slice(from).filter((p) => p.pane === 'chat').map((p) => p.m);
  host.api('chat').postMessage({ type: 'ready' });
  host.start();
  const s = sockets[0];
  s.open();
  s.reply('hello', idle());
  const valid = (cmd: string) => { const r = s.last(cmd); return !!r && validate(r).ok; };

  // an allowed ask: the command over the socket, its result as the answer
  let mark = posts.length;
  host.api('chat').postMessage({ type: 'ask', id: 7, cmd: 'chats.list' });
  ok(valid('chats.list'), 'ask chats.list → the command, valid');
  s.reply('chats.list', [{ name: 'a.md', startedAt: '2026-09-16 10:00', firstTask: 'Open example.com', bytes: 50, outcome: 'done' }]);
  await tick();
  let answer = chatPosts(mark).find((m) => m.type === 'answer');
  ok(answer?.id === 7 && answer.ok === true && answer.result[0].outcome === 'done', `the answer carries the result: ${JSON.stringify(answer)}`);
  mark = posts.length;
  host.api('chat').postMessage({ type: 'ask', id: 8, cmd: 'chats.open', args: { name: 'gone.md' } });
  ok(valid('chats.open') && s.last('chats.open').args.name === 'gone.md', 'ask with arguments: they travel as given');
  s.reply('chats.open', 'no such chat', false);
  await tick();
  answer = chatPosts(mark).find((m) => m.type === 'answer');
  ok(answer?.id === 8 && answer.ok === false && answer.error === 'no such chat', 'a gateway refusal is an answer too');

  // a refused ask never reaches the gateway
  const sent = s.sent.length;
  mark = posts.length;
  host.api('chat').postMessage({ type: 'ask', id: 9, cmd: 'key.set', args: { slot: 'deskfish.apiKey.anthropic', key: 'sk' } });
  host.api('chat').postMessage({ type: 'ask', id: 10, cmd: 'shutdown' });
  await tick();
  const refused = chatPosts(mark).filter((m) => m.type === 'answer');
  ok(s.sent.length === sent && refused.length === 2 && refused.every((m) => m.ok === false && /may not ask/.test(m.error)), `key.set and shutdown from the view: refused, nothing sent (${refused.map((m) => m.error).join(' | ')})`);

  // a snapshot answer lands before the event after it
  host.api('chat').postMessage({ type: 'ask', id: 11, cmd: 'snapshot' });
  mark = posts.length;
  s.frame({ id: s.last('snapshot').id, ok: true, result: snapshot() });
  s.frame({ event: 'event', data: { type: 'assistant', text: 'after' } });
  await tick();
  ok(types(chatPosts(mark)) === 'answer,event', `the snapshot's answer before the event that follows it: ${types(chatPosts(mark))}`);

  // the title bar opens the panels in the chat view
  for (const panel of ['history', 'schedules', 'settings', 'files'] as const) {
    host.openPanel(panel);
    ok(posts.at(-1)?.pane === 'chat' && posts.at(-1)?.m.type === 'open' && posts.at(-1)?.m.panel === panel, `title bar → open ${panel}`);
  }

  // … Let her reflect now
  let p: Promise<unknown> = host.reflectNow();
  ok(valid('reflect'), 'reflect');
  s.reply('reflect', 'busy');
  await p;
  ok(toasts.at(-1) === 'She is busy; let her finish first.', 'busy → a toast');
  const toastCount = toasts.length;
  p = host.reflectNow();
  s.reply('reflect', 'started');
  await p;
  ok(toasts.length === toastCount, 'started → nothing more (the status line shows it)');

  // Install Podman: the app's gateway opens a terminal on its screen; any other answers false and the command is copied
  s.frame({ event: 'desktop', data: { state: 'error', message: 'no container engine', runtime: { cli: 'none', install: { platform: 'linux', system: 'Debian', command: 'sudo apt-get install -y podman', docsUrl: 'https://podman.io' } } } });
  await tick();
  host.api('chat').postMessage({ type: 'installRuntime' });
  await tick();
  ok(valid('desktop.install'), 'Install Podman asks the gateway first (desktop.install, valid)');
  s.reply('desktop.install', true);
  await tick();
  ok(/^A terminal opened/.test(toasts.at(-1)!) && copies.length === 0, `the app's gateway opened a terminal: a toast, nothing copied (${toasts.at(-1)})`);
  host.api('chat').postMessage({ type: 'installRuntime' });
  await tick();
  s.reply('desktop.install', false);
  await tick();
  ok(copies.at(-1) === 'sudo apt-get install -y podman' && /clipboard/.test(toasts.at(-1)!), 'any other gateway answers false: the command is copied, as before');

  // … Export: the bundle into the downloads, the bytes VS Code writes
  const bundle = { format: 'deskfish-memory', version: 1, exportedAt: '2026-09-16T10:00:00Z', memory: '- tea', self: '# Me', journal: '', chats: [] };
  p = host.exportMemory();
  ok(valid('export'), 'export');
  s.reply('export', bundle);
  await p;
  ok(/^deskfish-export-\d{4}-\d{2}-\d{2}\.json$/.test(saved.at(-1)!.name) && (await saved.at(-1)!.blob.text()) === JSON.stringify(bundle, null, 1), `export → ${saved.at(-1)!.name}, byte for byte what VS Code's export writes`);

  // … Import: only through the confirm, with VS Code's words; then the page rebuilds
  const file = new File([JSON.stringify(bundle)], 'backup.json');
  confirmAnswer = false;
  await host.importMemory([file]);
  ok(confirms.at(-1) === 'Import: Replace her facts, her self file and her journal with the ones in this file? The current versions are kept in her history, but the next chat starts from the imported ones.' && !s.last('import'), 'import asks first, with VS Code\'s exact question; Cancel sends nothing');
  confirmAnswer = true;
  p = host.importMemory([file]);
  await tick();
  ok(valid('import') && s.last('import').args.bundle.self === '# Me', 'confirmed → import {bundle}');
  s.reply('import', null);
  await tick();
  mark = posts.length;
  s.reply('snapshot', idle());
  await p;
  ok(chatPosts(mark)[0]?.type === 'newChat' && /imported/.test(toasts.at(-1)!), 'then a fresh snapshot rebuilds the chat');
  const confirmsBefore = confirms.length;
  await host.importMemory([new File(['{"format":"something else"}'], 'x.json')]);
  await host.importMemory([new File(['not json'], 'y.json')]);
  ok(confirms.length === confirmsBefore && toasts.at(-1) === 'That file is not a memory export.', 'a file that is not an export is refused before the question');

  // … Delete all past chats: the count in the question, then chats.delete without a name
  confirmAnswer = true;
  p = host.deleteAllChats();
  s.reply('chats.list', [{ name: 'a.md' }, { name: 'b.md' }]);
  await tick();
  ok(confirms.at(-1) === 'Delete: Delete all 2 past chats? Her journal, facts and self are not touched.', `asks with the count: ${confirms.at(-1)}`);
  ok(valid('chats.delete') && !s.last('chats.delete').args, 'chats.delete without a name (all)');
  s.reply('chats.delete', 2);
  await p;
  ok(toasts.at(-1) === 'Deleted 2 past chats.', 'and says how many');
  p = host.deleteAllChats();
  s.reply('chats.list', []);
  await p;
  ok(toasts.at(-1) === 'There are no past chats.', 'none: nothing to ask');
  (host as any).retry && clearTimeout((host as any).retry);
}

console.log(`shim: ${n} checks passed`);
process.exit(0);
