import * as opaque from '@serenity-kit/opaque';

/**
 * The sealed channel between the remote page and her gateway — the one piece of code both ends run,
 * so neither can be fooled into speaking something weaker. Three layers, in order:
 *
 * 1. **OPAQUE** (RFC 9807, `@serenity-kit/opaque` — Serenity Kit, Austria, a WASM build of Meta's
 *    `opaque-ke`, Rust, US). A password-authenticated key exchange: the password never crosses the
 *    wire in any form, the relay watching the whole handshake learns nothing it could guess offline,
 *    and a gateway that does not hold the registration record cannot finish a login — which is how
 *    the page knows it reached *her* and not the relay wearing her name. Registration runs both
 *    roles locally on her machine (`register`), so even her own gateway never sees a password.
 * 2. **Keys and frames.** HKDF-SHA256 from the session key gives one AES-256-GCM key per direction.
 *    Nonces come from a 64-bit counter that each side keeps for each direction and never transmits:
 *    a frame that arrives twice, or out of order, decrypts against the wrong counter and fails, so
 *    replay costs no extra machinery. The AAD is the direction and the counter. Any failure — a
 *    flipped byte, a replay, a counter that would wrap — closes the channel with a reason; nothing
 *    is ever retried with a second nonce.
 * 3. **Streams.** One channel carries everything the browser page needs, so the relay forwards one
 *    kind of thing: `[stream u32][type u8][payload]` inside each sealed frame. Stream 0 is control
 *    (open, close, ping, pong, ack), stream 1 the gateway's JSON protocol, stream 2 the VNC byte
 *    pipe, streams 3 and up one file transfer each. A simple window (1 MiB in flight, then wait for
 *    an ack) keeps a fast VNC stream from asking the relay to be a buffer.
 *
 * Isomorphic on purpose: WebCrypto through `globalThis.crypto.subtle`, no `node:` import, no DOM.
 * Node 22 and every browser that can run the page have both. No `vscode` import.
 */

/* ---------- OPAQUE ---------- */

/** What her gateway keeps in `secrets.json` so it can answer a login. Never leaves her machine. */
export interface RemoteRecord {
  /** The username this record belongs to; the OPAQUE identity both sides bind to. */
  username: string;
  /** The OPRF seed and the server keypair, made once. */
  serverSetup: string;
  /** The registration record: enough to verify a password, never enough to learn it. */
  record: string;
}

/** The server identity both ends bind into the handshake (any fixed string; it must simply agree). */
const SERVER_ID = 'deskfish-gateway';

/**
 * argon2id at 2^16 KiB (64 MiB), 3 passes: the library's "memory-constrained" default. The RFC's
 * own recommendation is 2 GiB, which a phone browser cannot allocate — and the phone is the point.
 * Registration (at home, in Node) and login (on the phone) must use the same setting, so it is one
 * constant, here, for both roles. The library applies it at the `finish` step, not the `start` one
 * (its README says otherwise; its types are right and the wasm agrees).
 */
const KEY_STRETCHING = 'memory-constrained' as const;

const identifiers = (username: string) => ({ client: username, server: SERVER_ID });

/** The library's WASM is inlined; this resolves once and is cheap to await again. */
export const opaqueReady: Promise<void> = opaque.ready;

/**
 * Both OPAQUE roles, locally: the password is turned into a record her gateway can check and then
 * forgotten. Runs on her machine only (`deskfish remote password`), never over any wire. A
 * `serverSetup` from an earlier call is reused so her Ed25519 enrolment and her record stay a pair.
 */
export async function register(username: string, password: string, serverSetup?: string): Promise<RemoteRecord> {
  await opaqueReady;
  const setup = serverSetup || opaque.server.createSetup();
  const started = opaque.client.startRegistration({ password });
  const { registrationResponse } = opaque.server.createRegistrationResponse({ serverSetup: setup, userIdentifier: username, registrationRequest: started.registrationRequest });
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState: started.clientRegistrationState,
    registrationResponse,
    password,
    identifiers: identifiers(username),
    keyStretching: KEY_STRETCHING,
  });
  return { username, serverSetup: setup, record: registrationRecord };
}

