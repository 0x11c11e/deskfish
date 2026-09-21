// The uplink (src/gateway/uplink.ts) — the whole road from a browser to her, in one process: the
// step-2 relay on a free port, a real `startGateway` on a temp data dir with a mock daemon, a fake
// websockify and a fake model, and a fake page made of `ws` + step 1's channel.
//
// `deskfish remote`'s three moves over the wire (enroll spends a code and keeps the key here,
// password stores a record the client made from a password it never sent, off stops the dialling);
// the uplink dials out and the relay holds it; a page signs in with the right password and gets the
// snapshot, runs a task and hears its events; the live view is a byte pipe to websockify; a file
// goes into the tank and comes back out; a wrong password is refused five times and the sixth is
// told to wait; `remote off` drops the uplink and a page is told she is not connected; a relay that
// restarts is dialled again; and the relay's tap of everything it carried holds none of the
// plaintext — not the protocol's words, not the chat, not the file, and not the gateway token.
//
// The page here is the page that ships: `web/remote.ts`'s own `signIn`, `protocolSocket`,
// `vncChannel` and `fileTransfer`, run in Node against the real relay and the real gateway. Only
// its DOM is left out (`webpage.test.mts` has the built file).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import WebSocket, { WebSocketServer } from 'ws';
import { GatewayClient } from '../src/gateway/client';
import type { DeskfishConfig } from '../src/gateway/config';
import { startGateway } from '../src/gateway/start';
import { RemoteUplink, newUplinkKey, type ClientLink, type UplinkHost } from '../src/gateway/uplink';
import { Channel, LoginRefused, StreamKind, handleOf, readMessages, register, writeMessage, type RemoteRecord, type Stream } from '../src/remote/channel';
import { fileTransfer, protocolSocket, signIn as pageSignIn, vncChannel, type Live } from '../web/remote';
// @ts-expect-error — the relay is its own plain-JavaScript package; it has no types and imports nothing of ours.
import { startRelay } from '../relay/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const te = new TextEncoder();
const td = new TextDecoder();
async function until(pred: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}

const USER = 'iman';
/** What the relay is told instead of her name, derived by both ends (`channel.ts`). */
const HANDLE = await handleOf(USER);
const PASSWORD = 'a long enough passphrase for her tank';
const ADMIN = 'an-admin-key-only-the-operator-has';

/* ---------- the tank, the screen and the model, all faked ---------- */

const png = PNG.sync.write(new PNG({ width: 64, height: 40 })).toString('base64');
const UPLOADED: { path: string; data: string }[] = [];
const REPORT = Buffer.from('%PDF-1.4 the quarterly report, which the relay must never see');
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
      case 'write_file': UPLOADED.push({ path: body.path, data: body.data }); return reply({ success: true });
      case 'read_file': return body.path === '/home/bot/Downloads/report.pdf' ? reply({ success: true, data: { name: 'report.pdf', data: REPORT.toString('base64') } }) : reply({ success: false, error: 'no such file' });
      default: return reply({ success: true, data: {} });
    }
  });
});
await new Promise<void>((r) => daemon.listen(0, '127.0.0.1', r));
const daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;

// A websockify that echoes every frame, so the live view's pipe is provable end to end.
const vncHttp = http.createServer();
const vncWss = new WebSocketServer({ server: vncHttp, path: '/websockify', handleProtocols: (p) => (p.has('binary') ? 'binary' : false) });
const vncProtocols: string[] = [];
vncWss.on('connection', (ws) => {
  vncProtocols.push(ws.protocol);
  ws.on('message', (d) => ws.send(d, { binary: true }));
});
await new Promise<void>((r) => vncHttp.listen(0, '127.0.0.1', r));
const vncUrl = `ws://127.0.0.1:${(vncHttp.address() as AddressInfo).port}/websockify`;

const ANSWER = 'Looked at the screen; nothing needed doing.';
const model = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;

/* ---------- the relay, with a tap of every frame it carried ---------- */

