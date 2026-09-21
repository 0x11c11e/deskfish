import * as crypto from 'node:crypto';
import WebSocket from 'ws';
import { formatSize, safeFileName } from '../desktop/files';
import { Channel, LoginRefused, StreamKind, loginServer, type RemoteRecord, type Stream } from '../remote/channel';
import { vncUrlWithToken, type DeskfishConfig } from './config';
import { MAX_TRANSFER } from './protocol';
import type { DesktopFile } from '../webview/protocol';

/**
 * The uplink: her gateway's one outbound connection to a relay, and the fifth kind of client.
 *
 * His computer opens no port (05-user, 2026-09-20: *"I don't want to open any port to the outside
 * world at all"*), so the direction is reversed. This dials *out* to the relay and holds a
 * WebSocket, the way the Claude Code terminal holds one to Anthropic. The relay maps a username to
 * that socket and hands over `[clientId u32][bytes]` for every browser that asks for her; each
 * client number becomes one **session** here, and a session is a whole sealed channel:
 *
 * 1. Three plaintext frames of OPAQUE (`src/remote/channel.ts`), this end playing the server role
 *    from the record in `secrets.json`. Whoever watches the relay learns nothing they could guess
 *    offline, and a relay that tried to answer in her place cannot finish the handshake — that is
 *    what lets the page say *this is not her* rather than show a chat.
 * 2. Everything after that is AES-256-GCM inside the channel, so the relay carries ciphertext.
 * 3. Inside the channel the page opens streams: **1** the gateway's own JSON protocol, spoken by a
 *    virtual client that is a client of `GatewayServer` exactly as a WebSocket is; **2** the VNC
 *    bytes, piped to the tank's websockify (what `/vnc` proxies for a browser at home); **3 and up**
 *    one file transfer each, doing what `POST /files` and `GET /files/…` do.
 *
 * Nothing here writes a file of hers, and nothing here is a second writer of anything: the uplink
 * is a client, like VS Code. A wrong password is refused *here*, not at the relay — only her
 * gateway knows what the right one is — and refused slowly enough that guessing is useless.
 *
 * No `vscode` import.
 */

/* ---------- what the gateway lends a session ---------- */

/** One client of the protocol, from the server's side: it sends text frames and can be told things. */
export interface ClientLink {
  /** One text frame this client sent. */
  message(text: string): void;
  /** It sent something that is not part of the protocol. */
  refuse(why: string): void;
  /** It is gone. */
  close(): void;
}

export interface UplinkHost {
  /** Attach a client of the wire protocol; `send` carries a frame to it. */
  attach(kind: 'remote', send: (text: string) => void): ClientLink;
  /** The settings she runs on (the tank's address lives here). */
  config(): DeskfishConfig;
  uploadFile(name: string, data: Uint8Array): Promise<DesktopFile>;
  readFile(file: DesktopFile): Promise<Buffer>;
  log(line: string): void;
}

/** What `deskfish remote status` and the settings view show. Never a key, never the password. */
export interface RemoteStatus {
  relay: string;
  username: string;
  /** A key is enrolled at the relay. */
  enrolled: boolean;
  /** A password has been set (the OPAQUE record is here). */
  hasPassword: boolean;
  state: 'off' | 'connecting' | 'connected' | 'error';
  /** Browsers on this uplink right now. */
  clients: number;
  /** Why the last attempt failed, as a sentence. */
  lastError?: string;
  /** When the current state began, as epoch milliseconds. */
  since: number;
}

/* ---------- addresses ---------- */

/**
 * The relay as the two addresses it is: a WebSocket one for the uplink, an HTTP one for enrolment.
 * A person may type any of `relay.example.com`, `wss://relay.example.com` or `https://…`; a bare
 * name means TLS, because a relay without it is a relay that reads the handshake.
 */