/** Moves one handshake message; in life the relay carries it, in the tests a pair of arrays. */
export type Send = (message: string) => void | Promise<void>;
export type Recv = () => Promise<string>;

/** Thrown when a login does not complete. The `sentence` is what a person should be shown. */
export class LoginRefused extends Error {
  constructor(readonly sentence: string) {
    super(sentence);
    this.name = 'LoginRefused';
  }
}

/**
 * The page's half: three messages, then a session key. `undefined` from the library means the
 * server could not prove it holds the record for this password — a wrong password, or something
 * that is not her. The two are indistinguishable by design (a relay must not learn which), so the
 * sentence names both.
 */
export async function loginClient(username: string, password: string, send: Send, recv: Recv): Promise<{ sessionKey: string; exportKey: string }> {
  await opaqueReady;
  const started = opaque.client.startLogin({ password });
  await send(started.startLoginRequest);
  const loginResponse = await recv();
  const finished = opaque.client.finishLogin({
    clientLoginState: started.clientLoginState,
    loginResponse,
    password,
    identifiers: identifiers(username),
    keyStretching: KEY_STRETCHING,
  });
  if (!finished) throw new LoginRefused('That password is not right, or the computer that answered is not hers.');
  await send(finished.finishLoginRequest);
  return { sessionKey: finished.sessionKey, exportKey: finished.exportKey };
}

/** Her gateway's half. A wrong password fails here too, at the third message, and throws. */
export async function loginServer(record: RemoteRecord, send: Send, recv: Recv): Promise<{ sessionKey: string }> {
  await opaqueReady;
  const startLoginRequest = await recv();
  const started = opaque.server.startLogin({
    serverSetup: record.serverSetup,
    registrationRecord: record.record,
    startLoginRequest,
    userIdentifier: record.username,
    identifiers: identifiers(record.username),
  });
  await send(started.loginResponse);
  const finishLoginRequest = await recv();
  try {
    const { sessionKey } = opaque.server.finishLogin({ serverLoginState: started.serverLoginState, finishLoginRequest, identifiers: identifiers(record.username) });
    return { sessionKey };
  } catch {
    throw new LoginRefused('That password is not right.');
  }
}

/* ---------- keys and frames ---------- */

export type Role = 'page' | 'gateway';

/** Which way a frame travels. It is the first byte of the AAD, so a frame cannot be replayed back. */
const DIRECTION: Record<Role, number> = { page: 0, gateway: 1 };

const HKDF_INFO: Record<Role, string> = { page: 'deskfish-remote v1 page->gateway', gateway: 'deskfish-remote v1 gateway->page' };
const HKDF_SALT = 'deskfish-remote v1';

/** The last counter a direction may use; the next frame would repeat a nonce, so the channel closes instead. */
const MAX_COUNTER = 0xffffffffffffffffn;

/** In flight per stream before the sender waits for an ack. The relay is never asked to be a buffer. */
export const WINDOW = 1024 * 1024;

/**
 * The most plaintext one frame carries. The relay refuses a WebSocket message over 1 MiB, so a
 * stream splits rather than handing anyone a frame that would be dropped in the middle: a caller
 * may `send` a whole file and never think about it.
 */
export const CHUNK = 256 * 1024;

const te = new TextEncoder();
const td = new TextDecoder();

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('this runtime has no WebCrypto (Node 22 or a modern browser is needed)');
  return c.subtle;
};

/** base64url without padding (what the OPAQUE library hands back) → bytes, with no Buffer and no atob quirks. */
export function fromBase64Url(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = typeof atob === 'function' ? atob(std + '='.repeat((4 - (std.length % 4)) % 4)) : Buffer.from(std, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The two direction keys from one session key. Each side derives both and uses them opposite ways. */
export async function deriveKeys(sessionKey: string): Promise<Record<Role, CryptoKey>> {
  const s = subtle();
  const base = await s.importKey('raw', fromBase64Url(sessionKey) as unknown as ArrayBuffer, 'HKDF', false, ['deriveKey']);
  const one = (role: Role) =>
    s.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: te.encode(HKDF_SALT) as unknown as ArrayBuffer, info: te.encode(HKDF_INFO[role]) as unknown as ArrayBuffer },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  return { page: await one('page'), gateway: await one('gateway') };
}

/** 12-byte nonce: four zero bytes, then the counter big-endian. One counter is used once, ever. */
function nonce(counter: bigint): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setBigUint64(4, counter);
  return out;
}

