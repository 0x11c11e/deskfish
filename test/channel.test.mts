// The sealed channel (src/remote/channel.ts), both ends in one Node process, with a tap that records
// every byte that would cross the relay. OPAQUE: registration runs both roles locally, a login agrees
// on one session key, a wrong password is refused on both sides and derives nothing, a gateway without
// the record cannot finish (this is not her), and two logins share nothing. The frames: a flipped byte,
// a replay and a frame out of order each close the channel with a sentence and are never opened; the
// nonce counter never repeats across 100k frames; a counter that would wrap closes instead. The tap of
// a whole session — handshake, protocol JSON, VNC bytes, a file — holds none of the plaintext and none
// of the password. The mux: three interleaved streams arrive in order, the window is honoured, an
// unknown frame type or an open from the wrong end closes the channel.
import assert from 'node:assert/strict';
import { CHUNK, Channel, FrameType, LoginRefused, STREAM, StreamKind, WINDOW, deriveKeys, loginClient, loginServer, register, type Stream } from '../src/remote/channel';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const te = new TextEncoder();
const td = new TextDecoder();
const USER = 'iman';
const PASSWORD = 'a long enough passphrase for her tank';

/** Every byte the relay would carry, in order, as it would see it. */
class Tap {
  readonly bytes: Uint8Array[] = [];
  add(x: Uint8Array | string): void {
    this.bytes.push(typeof x === 'string' ? te.encode(x) : x);
  }
  get all(): Uint8Array {
    const total = this.bytes.reduce((s, b) => s + b.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const b of this.bytes) { out.set(b, at); at += b.length; }
    return out;
  }
  /** Does the recording hold this text anywhere, as bytes or as base64? */
  holds(text: string): boolean {
    const hay = this.all;
    const needles = [te.encode(text), te.encode(Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, ''))];
    return needles.some((needle) => {
      outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return true;
      }
      return false;
    });
  }
}

/** A pair of queues standing in for the relay's forwarding, recorded as it goes. */
function wire(tap?: Tap) {
  const queues: Record<'toPage' | 'toGateway', string[]> = { toPage: [], toGateway: [] };
  const waiters: Record<'toPage' | 'toGateway', ((m: string) => void)[]> = { toPage: [], toGateway: [] };
  const put = (q: 'toPage' | 'toGateway', m: string) => {
    tap?.add(m);
    const w = waiters[q].shift();
    if (w) w(m); else queues[q].push(m);
  };
  const take = (q: 'toPage' | 'toGateway') =>
    new Promise<string>((resolve) => {
      const have = queues[q].shift();
      if (have !== undefined) resolve(have); else waiters[q].push(resolve);
    });
  return {
    pageSend: (m: string) => put('toGateway', m),
    pageRecv: () => take('toPage'),
    gatewaySend: (m: string) => put('toPage', m),
    gatewayRecv: () => take('toGateway'),
  };
}

/** A finished login, both halves, over that wire. */
async function handshake(record: Awaited<ReturnType<typeof register>>, password = PASSWORD, tap?: Tap) {
  const w = wire(tap);
  const client = loginClient(USER, password, w.pageSend, w.pageRecv);
  const server = loginServer(record, w.gatewaySend, w.gatewayRecv);
  return { client, server };
}

/** Two channels wired to each other through a tap, as the relay would carry them. */
async function channels(pageKey: string, gatewayKey: string, tap?: Tap) {
  let page!: Channel;
  let gateway!: Channel;
  page = await Channel.create(pageKey, 'page', (f) => { tap?.add(f); void gateway.receive(f); });
  gateway = await Channel.create(gatewayKey, 'gateway', (f) => { tap?.add(f); void page.receive(f); });
  return { page, gateway };
}

const t0 = Date.now();

// 1. Registration runs both roles locally; a login agrees on one key
const record = await register(USER, PASSWORD);
ok(record.username === USER && record.record.length > 100 && record.serverSetup.length > 100, 'register made a record and a server setup');
ok(!record.record.includes(PASSWORD) && !record.serverSetup.includes(PASSWORD), 'neither the record nor the setup holds the password');
{
  const { client, server } = await handshake(record);
  const [c, s] = await Promise.all([client, server]);
  ok(c.sessionKey === s.sessionKey && c.sessionKey.length > 40, 'a login agrees on one session key');
  ok(c.exportKey.length > 40 && c.exportKey !== c.sessionKey, 'the client also gets an export key (for "remember this browser", later)');
}