export function relayUrls(relay: string): { ws: string; http: string } {
  const text = relay.trim();
  if (!text) throw new Error('no relay address');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `wss://${text}`;
  const url = new URL(withScheme);
  const secure = url.protocol === 'wss:' || url.protocol === 'https:';
  if (!secure && url.protocol !== 'ws:' && url.protocol !== 'http:') throw new Error(`${relay} is not a relay address`);
  const base = url.pathname.replace(/\/+$/, '');
  return {
    ws: `${secure ? 'wss:' : 'ws:'}//${url.host}${base}`,
    http: `${secure ? 'https:' : 'http:'}//${url.host}${base}`,
  };
}

/** An Ed25519 keypair for the uplink: the private half stays in `secrets.json`, the relay gets the public one. */
export function newUplinkKey(): { privateKey: string; publicKey: string } {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).subarray(-32).toString('base64url'),
  };
}

/** Spend an enrolment code at a relay: it learns a username and a public key, and nothing else. */
export async function enrollAtRelay(relay: string, username: string, code: string, publicKey: string): Promise<void> {
  const { http } = relayUrls(relay);
  let res: Response;
  try {
    res = await fetch(`${http}/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, username, publicKey }) });
  } catch (err) {
    throw new Error(`the relay at ${http} did not answer (${err instanceof Error ? err.message : String(err)})`);
  }
  if (res.ok) return;
  let sentence = `the relay refused the enrolment (HTTP ${res.status})`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) sentence = `the relay refused the enrolment: ${body.error}`;
  } catch {
    /* not JSON: the status is all there is */
  }
  throw new Error(sentence);
}

/* ---------- the wrong-password fence ---------- */

/**
 * Requirement 5's limit, kept where the answer is known: five *failed* logins a minute, then a
 * minute in which none is tried at all. Successes are not counted — a phone with three tabs open,
 * or a page reloaded twice, is a person using her, not an attacker — and a login that simply stops
 * answering counts as a failure, so silence is no cheaper than a wrong guess.
 */
class Fence {
  private failures: number[] = [];
  private until = 0;

  constructor(
    private readonly max = 5,
    private readonly windowMs = 60_000,
    private readonly waitMs = 60_000,
  ) {}

  /** How long the wait still is, in seconds; 0 when a login may be tried. */
  blockedFor(now = Date.now()): number {
    return this.until > now ? Math.ceil((this.until - now) / 1000) : 0;
  }

  failed(now = Date.now()): void {
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.max) {
      this.until = now + this.waitMs;
      this.failures = [];
    }
  }
}

/* ---------- one browser ---------- */

/**
 * How long a login may take before the session is dropped. A phone stretching the password with
 * argon2id at 64 MiB takes a second or three; twenty is room to spare and short enough that a
 * handshake left hanging on purpose is not a way of holding a slot for long.
 */
const LOGIN_TIMEOUT_MS = 20_000;
/** The relay puts a four-byte client number in front of every frame, and refuses a message over 1 MiB. */
const MAX_FRAME_UP = 1024 * 1024 - 4;
/** A whole file transfer may not ask for more than the gateway would copy at `POST /files`. */
const MAX_FILE = MAX_TRANSFER;

type Refusal = { refused: string };

/**
 * One browser, from `{open: id}` to `{close: id}`. It is a state machine of two states: the
 * handshake, in which frames are plaintext OPAQUE messages, and the channel, in which they are
 * sealed. Nothing in between: the moment the session key exists, every later frame goes through
 * the channel, and a frame that does not open ends the session.
 */
class Session {
  private readonly inbox: Uint8Array[] = [];
  private waiter?: (frame: Uint8Array) => void;
  private pumping = false;
  private channel?: Channel;
  private link?: ClientLink;
  private vnc?: WebSocket;
  private done = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** This session never got past the handshake and has been counted against the wrong-password fence. */
  private counted = false;
  /** It was turned away because the fence was already up; it must not count a second time. */
  private blocked = false;

  constructor(
    readonly id: number,
    private readonly host: UplinkHost,
    private readonly record: RemoteRecord,
    private readonly fence: Fence,
    private readonly send: (bytes: Uint8Array) => void,
    private readonly ended: (id: number, why: string) => void,
  ) {}

  /** True once the password was right and the channel exists. */
  get signedIn(): boolean {
    return !!this.channel;
  }

  /** The handshake, then the channel. Called once, when the relay says a browser arrived. */
  start(): void {
    const wait = this.fence.blockedFor();
    if (wait) {
      this.blocked = true;
      this.refuse(`Too many wrong passwords. Try again in ${wait} second${wait === 1 ? '' : 's'}.`);
      this.host.log(`remote: a login was refused while the wrong-password wait runs (${wait}s left)`);
      return;
    }
    this.timer = setTimeout(() => {
      if (this.channel) return;
      this.host.log('remote: a login stopped halfway and was dropped');
      this.finish('the login took too long');
    }, LOGIN_TIMEOUT_MS);
    void this.login();
  }

  private async login(): Promise<void> {
    let sessionKey: string;
    try {
      ({ sessionKey } = await loginServer(this.record, (m) => this.send(new TextEncoder().encode(m)), () => this.next()));
    } catch (err) {
      if (this.done) return;
      this.host.log(`remote: a login was refused (${err instanceof LoginRefused ? err.sentence : err instanceof Error ? err.message : String(err)})`);
      // The page's own `finishLogin` already told the person; nothing here can be more specific
      // without telling an attacker which half was wrong.
      this.finish('the login was refused');
      return;
    }
    if (this.done) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const channel = await Channel.create(sessionKey, 'gateway', (frame) => {
      if (frame.length > MAX_FRAME_UP) return this.fail('a frame larger than the relay carries');
      this.send(frame);
    });
    if (this.done) return;
    channel.onClose((reason) => this.finish(reason));
    channel.mux.onStream((stream) => this.serve(stream));
    this.channel = channel;
    this.host.log(`remote: browser ${this.id} signed in`);
    this.pump();
  }

  /** A frame from the relay, in the order it arrived. */
  frame(bytes: Uint8Array): void {
    if (this.done) return;
    this.inbox.push(bytes);
    this.pump();
  }

  /**
   * The one consumer of the inbox, so a frame never overtakes the one before it: the handshake
   * takes frames one at a time, the channel takes every frame in turn, and an arrival while
   * neither is ready simply waits.
   */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void (async () => {
      try {
        while (!this.done && this.inbox.length) {
          if (this.channel) {
            await this.channel.receive(this.inbox.shift()!);
            continue;
          }
          if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = undefined;
            waiter(this.inbox.shift()!);
            continue;
          }
          break; // the handshake is thinking; the frames keep their order in the inbox
        }
      } finally {
        this.pumping = false;
      }
    })();
  }

  /** The next handshake message, as the OPAQUE library wants it: one base64url string. */
  private next(): Promise<string> {
    return new Promise<Uint8Array>((resolve) => {
      this.waiter = resolve;
      this.pump();
    }).then((bytes) => new TextDecoder().decode(bytes));
  }

  /** Say why, in a sentence, while the channel does not exist yet; then stop. */
  private refuse(sentence: string): void {
    this.send(new TextEncoder().encode(JSON.stringify({ refused: sentence } satisfies Refusal)));
    this.finish(sentence);
  }

  private fail(why: string): void {
    this.channel?.fail(why);
    this.finish(why);
  }

  /* ---------- the streams ---------- */

  private serve(stream: Stream): void {
    if (stream.kind === StreamKind.PROTOCOL) return this.serveProtocol(stream);
    if (stream.kind === StreamKind.VNC) return this.serveVnc(stream);
    return this.serveFile(stream);
  }

  /**
   * Stream 1 is a client of the gateway like any other: it sends the same JSON frames VS Code
   * sends and gets the same answers and the same events. There is no token in it — the channel it
   * arrived in *is* the authentication, and nothing weaker could have opened it.
   */
  private serveProtocol(stream: Stream): void {
    const te = new TextEncoder();
    const link = this.host.attach('remote', (text) => stream.send(te.encode(text)));
    this.link = link;
    const td = new TextDecoder();
    stream.onData((data) => link.message(td.decode(data)));
    stream.onClose(() => {
      if (this.link === link) this.link = undefined;
      link.close();
    });
  }

  /**
   * Stream 2 is the tank's screen: the same websockify `/vnc` proxies for a browser at home, with
   * the daemon's own token and never the gateway's. Bytes both ways, untouched.
   */
  private serveVnc(stream: Stream): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(vncUrlWithToken(this.host.config()), ['binary'], { maxPayload: MAX_FRAME_UP });
    } catch (err) {
      stream.close(`the live view could not be reached: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.vnc = socket;
    const waiting: Uint8Array[] = [];
    let open = false;
    socket.on('open', () => {
      open = true;
      for (const b of waiting.splice(0)) socket.send(b, { binary: true });
    });
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      stream.send(new Uint8Array(bytes));
    });
    socket.on('error', (err: Error) => stream.close(`the live view ended: ${err.message}`));
    socket.on('close', () => stream.close('the live view ended'));
    stream.onData((data) => {
      if (open) socket.send(data, { binary: true });
      else waiting.push(data);
    });
    stream.onClose(() => {
      if (this.vnc === socket) this.vnc = undefined;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    });
  }

  /**
   * Streams 3 and up are one file each, and the first frame says which way it goes:
   * `{"put":{"name","size"}}` then the bytes (what `POST /files` does), or `{"get":{name,path,size}}`
   * and the bytes come back (what `GET /files/…` does). The answer is one JSON frame — `{"ok":…}`
   * or `{"error":"a sentence"}` — so a refusal reads as words in the page, not as a dropped stream.
   * The **page** closes the stream once it has the answer (and, for a download, the bytes the answer
   * promised): closing at this end would throw away whatever of the file is still queued behind the
   * window, and the page is the one that knows it has everything.
   */
  private serveFile(stream: Stream): void {
    const te = new TextEncoder();
    const td = new TextDecoder();
    type Header = { put?: { name?: unknown; size?: unknown }; get?: DesktopFile };
    let header: Header | undefined;
    const parts: Uint8Array[] = [];
    let have = 0;
    let want = 0;
    let finished = false;
    const answer = (body: unknown) => {
      if (finished) return;
      finished = true;
      stream.send(te.encode(JSON.stringify(body)));
      // The page closes when it has read the answer; closing here would race the last frame out.
    };
    const fail = (err: unknown) => answer({ error: err instanceof Error ? err.message : String(err) });

    stream.onData((data) => {
      if (finished) return;
      if (!header) {
        try {
          header = JSON.parse(td.decode(data)) as Header;
        } catch {
          return fail(new Error('a file transfer begins with a header'));
        }
        if (header?.get) return void this.sendFile(stream, header.get, answer, fail);
        const put = header?.put;
        const size = typeof put?.size === 'number' ? put.size : -1;
        if (!put || typeof put.name !== 'string' || !Number.isSafeInteger(size) || size < 0) return fail(new Error('a file transfer begins with a header'));
        if (size > MAX_FILE) return fail(new Error(`larger than ${formatSize(MAX_FILE)}`));
        want = size;
        if (want === 0) void this.takeFile(stream, put.name, new Uint8Array(0), answer, fail);
        return;
      }
      if (!header.put) return;
      have += data.length;
      if (have > want) return fail(new Error('more bytes arrived than the header promised'));
      parts.push(data);
      if (have < want) return;
      const all = new Uint8Array(have);
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
      parts.length = 0;
      void this.takeFile(stream, String(header.put.name), all, answer, fail);
    });
  }

  private async takeFile(stream: Stream, name: string, data: Uint8Array, answer: (body: unknown) => void, fail: (err: unknown) => void): Promise<void> {
    try {
      const file = await this.host.uploadFile(safeFileName(name), data);
      answer({ ok: file });
    } catch (err) {
      fail(err);
    }
  }

  private async sendFile(stream: Stream, file: DesktopFile, answer: (body: unknown) => void, fail: (err: unknown) => void): Promise<void> {
    try {
      if (typeof file?.path !== 'string' || typeof file?.name !== 'string' || typeof file?.size !== 'number') throw new Error('that is not a file');
      const data = await this.host.readFile(file);
      answer({ ok: { name: file.name, size: data.length } });
      stream.send(new Uint8Array(data));
    } catch (err) {
      fail(err);
    }
  }

  /* ---------- the end ---------- */

  /**
   * The browser, the channel or the uplink went. Everything this session held goes with it — and a
   * session that never reached a channel is one failed login, whichever way it ended. A page that
   * finds its own password wrong closes without a word (OPAQUE tells the *client* first), so
   * counting at the end is the only way the fence sees a guess at all; a login that simply stops
   * answering is counted by the same line, which is why silence buys nothing.
   */
  finish(why: string): void {
    if (this.done) return;
    this.done = true;
    if (!this.channel && !this.counted && !this.blocked) {
      this.counted = true;
      this.fence.failed();
      this.host.log('remote: a sign-in did not complete');
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.link?.close();
    this.link = undefined;
    try {
      this.vnc?.close();
    } catch {
      /* already gone */
    }
    this.vnc = undefined;
    this.channel?.fail(why);
    this.inbox.length = 0;
    this.ended(this.id, why);
  }
}