/** The additional data a frame is bound to: the direction it travels and its place in that stream of frames. */
function aad(direction: number, counter: bigint): Uint8Array {
  const out = new Uint8Array(9);
  out[0] = direction;
  new DataView(out.buffer).setBigUint64(1, counter);
  return out;
}

/** Frame types. On stream 0 they are control; on any other stream only `DATA` is meaningful. */
export const FrameType = { DATA: 0, OPEN: 1, CLOSE: 2, PING: 3, PONG: 4, ACK: 5 } as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/** What a stream is for. The page opens them; the gateway answers. */
export const StreamKind = { PROTOCOL: 1, VNC: 2, FILE: 3 } as const;
export type StreamKind = (typeof StreamKind)[keyof typeof StreamKind];

/** Fixed ids, so neither end has to be told: 1 the protocol, 2 the live view. File transfers take 3 and up. */
export const STREAM = { CONTROL: 0, PROTOCOL: 1, VNC: 2, FIRST_FILE: 3 } as const;

export interface Plain {
  stream: number;
  type: FrameType;
  payload: Uint8Array;
}

const EMPTY = new Uint8Array(0);

/**
 * One sealed channel. `send` hands a frame to whatever carries it (the relay, in life); `receive`
 * is fed every frame that arrives. Once closed it stays closed: no frame is sealed or opened after,
 * because the only safe answer to a frame that did not verify is to stop.
 */
export class Channel {
  private outCounter = 0n;
  private inCounter = 0n;
  /**
   * Sealing and opening are asynchronous (WebCrypto is), and the counters are the frame order: two
   * frames sealed at once could otherwise reach the carrier in the wrong order and the far end would
   * read the second as a replay. So each direction runs in a chain of one.
   */
  private writeChain: Promise<unknown> = Promise.resolve();
  private readChain: Promise<unknown> = Promise.resolve();
  private closed?: string;
  private closeHandlers: ((reason: string) => void)[] = [];
  readonly mux: Mux;

  private constructor(
    private readonly role: Role,
    private readonly keys: Record<Role, CryptoKey>,
    private readonly transport: (frame: Uint8Array) => void,
    private readonly maxCounter: bigint,
  ) {
    this.mux = new Mux(this, role);
  }

  /**
   * The channel for a finished login. `role` says which end this is; the keys follow from it.
   * `maxCounter` is only ever lowered by a test that proves a wrap closes the channel rather than
   * repeating a nonce.
   */
  static async create(sessionKey: string, role: Role, send: (frame: Uint8Array) => void, maxCounter = MAX_COUNTER): Promise<Channel> {
    return new Channel(role, await deriveKeys(sessionKey), send, maxCounter);
  }

  get isClosed(): boolean {
    return this.closed !== undefined;
  }

  get closedReason(): string | undefined {
    return this.closed;
  }

  onClose(fn: (reason: string) => void): void {
    if (this.closed !== undefined) fn(this.closed);
    else this.closeHandlers.push(fn);
  }

  /** `[stream u32][type u8][payload]`, sealed against this side's next counter, in order. */
  seal(stream: number, type: FrameType, payload: Uint8Array = EMPTY): Promise<Uint8Array> {
    const run = this.writeChain.then(
      () => this.sealNow(stream, type, payload),
      () => this.sealNow(stream, type, payload),
    );
    this.writeChain = run.catch(() => {});
    return run;
  }

  private async sealNow(stream: number, type: FrameType, payload: Uint8Array): Promise<Uint8Array> {
    if (this.closed !== undefined) throw new Error(`the channel is closed: ${this.closed}`);
    if (this.outCounter > this.maxCounter) {
      this.fail('this channel has sent as many frames as one set of keys may carry');
      throw new Error('counter exhausted');
    }
    const counter = this.outCounter++;
    const plain = new Uint8Array(5 + payload.length);
    new DataView(plain.buffer).setUint32(0, stream >>> 0);
    plain[4] = type;
    plain.set(payload, 5);
    const direction = DIRECTION[this.role];
    const sealed = await subtle().encrypt(
      { name: 'AES-GCM', iv: nonce(counter) as unknown as ArrayBuffer, additionalData: aad(direction, counter) as unknown as ArrayBuffer },
      this.keys[this.role],
      plain as unknown as ArrayBuffer,
    );
    return new Uint8Array(sealed);
  }