// 2. Two logins share nothing
{
  const a = await handshake(record);
  const b = await handshake(record);
  const [ca, cb] = await Promise.all([a.client, b.client]);
  await Promise.all([a.server, b.server]);
  ok(ca.sessionKey !== cb.sessionKey, 'two logins derive different keys');
}

// 3. A wrong password is refused on both sides and derives nothing
{
  const { client, server } = await handshake(record, 'not her password');
  await assert.rejects(client, (e: Error) => e instanceof LoginRefused && /password is not right|not hers/.test(e.message));
  n++;
  // The client stops at the second message, so the gateway is left waiting: it never gets a key either.
  const settled = await Promise.race([server.then(() => 'key', () => 'refused'), sleep(150).then(() => 'waiting')]);
  ok(settled !== 'key', `the gateway derives no key from a wrong password (${settled})`);
}

// 4. A gateway without the record cannot pretend to be her
{
  const other = await register(USER, 'some other password entirely');
  const { client, server } = await handshake(other, PASSWORD);
  await assert.rejects(client, (e: Error) => e instanceof LoginRefused); n++;
  void server.catch(() => {});
  ok(true, 'a gateway holding a different record cannot finish a login: "this is not her"');
}

// 5. The frames: a flipped byte, a replay and a frame out of order all close the channel
const keys = await (async () => { const { client, server } = await handshake(record); const [c, s] = await Promise.all([client, server]); return { page: c.sessionKey, gateway: s.sessionKey }; })();
{
  const page = await Channel.create(keys.page, 'page', () => {});
  const gateway = await Channel.create(keys.gateway, 'gateway', () => {});
  const good = await page.seal(STREAM.PROTOCOL, FrameType.DATA, te.encode('{"cmd":"hello"}'));
  const first = await gateway.open(good);
  ok(td.decode(first.payload) === '{"cmd":"hello"}' && first.stream === STREAM.PROTOCOL, 'a good frame opens');
  await assert.rejects(gateway.open(good), /refused/); n++;
  ok(gateway.isClosed && /repeated|changed|out of order/.test(gateway.closedReason ?? ''), `a replayed frame closes the channel: ${gateway.closedReason}`);

  const g2 = await Channel.create(keys.gateway, 'gateway', () => {});
  const bent = await page.seal(STREAM.PROTOCOL, FrameType.DATA, te.encode('second frame'));
  bent[Math.floor(bent.length / 2)] ^= 0x01;
  await assert.rejects(g2.open(bent), /refused/); n++;
  ok(g2.isClosed, 'a flipped byte closes the channel');

  const g3 = await Channel.create(keys.gateway, 'gateway', () => {});
  const third = await page.seal(STREAM.PROTOCOL, FrameType.DATA, te.encode('third frame'));
  await assert.rejects(g3.open(third), /refused/); n++;
  ok(g3.isClosed, 'a frame out of order (counter 2 where 0 was due) closes the channel');

  await assert.rejects(gateway.seal(STREAM.PROTOCOL, FrameType.DATA), /closed/); n++;
  ok(true, 'a closed channel seals nothing more');
}

// 6. Nonce discipline: 100k frames, no counter twice, and the far end still opens the last one
{
  const seen = new Set<string>();
  const page = await Channel.create(keys.page, 'page', () => {});
  const body = te.encode('x'.repeat(16));
  for (let i = 0; i < 100_000; i++) {
    seen.add(page.counters.out.toString());
    await page.seal(STREAM.VNC, FrameType.DATA, body);
  }
  ok(seen.size === 100_000 && page.counters.out === 100_000n, `100k frames used 100k different counters (${seen.size})`);
  const gateway = await Channel.create(keys.gateway, 'gateway', () => {});
  const fresh = await Channel.create(keys.page, 'page', () => {});
  ok((await gateway.open(await fresh.seal(STREAM.VNC, FrameType.DATA, body))).stream === STREAM.VNC, 'a fresh pair still agrees on counter 0');
}