/* ---------- the uplink itself ---------- */

export interface UplinkOptions {
  relay: string;
  username: string;
  /** The Ed25519 private key, PKCS8 DER as base64 — the proof the relay checks at every connect. */
  privateKey: string;
  /** The OPAQUE record: enough to check a password, never enough to learn one. */
  record: RemoteRecord;
  host: UplinkHost;
}

/** The backoff between attempts: a second, then doubling to a minute, so a relay that is down is not hammered. */
const FIRST_DELAY = 1000;
const MAX_DELAY = 60_000;
/** The relay's own control lane: client number 0 carries `{open}` and `{close}`, never a browser's bytes. */
const CONTROL = 0;
/**
 * Logins allowed to be in flight at once. A handshake that is never finished holds a slot until it
 * times out, so without this a flood of them would be a cheaper way past the wrong-password fence
 * than guessing: three is more than a household needs and few enough that stalling buys nothing.
 */
const MAX_HANDSHAKES = 3;

export class RemoteUplink {
  private socket?: WebSocket;
  private readonly sessions = new Map<number, Session>();
  private readonly fence = new Fence();
  private delay = FIRST_DELAY;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private accepted = false;
  private state: RemoteStatus['state'] = 'connecting';
  private since = Date.now();
  private lastError?: string;

