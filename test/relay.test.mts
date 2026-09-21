// The relay (relay/server.mjs + store.mjs), started in this process on a free port, with a real
// gateway uplink and real browser clients made of `ws`. It refuses to start without an admin key;
// enrolment needs a minted code and spends it; the admin endpoints refuse a wrong key; an uplink
// with a bad signature, an unknown username or no answer is closed; two browsers on one uplink get
// their own numbers and only their own frames; a browser for a user who is not connected is told
// `{offline:true}`; a second uplink replaces the first and the first's browsers are dropped; a text
// frame from a browser closes it; the gateway can ask for a browser to be closed. The tap — every
// frame the relay touched — is byte for byte what the ends sent, and with step 1's channel running
// across it holds none of the plaintext (requirement 2). At RELAY_LOG=quiet a whole session writes
// not one line.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Channel, FrameType, STREAM, StreamKind, loginClient, loginServer, register } from '../src/remote/channel';
// @ts-expect-error — the relay is its own plain-JavaScript package; it has no types and imports nothing of ours.
import { startRelay } from '../relay/server.mjs';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const te = new TextEncoder();
const td = new TextDecoder();
const USER = 'iman';
const ADMIN = 'an-admin-key-only-the-operator-has';

/** Every frame the relay touched, in order, as it saw it. */
const tap: { from: string; user: string; clientId: number; bytes: Buffer }[] = [];
const said: string[] = [];
const realLog = console.log;
const realError = console.error;
console.log = (...a: unknown[]) => void said.push(`log ${a.join(' ')}`);
console.error = (...a: unknown[]) => void said.push(`err ${a.join(' ')}`);
const restoreConsole = () => { console.log = realLog; console.error = realError; };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-relay-'));
const relay = startRelay({ port: 0, host: '127.0.0.1', adminKey: ADMIN, dataDir, log: 'quiet', env: {}, onFrame: (f: any) => tap.push(f) });
const port: number = await relay.listening;
const http = `http://127.0.0.1:${port}`;
const ws = `ws://127.0.0.1:${port}`;

/** Her gateway's key. The private half never leaves home; the relay learns only the public one. */
const pair = generateKeyPairSync('ed25519');
const publicKey = Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).subarray(-32).toString('base64url');
const answerChallenge = (challenge: string, context: string, username: string, key = pair.privateKey) =>
  sign(null, Buffer.concat([Buffer.from(challenge, 'base64url'), Buffer.from(context), Buffer.from(username)]), key).toString('base64url');