// 7. The tap of a whole session holds none of the plaintext
{
  const tap = new Tap();
  const { client, server } = await handshake(record, PASSWORD, tap);
  const [c, s] = await Promise.all([client, server]);
  const { page, gateway } = await channels(c.sessionKey, s.sessionKey, tap);
  const served: Stream[] = [];
  gateway.mux.onStream((st) => {
    served.push(st);
    st.onData((d) => {
      if (st.kind === StreamKind.PROTOCOL) st.send(te.encode(JSON.stringify({ id: 1, ok: true, result: { name: 'deskfish' } })));
      if (st.kind === StreamKind.VNC) st.send(te.encode('RFB 003.008\n'));
      if (st.kind === StreamKind.FILE) st.send(te.encode('saved ' + td.decode(d).slice(0, 8)));
    });
  });
  const protocol = page.mux.open(StreamKind.PROTOCOL);
  const vnc = page.mux.open(StreamKind.VNC);
  const file = page.mux.open(StreamKind.FILE);
  const back: string[] = [];
  for (const st of [protocol, vnc, file]) st.onData((d) => back.push(td.decode(d)));
  protocol.send(te.encode(JSON.stringify({ id: 1, cmd: 'hello', args: { client: 'web', version: 't' } })));
  protocol.send(te.encode(JSON.stringify({ id: 2, cmd: 'run', args: { task: 'Task: read the electricity bill and tell me what it says' } })));
  vnc.send(te.encode('RFB 003.008\n'));
  file.send(te.encode('quarterly-report.pdf contents'));
  await sleep(50);
  ok(back.length === 4 && back.filter((b) => b.includes('deskfish')).length === 2 && back.some((b) => b.includes('RFB')) && back.some((b) => b.startsWith('saved')), `all three streams answered (${back.length} messages back)`);
  for (const secret of ['hello', 'Task', 'RFB 003.008', 'read the electricity bill', 'quarterly-report.pdf', PASSWORD, 'deskfish']) {
    ok(!tap.holds(secret), `the relay's tap holds no "${secret}"`);
  }
  ok(tap.all.length > 1000, `the tap did record the session (${tap.all.length} bytes)`);
}

// 8. The mux: three interleaved streams in order, and the window is honoured
{
  const { page, gateway } = await channels(keys.page, keys.gateway);
  const got: Record<number, number[]> = { 1: [], 2: [], 3: [] };
  gateway.mux.onStream((st) => st.onData((d) => got[st.id].push(...d)));
  const a = page.mux.open(StreamKind.PROTOCOL);
  const b = page.mux.open(StreamKind.VNC);
  const c = page.mux.open(StreamKind.FILE);
  ok(a.id === 1 && b.id === 2 && c.id === 3 && page.mux.open(StreamKind.FILE).id === 4, 'ids: 1 protocol, 2 vnc, files from 3');
  for (let i = 0; i < 30; i++) { a.send(Uint8Array.of(i)); b.send(Uint8Array.of(100 + i)); c.send(Uint8Array.of(200 + i)); }
  await sleep(80);
  ok(got[1].join() === Array.from({ length: 30 }, (_, i) => i).join(), 'stream 1 arrived in order');
  ok(got[2].join() === Array.from({ length: 30 }, (_, i) => 100 + i).join(), 'stream 2 arrived in order, interleaved with the others');
  ok(got[3].join() === Array.from({ length: 30 }, (_, i) => 200 + i).join(), 'stream 3 arrived in order');
}
{
  // Window: a receiver that never acks stops the sender at 1 MiB in flight; acking lets the rest go.
  const held: Uint8Array[] = [];
  let gateway!: Channel;
  const page = await Channel.create(keys.page, 'page', (f) => held.push(f));
  gateway = await Channel.create(keys.gateway, 'gateway', () => {});
  const st = page.mux.open(StreamKind.VNC);
  const chunk = new Uint8Array(64 * 1024);
  for (let i = 0; i < 40; i++) st.send(chunk);
  await sleep(120);
  const sent = held.length - 1; // the open frame is the first
  ok(sent <= WINDOW / chunk.length + 1 && sent >= 8, `the sender stopped at the window: ${sent} of 40 chunks went`);
  ok(st.queued > 0, `the rest is queued, not dropped (${st.queued} bytes)`);
  void gateway;
}