  constructor(private readonly o: UplinkOptions) {}

  get status(): Omit<RemoteStatus, 'enrolled' | 'hasPassword'> {
    return { relay: this.o.relay, username: this.o.username, state: this.state, clients: this.sessions.size, lastError: this.lastError, since: this.since };
  }

  start(): void {
    if (this.stopped) return;
    this.connect();
  }

  /** Stop for good: the sessions, the socket and the retry. Idempotent. */
  stop(why = 'the uplink was turned off'): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    for (const session of [...this.sessions.values()]) session.finish(why);
    this.sessions.clear();
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
    this.setState('off');
  }

  private setState(state: RemoteStatus['state'], error?: string): void {
    if (this.state === state && this.lastError === error) return;
    this.state = state;
    this.lastError = error;
    this.since = Date.now();
  }

  private connect(): void {
    if (this.stopped) return;
    let url: string;
    try {
      url = `${relayUrls(this.o.relay).ws}/uplink`;
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : String(err));
      this.o.host.log(`remote: ${this.lastError}`);
      return; // a relay address that is not one will not become one by waiting
    }
    this.setState('connecting');
    this.accepted = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { maxPayload: 1024 * 1024, handshakeTimeout: 15_000 });
    } catch (err) {
      return this.lost(err instanceof Error ? err.message : String(err));
    }
    this.socket = socket;
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (!isBinary) return this.said(socket, bytes);
      if (!this.accepted || bytes.length < 4) return;
      const id = bytes.readUInt32BE(0);
      const payload = new Uint8Array(bytes.subarray(4));
      if (id === CONTROL) return this.relaySaid(payload);
      this.sessions.get(id)?.frame(payload);
    });
    socket.on('close', (code: number, reason: Buffer) => this.lost(`the relay closed the uplink (${code}${reason?.length ? ` ${reason.toString()}` : ''})`));
    socket.on('error', (err: Error) => {
      // `close` follows and does the work; this keeps the error from being thrown at the process.
      this.lastError = err.message;
    });
  }

  /** The relay's text lane: the challenge before we are in, nothing after. */
  private said(socket: WebSocket, bytes: Buffer): void {
    if (this.accepted) return;
    let message: { challenge?: string; context?: string; ok?: boolean; version?: string };
    try {
      message = JSON.parse(bytes.toString('utf8'));
    } catch {
      return;
    }
    if (message.challenge) {
      let signature: string;
      try {
        const key = crypto.createPrivateKey({ key: Buffer.from(this.o.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
        const signed = Buffer.concat([Buffer.from(message.challenge, 'base64url'), Buffer.from(String(message.context ?? '')), Buffer.from(this.o.username)]);
        signature = crypto.sign(null, signed, key).toString('base64url');
      } catch (err) {
        this.setState('error', `the uplink key could not be used: ${err instanceof Error ? err.message : String(err)}`);
        this.o.host.log(`remote: ${this.lastError}`);
        socket.close();
        return;
      }
      socket.send(JSON.stringify({ username: this.o.username, signature }));
      return;
    }
    if (message.ok) {
      this.accepted = true;
      this.delay = FIRST_DELAY;
      this.setState('connected');
      this.o.host.log(`remote: the uplink to ${this.o.relay} is up as ${this.o.username}`);
    }
  }

  /** `{open: id}` and `{close: id}` — the only thing the relay ever says about a browser. */
  private relaySaid(payload: Uint8Array): void {
    let message: { open?: number; close?: number };
    try {
      message = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (typeof message.open === 'number') {
      const id = message.open;
      if (this.sessions.has(id)) return;
      if ([...this.sessions.values()].filter((s) => !s.signedIn).length >= MAX_HANDSHAKES) {
        this.toRelay(id, new TextEncoder().encode(JSON.stringify({ refused: 'Too many sign-ins are being tried on her at once. Try again in a moment.' })));
        this.toRelay(CONTROL, new TextEncoder().encode(JSON.stringify({ close: id })));
        this.o.host.log('remote: a login was turned away — three are already in flight');
        return;
      }
      const session = new Session(
        id,
        this.o.host,
        this.o.record,
        this.fence,
        (bytes) => this.toRelay(id, bytes),
        (gone, why) => this.closed(gone, why),
      );
      this.sessions.set(id, session);
      session.start();
      return;
    }
    if (typeof message.close === 'number') {
      const session = this.sessions.get(message.close);
      this.sessions.delete(message.close);
      session?.finish('the browser went');
    }
  }

  /** A session ended at this end: tell the relay to let that browser go. */
  private closed(id: number, why: string): void {
    if (this.sessions.get(id)) {
      this.sessions.delete(id);
      this.toRelay(CONTROL, new TextEncoder().encode(JSON.stringify({ close: id })));
    }
    this.o.host.log(`remote: browser ${id} ended (${why})`);
  }

  private toRelay(id: number, bytes: Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    const frame = Buffer.allocUnsafe(4 + bytes.length);
    frame.writeUInt32BE(id, 0);
    frame.set(bytes, 4);
    socket.send(frame, { binary: true });
  }

  /** The socket went (or never came). Every session on it goes, then the backoff runs. */
  private lost(why: string): void {
    this.socket = undefined;
    for (const session of [...this.sessions.values()]) session.finish('the uplink went');
    this.sessions.clear();
    if (this.stopped) return;
    const wasUp = this.state === 'connected';
    this.setState('error', why);
    if (wasUp || this.delay === FIRST_DELAY) this.o.host.log(`remote: ${why}; trying again in ${Math.round(this.delay / 1000)}s`);
    this.retry = setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, MAX_DELAY);
  }
}