const tap: { from: string; clientId: number; bytes: Buffer }[] = [];
// Everything the relay would print at RELAY_LOG=events, kept so it can be read for her name.
const relaySaid: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => void relaySaid.push(a.join(' '));
const relayData = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-uplink-relay-'));
const relayOptions = { host: '127.0.0.1', adminKey: ADMIN, dataDir: relayData, log: 'events', env: {}, onFrame: (f: any) => tap.push(f) };
let relay = startRelay({ port: 0, ...relayOptions });
let relayPort: number = await relay.listening;
const relayWs = () => `ws://127.0.0.1:${relayPort}`;

const mintCode = async () => {
  const res = await fetch(`http://127.0.0.1:${relayPort}/admin/codes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username: HANDLE }),
  });
  return (await res.json()).code as string;
};

/* ---------- the gateway ---------- */

const config: Partial<DeskfishConfig> = {
  provider: 'openai-compatible', model: 'model-a', baseUrl, daemonUrl, vncUrl,
  autoStart: false, settleMs: 0, screenshotWidth: 64, maxSteps: 1, containerCli: 'docker', reflectEvery: 0,
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-uplink-'));
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
const gatewayLog: string[] = [];
const gateway = await startGateway({ dir, port: 0, resourceDir: ROOT, quiet: true, onLog: (l) => gatewayLog.push(l) });
const home = new GatewayClient({ url: gateway.url, token: gateway.token, client: 'vscode', version: 'test' });
await home.connect();

/* ---------- a page, in Node: the shipped one, without its DOM ---------- */

interface Page {
  live: Live;
  /** One JSON frame of the wire protocol; resolves with the reply to that id. */
  call(cmd: string, args?: unknown): Promise<any>;
  events: { event: string; data: any }[];
  close(): void;
}

/** Sign in exactly as the page does, then talk to her over stream 1 as `WebHost` would. */
async function signIn(password: string, username = USER): Promise<Page> {
  const live = await pageSignIn(relayWs(), username, password);
  const socket = protocolSocket(live.channel);
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const events: { event: string; data: any }[] = [];
  socket.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.event) return void events.push(msg);
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (p) msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
  };
  const call = (cmd: string, args?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const mine = ++id;
      pending.set(mine, { resolve, reject });
      socket.send(JSON.stringify({ id: mine, cmd, ...(args ? { args } : {}) }));
      setTimeout(() => { if (pending.delete(mine)) reject(new Error(`${cmd} was never answered`)); }, 15_000);
    });
  await call('hello', { client: 'remote', version: 'test' }); // the first call is the snapshot
  return { live, call, events, close: () => live.socket.close() };
}

/** A sign-in that is expected to fail: the sentence a person would be shown. */
async function refusedSentence(password: string, username = USER): Promise<string> {
  try {
    const p = await signIn(password, username);
    p.close();
    return '';
  } catch (err) {
    return err instanceof LoginRefused ? err.sentence : err instanceof Error ? err.message : String(err);
  }
}

/** How many sign-ins her gateway has counted against the wrong-password fence. */
const counted = () => gatewayLog.filter((l) => l.includes('a sign-in did not complete')).length;

const dirs = [dir, relayData];
/** The OPAQUE record her gateway answers logins with; made once, in section 3. */
let made: RemoteRecord;
try {
  // ---------- 1. before anything: off, and the settings say so ----------
  {
    const s = await home.call('remote.status');
    ok(s.state === 'off' && !s.enrolled && !s.hasPassword && s.relay === '' && s.username === '', `a fresh gateway dials nothing (${JSON.stringify(s)})`);
    await assert.rejects(home.call('remote.enroll', { relay: relayWs(), username: 'NO', code: 'x' }), /3 to 32 characters/);
    n++;
    await assert.rejects(home.call('remote.enroll', { relay: relayWs(), username: USER, code: 'not-a-code' }), /refused the enrolment/);
    n++;
    ok((await home.call('remote.status')).state === 'off', 'a refused enrolment changes nothing');
  }

  // ---------- 2. enroll: the code is spent, the private key stays here ----------
  {
    const code = await mintCode();
    const s = await home.call('remote.enroll', { relay: relayWs(), username: USER, code });
    ok(s.enrolled && !s.hasPassword && s.relay === relayWs() && s.username === USER, `enrolled, no password yet (${s.state})`);
    const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
    ok(typeof secrets.remote?.key === 'string' && secrets.remote.key.length > 40 && secrets.remote.username === USER, 'the private key is in secrets.json');
    ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(relayData, 'users.json'), 'utf8'))).includes(secrets.remote.key), 'and is nowhere in the relay’s store');
    ok((await home.call('config.get')).remoteRelay === relayWs(), 'the relay is a setting, not a secret');
    ok(relay.connected.length === 0, 'with no password set, nothing is dialled yet');
    ok(gatewayLog.some((l) => l.includes('no password is set yet')), 'and the log says what is missing');
    const again = await mintCode();
    await assert.rejects(home.call('remote.enroll', { relay: relayWs(), username: USER, code: again }), /taken on this relay/);
    n++;
  }

  // ---------- 3. the password: made here, sent as a record, and the uplink comes up ----------
  {
    made = await register(USER, PASSWORD);
    const s = await home.call('remote.password', { serverSetup: made.serverSetup, record: made.record });
    ok(s.hasPassword && s.enrolled, 'the record is kept');
    const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
    ok(!JSON.stringify(secrets).includes(PASSWORD) && !fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes(PASSWORD), 'the password itself is in no file of hers');
    await until(() => relay.connected.includes(HANDLE), 'the uplink to reach the relay');
    ok((await home.call('remote.status')).state === 'connected', 'remote.status says connected');
    ok(gatewayLog.some((l) => l.includes('the uplink to') && l.includes(USER)), 'the log has one line per state change');
  }

  // ---------- 4. a page signs in, sees the snapshot, runs a task and hears its events ----------
  let page: Page;
  {
    page = await signIn(PASSWORD);
    const snap = await page.call('snapshot');
    ok(snap.name === 'deskfish' && snap.dataDir === dir && snap.config.model === 'model-a', 'the page gets the snapshot of this very gateway');
    ok((await home.call('remote.status')).clients === 1, 'the gateway counts one browser');
    await page.call('run', { task: 'Have a look at the screen.' });
    await until(() => page.events.some((e) => e.event === 'event' && e.data?.type === 'status' && e.data.status === 'done'), 'the task to finish at the page');
    ok(page.events.some((e) => e.event === 'event' && e.data?.type === 'assistant' && e.data.text.includes('nothing needed doing')), 'her answer arrived as an event, through the relay');
    ok(page.events.some((e) => e.event === 'task'), 'so did the task event every client gets');
    // The channel is the authentication: no token was typed, sent or asked for.
    ok(!JSON.stringify(page.events).includes(gateway.token), 'no gateway token in anything the page was sent');
  }

  // ---------- 5. the live view is a byte pipe, and a file goes both ways ----------
  {
    // noVNC's raw channel, as `core/websock.js` will use it: the eight properties, binaryType, a
    // message event carrying an ArrayBuffer.
    const raw = vncChannel(page.live.channel) as any;
    ok(['send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen', 'protocol', 'readyState'].every((k) => k in raw), 'the live view is handed a channel with every property noVNC demands');
    const back: Uint8Array[] = [];
    raw.onmessage = (ev: { data: ArrayBuffer }) => back.push(new Uint8Array(ev.data));
    raw.binaryType = 'arraybuffer';
    raw.send(te.encode('RFB 003.008\n'));
    await until(() => back.length > 0, 'the live view to echo');
    ok(td.decode(back[0]) === 'RFB 003.008\n', 'the VNC bytes went to websockify and came back unchanged');
    ok(vncProtocols[0] === 'binary', 'and were asked for over the binary subprotocol, as noVNC does');

    const files = fileTransfer(page.live.channel);
    const note = new File([te.encode('a note for her tank')], 'note.txt');
    const put = await files.upload('note.txt', note);
    ok(put.path === '/home/bot/Uploads/note.txt' && UPLOADED.some((f) => f.path === '/home/bot/Uploads/note.txt' && Buffer.from(f.data, 'base64').toString() === 'a note for her tank'), 'an upload lands in the tank’s Uploads, byte for byte');

    const got = await files.download({ name: 'report.pdf', path: '/home/bot/Downloads/report.pdf', size: REPORT.length });
    ok(Buffer.from(await got.arrayBuffer()).equals(REPORT), 'a download comes back byte for byte');

    let refusal = '';
    await files.download({ name: 'nope.pdf', path: '/home/bot/Downloads/nope.pdf', size: 1 }).catch((err: Error) => (refusal = err.message));
    ok(refusal.length > 0, `a file that is not there is refused in words (${refusal})`);
  }

  // ---------- 6. the relay's tap: everything it carried, and none of it readable ----------
  {
    const all = Buffer.concat(tap.map((f) => f.bytes));
    const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
    const hidden = ['"cmd"', 'snapshot', 'deskfish', ANSWER, 'Have a look at the screen', 'RFB 003.008', 'a note for her tank', 'the quarterly report', PASSWORD, gateway.token, secrets.remote.record, secrets.remote.key];
    const seen = hidden.filter((needle) => all.includes(needle) || all.includes(Buffer.from(needle).toString('base64').replace(/=+$/, '')));
    ok(seen.length === 0, `the relay carried ${tap.length} frames and ${all.length} bytes and can read none of it${seen.length ? `: ${seen.join(', ')}` : ''}`);
    ok(tap.some((f) => f.from === 'client') && tap.some((f) => f.from === 'gateway'), 'both directions went through it');
    ok(!fs.readFileSync(path.join(relayData, 'users.json'), 'utf8').includes(gateway.token), 'the gateway token is not in the relay’s store either');

    // Her *name* is not the relay's business either: it is told a handle, at enrolment, on every
    // connection URL and in every line it logs, and the name is nowhere on that machine.
    const store = fs.readFileSync(path.join(relayData, 'users.json'), 'utf8');
    ok(!store.includes(USER) && store.includes(HANDLE), `the relay’s store holds the handle and not her name (${HANDLE})`);
    ok(relaySaid.length > 0 && !relaySaid.some((l) => l.includes(USER)), `nor do its ${relaySaid.length} event lines`);
    ok(relaySaid.some((l) => l.includes(HANDLE)), 'which do name the handle');
    ok(!all.includes(USER) && !all.includes(Buffer.from(USER).toString('base64').replace(/=+$/, '')), 'and no frame it carried holds her name in the clear');
    ok(relay.connected.join() === HANDLE, `the relay thinks it is holding "${HANDLE}"`);
  }

  // ---------- 7. a wrong password: five refusals, then a wait ----------
  {
    // The page learns first that the password is wrong (that is what OPAQUE does) and closes; her
    // gateway counts the attempt when the relay tells it the browser is gone, so each one is waited
    // for rather than raced.
    let last = '';
    for (let i = 0; i < 5; i++) {
      const before = counted();
      last = await refusedSentence('not her password');
      if (i === 0) ok(/not right|not hers/.test(last), `a wrong password is refused in a sentence (${last})`);
      await until(() => counted() > before, 'the gateway to count the wrong password');
    }
    last = await refusedSentence('not her password');
    ok(/Too many wrong passwords/.test(last), `the sixth attempt in a minute is told to wait (${last})`);
    ok(gatewayLog.some((l) => l.includes('wrong-password wait')), 'and the wait is logged');
    ok((await home.call('remote.status')).state === 'connected', 'the uplink itself is untouched by the guessing');
    ok(page.live.channel.isClosed === false, 'and so is the browser that is already signed in');
  }

  // ---------- 8. off, and the page is told she is not connected ----------
  {
    const s = await home.call('remote.off', {});
    ok(s.state === 'off' && s.relay === '' && s.enrolled, 'off clears the settings and keeps the keys');
    await until(() => relay.connected.length === 0, 'the relay to lose the uplink');
    ok(page.live.channel.isClosed, 'the browser that was signed in was let go, not left hanging');
    ok(/She is not connected right now/.test(await refusedSentence(PASSWORD)), 'a page that calls now is told she is not connected');
    ok(gatewayLog.some((l) => l.includes('remote access is off')), 'the log says so');

    // Back on: the same keys, no new code, and the uplink returns.
    await home.call('config.set', { patch: { remoteRelay: relayWs(), remoteUsername: USER } });
    await until(() => relay.connected.includes(HANDLE), 'the uplink to come back from a settings change alone');
    ok(true, 'turning it back on is a settings change; the keys were kept');
  }

  // ---------- 9. the relay restarts: the gateway dials again, and the sign-in it cut is nobody's fault ----------
  {
    // A browser that is in the middle of signing in when the uplink goes has not guessed a password;
    // counting it would let a relay restart spend a person's five tries for them. (The fence is a
    // fresh one: section 8 turned remote access off and on, which builds a new uplink.)
    const half = new WebSocket(`${relayWs()}/client?user=${HANDLE}`);
    half.on('error', () => {});
    await new Promise<void>((r) => half.on('open', () => r()));
    for (let i = 0; i < 100 && (await home.call('remote.status')).clients === 0; i++) await sleep(20);
    ok((await home.call('remote.status')).clients === 1, 'her gateway has a browser in the middle of signing in');
    const before = counted();
    await relay.close();
    await until(() => (home.call('remote.status'), true), 'the close to settle');
    await sleep(200);
    relay = startRelay({ port: relayPort, ...relayOptions });
    relayPort = await relay.listening;
    await until(() => relay.connected.includes(HANDLE), 'the uplink to find the relay again', 20_000);
    ok(counted() === before, `a sign-in cut by the uplink's own loss is not counted against the fence (${counted()} vs ${before})`);
    half.close();
    const back = await signIn(PASSWORD);
    ok((await back.call('snapshot')).dataDir === dir, 'and a page signs in again with nothing re-entered');
    back.close();
  }

  // ---------- 10. a relay that goes quiet without closing: the uplink notices and dials again ----------
  {
    // The relay's keepalive is off here, so nothing crosses the socket at all — which is what a
    // laptop that slept, a NAT that forgot the flow or a proxy that cut it look like from this end.
    const quietDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-quiet-relay-'));
    dirs.push(quietDir);
    const quiet = startRelay({ port: 0, host: '127.0.0.1', adminKey: ADMIN, dataDir: quietDir, log: 'quiet', env: {}, pingIntervalMs: 0 });
    const quietPort: number = await quiet.listening;
    const key = newUplinkKey();
    const code = await (await fetch(`http://127.0.0.1:${quietPort}/admin/codes`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}' })).json();
    await fetch(`http://127.0.0.1:${quietPort}/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: HANDLE, publicKey: key.publicKey, code: code.code }) });

    // `idleMs` is 75 s in life; only a test lowers it, so only a test constructs the uplink itself.
    const said: string[] = [];
    const nothing: UplinkHost = {
      attach: (): ClientLink => ({ message: () => {}, refuse: () => {}, close: () => {} }),
      config: () => ({}) as never,
      uploadFile: () => Promise.reject(new Error('not in this test')),
      readFile: () => Promise.reject(new Error('not in this test')),
      log: (line) => said.push(line),
    };
    const lonely = new RemoteUplink({ relay: `ws://127.0.0.1:${quietPort}`, username: USER, privateKey: key.privateKey, record: made, host: nothing, idleMs: 1500 });
    const states: string[] = [];
    const errors: string[] = [];
    const watching = setInterval(() => {
      const { state, lastError } = lonely.status;
      if (states[states.length - 1] !== state) states.push(state);
      if (state === 'error' && lastError && !errors.includes(lastError)) errors.push(lastError);
    }, 20);
    lonely.start();
    await until(() => lonely.status.state === 'connected', 'the uplink to reach the quiet relay');
    ok(quiet.connected.includes(HANDLE), 'the relay holds it');
    await until(() => said.some((l) => /went quiet/.test(l)), 'the gateway to notice the silence', 10_000);
    ok(/the relay went quiet for 2 s; dialling again/.test(said.find((l) => /went quiet/.test(l)) ?? ''), `one line says what happened: ${said.find((l) => /went quiet/.test(l))}`);
    // Both waits read the recorded states, not the live one: the log line is written a moment before
    // the socket's close reaches `lost`, so asking the live status here would pass while it is still
    // 'connected' and leave nothing to assert about.
    await until(() => states.includes('error'), 'the uplink to drop the quiet socket', 10_000);
    await until(() => states.lastIndexOf('connected') > states.indexOf('error'), 'the uplink to dial again by itself', 10_000);
    ok(states.join(' → ').includes('connected → error'), `status went ${states.join(' → ')}`);
    ok(!said.some((l) => /trying again in/.test(l)), 'and the loss it caused is not announced a second time');
    ok(errors.some((e) => /went quiet/.test(e)), `and remote status said why while it was down: ${errors.join(' | ')}`);
    clearInterval(watching);
    lonely.stop();
    await quiet.close();
  }

  // ---------- 11. a relay that claims to be another relay gets no signature at all ----------
  {
    // Anyone may ask a relay for a challenge, so a relay could fetch one from *another* relay for
    // this username and pass it on as its own: the signature that came back would be valid there and
    // would take that username's uplink slot away. Binding the signature to the name this end dialled
    // is what makes that pointless — and a gateway that is asked to sign for another name does not.
    const fakeHttp = http.createServer();
    const fake = new WebSocketServer({ server: fakeHttp, path: '/uplink' });
    const heard: string[] = [];
    fake.on('connection', (ws) => {
      ws.on('message', (d) => heard.push(String(d)));
      ws.send(JSON.stringify({ challenge: Buffer.alloc(32, 9).toString('base64url'), context: 'deskfish-uplink', host: 'relay.other.example', version: '0.3.0' }));
    });
    await new Promise<void>((r) => fakeHttp.listen(0, '127.0.0.1', r));
    // `remote.status` shows the reason while it is down, and the backoff is a second, so it is read
    // as it happens rather than after: a settled status is 'connecting' again by then.
    const seen: string[] = [];
    const watching = setInterval(() => void home.call('remote.status').then((st) => { if (st.lastError && !seen.includes(st.lastError)) seen.push(st.lastError); }).catch(() => {}), 40);
    await home.call('config.set', { patch: { remoteRelay: `ws://127.0.0.1:${(fakeHttp.address() as AddressInfo).port}` } });
    await until(() => gatewayLog.some((l) => l.includes('not signing for a name I did not dial')), 'the gateway to refuse a relay wearing another name');
    await until(() => seen.some((e) => /not signing for a name I did not dial/.test(e)), 'remote.status to say so too');
    clearInterval(watching);
    ok(heard.length === 0, `the gateway said nothing at all to it (${heard.length} frames)`);
    ok(seen.some((e) => /relay.other.example/.test(e)), `and the sentence names the two: ${seen.find((e) => /not signing/.test(e))}`);
    await home.call('config.set', { patch: { remoteRelay: relayWs() } });
    await until(() => relay.connected.includes(HANDLE), 'the uplink to come back to the relay it was enrolled at', 20_000);
    ok((await home.call('remote.status')).state === 'connected', 'the real relay, whose name it did dial, is connected to as before');
    fake.close();
    await new Promise<void>((r) => fakeHttp.close(() => r()));
  }

  // ---------- 12. forget: the keys go too ----------
  {
    const s = await home.call('remote.off', { forget: true });
    ok(!s.enrolled && !s.hasPassword && s.state === 'off', 'off --forget drops the key and the record');
    ok(!JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).remote, 'secrets.json has no remote entry left');
    ok(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).keys !== undefined, 'and her API keys are untouched');
  }

  realLog(`uplink: ${n} checks passed`);
} finally {
  home.close();
  await gateway.stop('test over');
  await relay.close().catch(() => {});
  await new Promise<void>((r) => daemon.close(() => r()));
  await new Promise<void>((r) => vncHttp.close(() => r()));
  vncWss.close();
  await new Promise<void>((r) => model.close(() => r()));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log = realLog;
}