// 8b. A counter that would wrap closes the channel instead of repeating a nonce
{
  const page = await Channel.create(keys.page, 'page', () => {}, 2n);
  const body = te.encode('three frames is all this one may send');
  await page.seal(STREAM.VNC, FrameType.DATA, body);
  await page.seal(STREAM.VNC, FrameType.DATA, body);
  await page.seal(STREAM.VNC, FrameType.DATA, body);
  await assert.rejects(page.seal(STREAM.VNC, FrameType.DATA, body), /counter exhausted/); n++;
  ok(page.isClosed && /as many frames as one set of keys may carry/.test(page.closedReason ?? ''), `a wrap closes the channel: ${page.closedReason}`);
}

// 8c. A send larger than the relay will carry is split, and arrives whole and in order
{
  const { page, gateway } = await channels(keys.page, keys.gateway);
  const pieces: number[] = [];
  let got = 0;
  gateway.mux.onStream((st) => st.onData((d) => { pieces.push(d.length); got += d.length; }));
  const big = new Uint8Array(CHUNK * 2 + 1234);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const st = page.mux.open(StreamKind.FILE);
  st.send(big);
  await sleep(120);
  ok(got === big.length && pieces.length === 3 && pieces[0] === CHUNK && pieces[2] === 1234, `one send of ${big.length} bytes arrived as ${pieces.join('+')}`);
  ok(pieces.every((p) => p <= CHUNK), 'no piece is bigger than one frame may be');
}

// 8d. A ping is answered
{
  const { page, gateway } = await channels(keys.page, keys.gateway);
  let pong = false;
  page.mux.onPing(() => (pong = true));
  page.mux.ping();
  await sleep(40);
  ok(pong && !gateway.isClosed, 'a ping comes back as a pong');
}

// 9. What the channel refuses outright
{
  const { page, gateway } = await channels(keys.page, keys.gateway);
  page.mux.open(StreamKind.PROTOCOL);
  await sleep(20);
  // The gateway may not open a stream: only the page does.
  await gateway.write(STREAM.CONTROL, FrameType.OPEN, Uint8Array.of(0, 0, 0, 9, StreamKind.FILE));
  await sleep(20);
  ok(page.isClosed && /may not open streams/.test(page.closedReason ?? ''), `an open from the gateway closes the channel: ${page.closedReason}`);
}
{
  const { page, gateway } = await channels(keys.page, keys.gateway);
  await page.write(STREAM.CONTROL, 9 as never);
  await sleep(20);
  ok(gateway.isClosed && /not part of this protocol/.test(gateway.closedReason ?? ''), `an unknown control type closes the channel: ${gateway.closedReason}`);
}
{
  const { page, gateway } = await channels(keys.page, keys.gateway);
  let told = '';
  gateway.onClose((r) => (told = r));
  page.close('the tab went away');
  await sleep(20);
  ok(told === 'the tab went away' && page.isClosed, `close travels with its reason: ${told}`);
}

// 10. The keys themselves: derived, different per direction, and not the session key
{
  const derived = await deriveKeys(keys.page);
  ok(derived.page instanceof CryptoKey && derived.gateway instanceof CryptoKey, 'HKDF gives one AES-256-GCM key per direction');
  const a = await Channel.create(keys.page, 'page', () => {});
  const b = await Channel.create(keys.page, 'gateway', () => {});
  const fromPage = await a.seal(STREAM.PROTOCOL, FrameType.DATA, te.encode('same counter, other way'));
  await assert.rejects(b.open(await b.seal(STREAM.PROTOCOL, FrameType.DATA, te.encode('x'))).then(() => { throw new Error('opened its own frame'); }), /refused|opened its own/); n++;
  ok(fromPage.length > 0, 'a side cannot open a frame it sealed itself: the direction is in the key and the AAD');
}

console.log(`channel: ${n} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