const admin = (method: string, url: string, body?: unknown, key = ADMIN) =>
  fetch(`${http}${url}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** A gateway uplink: connects, answers the challenge, and hands back what it is sent. */
async function uplink(username = USER, key = pair.privateKey) {
  const socket = new WebSocket(`${ws}/uplink`);
  const frames: { clientId: number; bytes: Buffer }[] = [];
  const control: any[] = [];
  let accepted = false;
  let closed: { code: number; reason: string } | undefined;
  const ready = new Promise<boolean>((resolve) => {
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        const message = JSON.parse(data.toString());
        if (message.challenge) return socket.send(JSON.stringify({ username, signature: answerChallenge(message.challenge, message.context, username, key) }));
        if (message.ok) { accepted = true; resolve(true); }
        return;
      }
      const frame = data as Buffer;
      const clientId = frame.readUInt32BE(0);
      const bytes = frame.subarray(4);
      if (clientId === 0) control.push(JSON.parse(bytes.toString('utf8')));
      else frames.push({ clientId, bytes: Buffer.from(bytes) });
    });
    socket.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; resolve(accepted); });
    socket.on('error', () => {});
  });
  await Promise.race([ready, sleep(3000)]);
  const send = (clientId: number, bytes: Uint8Array) => {
    const frame = Buffer.allocUnsafe(4 + bytes.length);
    frame.writeUInt32BE(clientId, 0);
    frame.set(bytes, 4);
    socket.send(frame, { binary: true });
  };
  return { socket, frames, control, send, get accepted() { return accepted; }, get closed() { return closed; } };
}

/** A browser on the relay. */
async function browser(username = USER) {
  const socket = new WebSocket(`${ws}/client?user=${encodeURIComponent(username)}`);
  const binary: Buffer[] = [];
  const text: any[] = [];
  let closed: { code: number; reason: string } | undefined;
  socket.on('message', (data, isBinary) => (isBinary ? binary.push(Buffer.from(data as Buffer)) : text.push(JSON.parse(data.toString()))));
  socket.on('close', (code, reason) => (closed = { code, reason: reason.toString() }));
  socket.on('error', () => {});
  await Promise.race([new Promise((r) => socket.on('open', r)), new Promise((r) => socket.on('close', r)), sleep(2000)]);
  return { socket, binary, text, get closed() { return closed; } };
}

const t0 = Date.now();
try {
  // 1. It will not start without an admin key
  assert.throws(() => startRelay({ port: 0, env: {}, dataDir }), /RELAY_ADMIN_KEY/); n++;

  // 2. /status says who it is and nothing else
  const status = await (await fetch(`${http}/status`)).json();
  ok(status.name === 'deskfish-relay' && typeof status.version === 'string' && Object.keys(status).sort().join() === 'name,version', `/status: ${JSON.stringify(status)}`);

  // 3. The admin endpoints need the key; enrolment needs a code and spends it
  ok((await admin('POST', '/admin/codes', { username: USER }, 'wrong')).status === 401, 'minting a code with a wrong key: 401');
  ok((await fetch(`${http}/admin/codes`, { method: 'POST' })).status === 401, 'minting a code with no key at all: 401');
  const enroll = async (body: unknown) => {
    const res = await fetch(`${http}/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const noCode = await enroll({ username: USER, publicKey });
  ok(noCode.status === 400 && /enrolment code/.test(noCode.body.error), `enrolment without a code is refused in a sentence: ${noCode.body.error}`);
  const minted = await (await admin('POST', '/admin/codes', { username: USER })).json();
  ok(typeof minted.code === 'string' && minted.code.length > 16 && minted.username === USER, 'the admin key mints a one-time code');
  const wrongName = await enroll({ username: 'someone-else', publicKey, code: minted.code });
  ok(wrongName.status === 400 && /is for iman/.test(wrongName.body.error), `a code tied to a username refuses another: ${wrongName.body.error}`);
  const enrolled = await enroll({ username: USER, publicKey, code: minted.code });
  ok(enrolled.status === 200 && enrolled.body.username === USER, 'the code enrols the username');
  const again = await enroll({ username: USER, publicKey, code: minted.code });
  ok(again.status === 400 && /not one of ours|used already/.test(again.body.error), 'the code is spent');
  const second = await (await admin('POST', '/admin/codes', {})).json();
  const taken = await enroll({ username: USER, publicKey, code: second.code });
  ok(taken.status === 400 && /taken on this relay/.test(taken.body.error), 'a username is claimed once, even with a fresh code');
  const badName = await enroll({ username: 'X!', publicKey, code: second.code });
  ok(badName.status === 400 && /3 to 32 characters/.test(badName.body.error), 'a username that is not one is refused in a sentence');

  // 4. A browser for a user who is not connected is told so
  {
    const b = await browser();
    await sleep(60);
    ok(b.text.length === 1 && b.text[0].offline === true && b.closed, 'a browser with no uplink gets {offline:true} and a close');
  }

  // 5. An uplink that cannot prove the key is closed
  {
    const other = generateKeyPairSync('ed25519');
    const bad = await uplink(USER, other.privateKey);
    ok(!bad.accepted && bad.closed?.code === 1008 && /signature/.test(bad.closed.reason), `a wrong signature is closed: ${bad.closed?.reason}`);
    const unknown = await uplink('nobody-here');
    ok(!unknown.accepted && /not enrolled/.test(unknown.closed?.reason ?? ''), `an unenrolled username is closed: ${unknown.closed?.reason}`);
    ok(relay.connected.length === 0, 'neither held an uplink');
  }

  // 6. Two browsers on one uplink: their own numbers, only their own frames
  const up = await uplink();
  ok(up.accepted && relay.connected.join() === USER, 'the uplink is up');
  const a = await browser();
  const b = await browser();
  await sleep(60);
  ok(up.control.filter((c) => typeof c.open === 'number').length === 2, 'the gateway was told about both browsers');
  const ids = up.control.filter((c) => typeof c.open === 'number').map((c) => c.open);
  ok(ids[0] !== ids[1] && ids.every((i) => i > 0), `they have their own numbers: ${ids.join(' and ')}`);
  a.socket.send(Buffer.from('from A'), { binary: true });
  b.socket.send(Buffer.from('from B'), { binary: true });
  await sleep(60);
  ok(up.frames.length === 2 && up.frames.every((f) => ids.includes(f.clientId)), 'both frames arrived, each with its own number');
  ok(up.frames.find((f) => f.clientId === ids[0])!.bytes.toString() === 'from A', 'the frame kept its bytes');
  up.send(ids[0], te.encode('only for A'));
  await sleep(60);
  ok(a.binary.length === 1 && a.binary[0].toString() === 'only for A' && b.binary.length === 0, 'a frame for A reached A and nobody else');

  // 7. A text frame from a browser closes it; the gateway may ask for one to be closed
  {
    const chatty = await browser();
    await sleep(40);
    chatty.socket.send('hello?');
    await sleep(60);
    ok(chatty.closed?.code === 1003 && /binary/.test(chatty.closed.reason), `a text frame closes the browser: ${chatty.closed?.reason}`);
  }
  up.send(0, te.encode(JSON.stringify({ close: ids[1] })));
  await sleep(60);
  ok(b.closed?.code === 1000, 'the gateway can ask the relay to drop a browser');

  // 8. A second uplink replaces the first, and the first's browsers go with it
  {
    const replacement = await uplink();
    await sleep(80);
    ok(replacement.accepted && up.closed?.code === 1012 && /replaced/.test(up.closed.reason), `the first uplink is closed 1012 replaced: ${up.closed?.reason}`);
    ok(a.closed !== undefined, 'the browsers of the replaced uplink were told');
    ok(relay.connected.join() === USER, 'the username is still held, by the new one');
    replacement.socket.close();
    await sleep(80);
    ok(relay.connected.length === 0, 'when the uplink goes, the username is free');
  }

  // 9. The tap is byte for byte what the ends sent
  {
    tap.length = 0;
    const live = await uplink();
    const page = await browser();
    await sleep(60);
    const id = live.control.find((c) => typeof c.open === 'number')!.open;
    const sent = [Buffer.from([0, 1, 2, 250, 251, 252]), Buffer.from('a longer frame with a ÿ in it')];
    for (const s of sent) page.socket.send(s, { binary: true });
    live.send(id, te.encode('and one back'));
    await sleep(80);
    const fromClient = tap.filter((f) => f.from === 'client');
    ok(fromClient.length === 2 && fromClient[0].bytes.equals(sent[0]) && fromClient[1].bytes.equals(sent[1]), 'the relay saw exactly the bytes the browser sent');
    ok(live.frames.map((f) => f.bytes.toString('hex')).join() === sent.map((s) => s.toString('hex')).join(), 'and passed them on unchanged');
    ok(page.binary.length === 1 && page.binary[0].toString() === 'and one back', 'and the other way too');
    page.socket.close();
    live.socket.close();
    await sleep(60);
  }

  // 10. A whole real session across the relay: the tap holds none of it
  {
    tap.length = 0;
    const record = await register(USER, 'the passphrase for her tank');
    const live = await uplink();
    const page = await browser();
    await sleep(60);
    const clientId = live.control.find((c) => typeof c.open === 'number')!.open;

    // The page's half: the three OPAQUE messages as bytes, then sealed frames.
    const inbox: Buffer[] = [];
    const waiters: ((b: Buffer) => void)[] = [];
    const pump = () => { while (inbox.length && waiters.length) waiters.shift()!(inbox.shift()!); };
    const originalPush = page.binary.push.bind(page.binary);
    page.socket.removeAllListeners('message');
    page.socket.on('message', (d) => { originalPush(Buffer.from(d as Buffer)); inbox.push(Buffer.from(d as Buffer)); pump(); });
    const next = () => new Promise<Buffer>((r) => { waiters.push(r); pump(); });

    const pageLogin = loginClient(USER, 'the passphrase for her tank', (m) => page.socket.send(Buffer.from(m, 'utf8'), { binary: true }), async () => (await next()).toString('utf8'));
    const gatewayLogin = loginServer(record, (m) => live.send(clientId, Buffer.from(m, 'utf8')), async () => {
      for (;;) {
        const frame = live.frames.shift();
        if (frame) return frame.bytes.toString('utf8');
        await sleep(5);
      }
    });
    const [pageKeys, gatewayKeys] = await Promise.all([pageLogin, gatewayLogin]);
    ok(pageKeys.sessionKey === gatewayKeys.sessionKey, 'the two ends agreed on a key through the relay');

    const pageChannel = await Channel.create(pageKeys.sessionKey, 'page', (f) => page.socket.send(Buffer.from(f), { binary: true }));
    const gatewayChannel = await Channel.create(gatewayKeys.sessionKey, 'gateway', (f) => live.send(clientId, f));
    page.socket.on('message', (d) => void pageChannel.receive(new Uint8Array(Buffer.from(d as Buffer))));
    const feedGateway = setInterval(() => { const f = live.frames.shift(); if (f) void gatewayChannel.receive(new Uint8Array(f.bytes)); }, 5);
    const back: string[] = [];
    gatewayChannel.mux.onStream((st) => st.onData((d) => {
      if (st.kind === StreamKind.VNC) st.send(te.encode('RFB 003.008\n'));
      else st.send(te.encode(JSON.stringify({ id: 1, ok: true, result: { name: 'deskfish', status: 'idle' } })));
      void d;
    }));
    const protocol = pageChannel.mux.open(StreamKind.PROTOCOL);
    const vnc = pageChannel.mux.open(StreamKind.VNC);
    for (const st of [protocol, vnc]) st.onData((d) => back.push(td.decode(d)));
    protocol.send(te.encode(JSON.stringify({ id: 1, cmd: 'hello', args: { client: 'web', version: 't' } })));
    protocol.send(te.encode(JSON.stringify({ id: 2, cmd: 'run', args: { task: 'Task: pay the electricity bill' } })));
    vnc.send(te.encode('RFB 003.008\n'));
    await sleep(250);
    clearInterval(feedGateway);
    ok(back.length === 3 && back.some((x) => x.includes('deskfish')) && back.some((x) => x.includes('RFB')), `a whole session ran across the relay (${back.length} answers)`);

    const all = Buffer.concat(tap.map((f) => f.bytes));
    ok(all.length > 800, `the relay did carry the session (${all.length} bytes in ${tap.length} frames)`);
    for (const secret of ['hello', 'Task', 'pay the electricity bill', 'RFB 003.008', 'deskfish', 'the passphrase for her tank', record.record.slice(0, 24)]) {
      ok(!all.includes(Buffer.from(secret, 'utf8')), `the relay's tap holds no "${secret.slice(0, 28)}"`);
    }
    ok(tap.every((f) => f.clientId === clientId || f.clientId === 0), 'every frame carried a client number and nothing else the relay read');
    page.socket.close();
    live.socket.close();
    await sleep(60);
  }

  // 11. Usage is counted; nothing else is written
  {
    const usage = await (await admin('GET', `/admin/usage/${USER}`)).json();
    const days = Object.values(usage.days) as { seconds: number; up: number; down: number }[];
    ok(days.length === 1 && days[0].up > 0 && days[0].down > 0 && days[0].seconds >= 0, `usage counts seconds and bytes both ways: ${JSON.stringify(days[0])}`);
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
    ok(Object.keys(stored).sort().join() === 'codes,usage,users', `the store holds three things: ${Object.keys(stored).sort().join()}`);
    ok(!JSON.stringify(stored).includes('RFB') && !JSON.stringify(stored).includes('electricity'), 'and none of the session');
    ok((await admin('GET', `/admin/usage/${USER}`, undefined, 'wrong')).status === 401, 'usage needs the admin key');
  }

  // 12. A revoked username loses its uplink and cannot come back
  {
    const live = await uplink();
    ok(live.accepted, 'the uplink is up again');
    ok((await admin('DELETE', `/admin/users/${USER}`)).status === 200, 'the admin key revokes');
    await sleep(80);
    ok(live.closed?.code === 1012, 'a revoke drops the uplink that was held');
    const after = await uplink();
    ok(!after.accepted && /not enrolled/.test(after.closed?.reason ?? ''), 'and the username cannot connect again');
  }

  // 13. Quiet means quiet: not one line for any of the above
  ok(said.length === 0, `RELAY_LOG=quiet wrote nothing for a whole session (${said.length} lines: ${said.slice(0, 3).join(' | ')})`);

  // 13b. The relay ships in neither package: it is its own folder, its own container
  {
    const { spawnSync } = await import('node:child_process');
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const zips = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-relay-vsix-'));
    const zip = path.join(zips, 'relay.vsix');
    spawnSync('python3', ['-c', 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor e in sys.argv[2:]: z.writestr(e,"x")\nz.close()', zip, 'extension/package.json', 'extension/relay/server.mjs']);
    const check = spawnSync('node', [path.join(root, 'scripts/check-vsix.mjs'), zip], { encoding: 'utf8' });
    ok(check.status === 1 && check.stderr.includes('extension/relay/server.mjs'), 'check-vsix refuses a package carrying relay/');
    ok(fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split('\n').includes('relay/**'), '.vscodeignore leaves relay/ out');
    fs.rmSync(zips, { recursive: true, force: true });
  }

  // 14. …and `events` says what happened, without ever saying what was in it
  {
    const loud: string[] = [];
    console.log = (...a: unknown[]) => void loud.push(a.join(' '));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-relay2-'));
    const chatty = startRelay({ port: 0, host: '127.0.0.1', adminKey: ADMIN, dataDir: dir2, log: 'events', env: {} });
    const port2: number = await chatty.listening;
    const code = await (await fetch(`http://127.0.0.1:${port2}/admin/codes`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}' })).json();
    await fetch(`http://127.0.0.1:${port2}/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, publicKey, code: code.code }) });
    const socket = new WebSocket(`ws://127.0.0.1:${port2}/uplink`);
    socket.on('message', (d, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(d.toString());
      if (m.challenge) socket.send(JSON.stringify({ username: USER, signature: answerChallenge(m.challenge, m.context, USER) }));
    });
    await sleep(200);
    const browserSocket = new WebSocket(`ws://127.0.0.1:${port2}/client?user=${USER}`);
    await sleep(100);
    browserSocket.send(Buffer.from('a frame nobody will ever read'), { binary: true });
    await sleep(100);
    ok(loud.some((l) => /uplink up/.test(l)) && loud.some((l) => /browser 1/.test(l)), `events names the connections (${loud.length} lines)`);
    ok(!loud.some((l) => /nobody will ever read/.test(l)), 'and never a frame');
    browserSocket.close();
    socket.close();
    await chatty.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  await relay.close();
} finally {
  restoreConsole();
  await relay.close().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`relay: ${n} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