  /** The other side's next frame, or a throw — which always means the channel is finished. */
  open(frame: Uint8Array): Promise<Plain> {
    const run = this.readChain.then(
      () => this.openNow(frame),
      () => this.openNow(frame),
    );
    this.readChain = run.catch(() => {});
    return run;
  }

  private async openNow(frame: Uint8Array): Promise<Plain> {
    if (this.closed !== undefined) throw new Error(`the channel is closed: ${this.closed}`);
    const other: Role = this.role === 'page' ? 'gateway' : 'page';
    const counter = this.inCounter;
    if (counter > this.maxCounter) {
      this.fail('this channel has carried as many frames as one set of keys may carry');
      throw new Error('counter exhausted');
    }
    let plain: ArrayBuffer;
    try {
      plain = await subtle().decrypt(
        { name: 'AES-GCM', iv: nonce(counter) as unknown as ArrayBuffer, additionalData: aad(DIRECTION[other], counter) as unknown as ArrayBuffer },
        this.keys[other],
        frame as unknown as ArrayBuffer,
      );
    } catch {
      this.fail('a frame arrived that this channel could not open — it was changed, repeated or out of order');
      throw new Error('frame refused');
    }
    if (plain.byteLength < 5) {
      this.fail('a frame arrived too short to be one of ours');
      throw new Error('frame refused');
    }
    this.inCounter = counter + 1n;
    const bytes = new Uint8Array(plain);
    return { stream: new DataView(plain).getUint32(0), type: bytes[4] as FrameType, payload: bytes.subarray(5) };
  }

  /**
   * Seal and hand to the carrier. Every send in the channel goes through here, and the seal chain
   * keeps the handover in counter order.
   */
  write(stream: number, type: FrameType, payload?: Uint8Array): Promise<void> {
    const run = this.writeChain.then(
      () => this.sealAndSend(stream, type, payload ?? EMPTY),
      () => this.sealAndSend(stream, type, payload ?? EMPTY),
    );
    this.writeChain = run.catch(() => {});
    return run;
  }

  private async sealAndSend(stream: number, type: FrameType, payload: Uint8Array): Promise<void> {
    const frame = await this.sealNow(stream, type, payload);
    if (this.closed !== undefined) return;
    this.transport(frame);
  }

  /** One arriving frame: opened, then given to the mux. A frame that does not open closes the channel. */
  receive(frame: Uint8Array): Promise<void> {
    const run = this.readChain.then(
      () => this.receiveNow(frame),
      () => this.receiveNow(frame),
    );
    this.readChain = run.catch(() => {});
    return run;
  }

  private async receiveNow(frame: Uint8Array): Promise<void> {
    if (this.closed !== undefined) return;
    let plain: Plain;
    try {
      plain = await this.openNow(frame);
    } catch {
      return; // `openNow` already closed the channel with the reason
    }
    this.mux.deliver(plain);
  }

  /** Tell the other end, then stop. Safe to call twice. */
  close(reason: string): void {
    if (this.closed !== undefined) return;
    const bytes = te.encode(reason.slice(0, 200));
    const payload = new Uint8Array(4 + bytes.length);
    payload.set(bytes, 4);
    this.write(STREAM.CONTROL, FrameType.CLOSE, payload).then(
      () => this.fail(reason),
      () => this.fail(reason),
    );
  }

  /** Stop without telling anyone (the carrier died, or a frame did not verify). */
  fail(reason: string): void {
    if (this.closed !== undefined) return;
    this.closed = reason;
    this.mux.channelClosed(reason);
    const handlers = this.closeHandlers;
    this.closeHandlers = [];
    for (const fn of handlers) fn(reason);
  }

  /** Counters as they stand, for the nonce-discipline test. */
  get counters(): { out: bigint; in: bigint } {
    return { out: this.outCounter, in: this.inCounter };
  }
}

/* ---------- streams ---------- */

export interface Stream {
  readonly id: number;
  readonly kind: StreamKind;
  /** Queued in order and written as the window allows; never blocks the caller. */
  send(data: Uint8Array): void;
  onData(fn: (data: Uint8Array) => void): void;
  onClose(fn: (reason: string) => void): void;
  close(reason?: string): void;
  readonly isClosed: boolean;
  /** Bytes waiting for window, for the backpressure test. */
  readonly queued: number;
}

class MuxStream implements Stream {
  private dataHandlers: ((data: Uint8Array) => void)[] = [];
  private closeHandlers: ((reason: string) => void)[] = [];
  private queue: Uint8Array[] = [];
  private inFlight = 0;
  private sending = false;
  private consumed = 0;
  closedReason?: string;

  constructor(
    readonly id: number,
    readonly kind: StreamKind,
    private readonly mux: Mux,
  ) {}

  get isClosed(): boolean {
    return this.closedReason !== undefined;
  }

  get queued(): number {
    return this.queue.reduce((n, b) => n + b.length, 0);
  }

  /** Split at `CHUNK` so no frame is bigger than the relay will carry; the pieces keep their order. */
  send(data: Uint8Array): void {
    if (this.closedReason !== undefined || !data.length) return;
    for (let at = 0; at < data.length; at += CHUNK) this.queue.push(data.subarray(at, Math.min(at + CHUNK, data.length)));
    void this.drain();
  }

  /** Hands the queue to the channel while the window allows, in order, one frame at a time. */
  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length && this.closedReason === undefined && this.inFlight < WINDOW) {
        const next = this.queue.shift()!;
        this.inFlight += next.length;
        await this.mux.writeData(this.id, next);
      }
    } catch {
      /* the channel closed under us; `channelClosed` tells the handlers */
    } finally {
      this.sending = false;
    }
  }

  /** The other end says it has taken `bytes`; that much window is free again. */
  acked(bytes: number): void {
    this.inFlight = Math.max(0, this.inFlight - bytes);
    void this.drain();
  }

  deliver(data: Uint8Array): void {
    this.consumed += data.length;
    for (const fn of this.dataHandlers) fn(data);
    // Ack in one lump per window's worth rather than per frame: the relay carries fewer frames.
    if (this.consumed >= WINDOW / 4) {
      const n = this.consumed;
      this.consumed = 0;
      this.mux.writeAck(this.id, n);
    }
  }

  onData(fn: (data: Uint8Array) => void): void {
    this.dataHandlers.push(fn);
  }

  onClose(fn: (reason: string) => void): void {
    if (this.closedReason !== undefined) fn(this.closedReason);
    else this.closeHandlers.push(fn);
  }

  close(reason = ''): void {
    if (this.closedReason !== undefined) return;
    this.mux.closeStream(this.id, reason);
  }

  /** Closed by either end, or because the channel went. */
  ended(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.queue = [];
    const handlers = this.closeHandlers;
    this.closeHandlers = [];
    this.dataHandlers = [];
    for (const fn of handlers) fn(reason);
  }
}

/**
 * The streams inside one channel. The page opens; the gateway answers `onStream`. Control frames
 * (open, close, ack, ping) ride stream 0 and name the stream they are about in their first four
 * bytes, so a reader never has to guess what a frame belongs to.
 */
export class Mux {
  private readonly streams = new Map<number, MuxStream>();
  private nextFile = STREAM.FIRST_FILE;
  private streamHandlers: ((stream: Stream) => void)[] = [];
  private pingHandlers: (() => void)[] = [];

  constructor(
    private readonly channel: Channel,
    private readonly role: Role,
  ) {}

  /** A stream this end opens. `PROTOCOL` and `VNC` have fixed ids; each file transfer takes the next one. */
  open(kind: StreamKind): Stream {
    const id = kind === StreamKind.PROTOCOL ? STREAM.PROTOCOL : kind === StreamKind.VNC ? STREAM.VNC : this.nextFile++;
    if (this.streams.has(id)) throw new Error(`stream ${id} is already open`);
    const stream = new MuxStream(id, kind, this);
    this.streams.set(id, stream);
    const payload = new Uint8Array(5);
    new DataView(payload.buffer).setUint32(0, id);
    payload[4] = kind;
    void this.write(STREAM.CONTROL, FrameType.OPEN, payload);
    return stream;
  }

  /** The other end opened one. */
  onStream(fn: (stream: Stream) => void): void {
    this.streamHandlers.push(fn);
  }

  onPing(fn: () => void): void {
    this.pingHandlers.push(fn);
  }

  get(id: number): Stream | undefined {
    return this.streams.get(id);
  }

  /** A keep-alive, so a carrier that quietly died is noticed. */
  ping(): void {
    void this.write(STREAM.CONTROL, FrameType.PING);
  }

  /* ---------- what the streams call ---------- */

  writeData(id: number, data: Uint8Array): Promise<void> {
    return this.write(id, FrameType.DATA, data);
  }

  writeAck(id: number, bytes: number): void {
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, id);
    view.setUint32(4, bytes);
    void this.write(STREAM.CONTROL, FrameType.ACK, payload);
  }

  closeStream(id: number, reason: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    const bytes = te.encode(reason.slice(0, 200));
    const payload = new Uint8Array(4 + bytes.length);
    new DataView(payload.buffer).setUint32(0, id);
    payload.set(bytes, 4);
    void this.write(STREAM.CONTROL, FrameType.CLOSE, payload);
    stream.ended(reason);
  }

  private write(stream: number, type: FrameType, payload?: Uint8Array): Promise<void> {
    return this.channel.write(stream, type, payload).catch(() => {});
  }

  /* ---------- what the channel calls ---------- */

  /** One opened frame. Anything malformed closes the channel: there is no safe way to guess. */
  deliver(plain: Plain): void {
    if (plain.stream !== STREAM.CONTROL) {
      const stream = this.streams.get(plain.stream);
      if (plain.type !== FrameType.DATA) return this.channel.fail(`a stream frame of type ${plain.type} is not part of this protocol`);
      if (!stream) return; // a frame for a stream this end has already closed: dropped, not fatal
      stream.deliver(plain.payload);
      return;
    }
    const view = plain.payload.length >= 4 ? new DataView(plain.payload.buffer, plain.payload.byteOffset, plain.payload.byteLength) : undefined;
    switch (plain.type) {
      case FrameType.PING:
        void this.write(STREAM.CONTROL, FrameType.PONG);
        return;
      case FrameType.PONG:
        for (const fn of this.pingHandlers) fn();
        return;
      case FrameType.OPEN: {
        if (!view || plain.payload.length < 5) return this.channel.fail('an open frame arrived without a stream');
        const id = view.getUint32(0);
        const kind = plain.payload[4] as StreamKind;
        if (id === STREAM.CONTROL || this.streams.has(id)) return this.channel.fail(`the other end opened stream ${id}, which is not free`);
        if (kind !== StreamKind.PROTOCOL && kind !== StreamKind.VNC && kind !== StreamKind.FILE) return this.channel.fail(`stream ${id} was opened as a kind this version does not know`);
        if (this.role === 'page') return this.channel.fail('the gateway may not open streams; only the page does');
        const stream = new MuxStream(id, kind, this);
        this.streams.set(id, stream);
        for (const fn of this.streamHandlers) fn(stream);
        return;
      }
      case FrameType.CLOSE: {
        if (!view) return this.channel.fail('a close frame arrived without a stream');
        const id = view.getUint32(0);
        const reason = td.decode(plain.payload.subarray(4));
        if (id === STREAM.CONTROL) return this.channel.fail(reason || 'the other end closed the channel');
        const stream = this.streams.get(id);
        this.streams.delete(id);
        stream?.ended(reason);
        return;
      }
      case FrameType.ACK: {
        if (!view || plain.payload.length < 8) return this.channel.fail('an ack frame arrived without a count');
        this.streams.get(view.getUint32(0))?.acked(view.getUint32(4));
        return;
      }
      default:
        return this.channel.fail(`a control frame of type ${plain.type} is not part of this protocol`);
    }
  }

  channelClosed(reason: string): void {
    const streams = [...this.streams.values()];
    this.streams.clear();
    this.streamHandlers = [];
    this.pingHandlers = [];
    for (const s of streams) s.ended(reason);
  }
}
