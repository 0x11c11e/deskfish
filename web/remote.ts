import { MAX_TRANSFER } from '../src/gateway/protocol';
import { Channel, LoginRefused, StreamKind, handleOf, loginClient, readMessages, warmOpaque, writeMessage, type Stream } from '../src/remote/channel';
import type { DesktopFile } from '../src/webview/protocol';
import { WebHost, browserUi, wireTitleBar, type FileTransfer, type HostEnv, type SocketLike } from './shim';

/**
 * The page at `remote.deskfish.sh` — the same chat and the same live view as the page her gateway
 * serves at home, reached from any browser through a relay that cannot read a word of it.
 *
 * It is **one static file**, and that is load-bearing rather than tidy: sealing the frames would be
 * worth nothing if the machine in the middle could hand your browser altered code. So this file is
 * published from somewhere the relay's owner does not control, and the relay only ever sees
 * ciphertext going past.
 *
 * What happens when you sign in: a WebSocket to the relay naming her *handle* — a hash of her name
 * that this page and her gateway both derive, so the relay is never told the name itself — three plaintext
 * messages of OPAQUE (the password itself never leaves this tab — not as a password, not as a hash,
 * not as anything a recording could be worked backwards from), and then one sealed channel. The
 * page's whole life lives in that channel: stream 1 is the gateway's JSON protocol, which the
 * existing `WebHost` speaks unchanged; stream 2 is the screen, handed to noVNC as a raw channel
 * where the page at home hands it a URL; streams 3 and up are one file each. There is no token
 * here to type, keep or lose — the channel *is* the sign-in.
 *
 * Everything below the sign-in is the ordinary page (`shim.ts`, `src/ui/bodies.ts`, the two view
 * bundles): one implementation of the chat and the desktop, two thin ways in.
 */

const te = new TextEncoder();
const td = new TextDecoder();

/** What this browser remembers, so only the password is typed twice a week. Never a secret. */
const RELAY_KEY = 'deskfish.remote.relay';
const USER_KEY = 'deskfish.remote.user';
/** The documentation is on the site, not on the gateway: this page has no `/docs` to ask for. */
const DOCS = 'https://deskfish.sh/docs';
/** The live view has no address of its own here; `desktop.ts` reads this and asks for the channel. */
const VNC_MARK = 'deskfish-channel:vnc';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a private window may refuse; it only costs some typing */
  }
};
const recall = (key: string): string => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};

/**
 * The relay this page talks to. A self-hoster types one once (kept in this browser); otherwise the
 * page at `remote.example.com` looks for `wss://relay.example.com`, so the file in the release is
 * the file on the site with no operator's address baked into it. `?relay=` overrides both, which is
 * what the live check uses against a relay on this machine.
 */
export function relayAddress(host: string, search: string, kept: string): string {
  const asked = new URLSearchParams(search).get('relay');
  if (asked) return normalizeRelay(asked);
  if (kept) return normalizeRelay(kept);
  const apex = /^remote\.(.+)$/i.exec(host);
  return apex ? `wss://relay.${apex[1]}` : '';
}

/** A name, a `wss://` address or an `https://` one, all as the WebSocket address they mean. */
export function normalizeRelay(text: string): string {
  const trimmed = text.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^wss?:\/\//i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^http/i, 'ws');
  return `wss://${trimmed}`;
}

/* ---------- signing in ---------- */

export interface Live {
  socket: WebSocket;
  channel: Channel;
}

/**
 * One sign-in. Every way this can fail ends in a sentence a person can act on (decision 109's rule
 * for tools, applied to a sign-in page): the relay is not there, she is not connected, too many
 * windows already, the password is wrong — or the gateway's own refusal, passed through in its own
 * words while there are still no keys to say it with.
 */
export async function signIn(relay: string, username: string, password: string, open: (url: string) => WebSocket = (url) => new WebSocket(url)): Promise<Live> {
  if (!relay) throw new LoginRefused('This page does not know which relay to call. Type one under “Relay”.');
  if (!username || !password) throw new LoginRefused('Her name and the password, please.');
  let socket: WebSocket;
  try {
    // The relay is given the handle, never the name. The password exchange below still binds to the
    // name itself, which both ends know and the relay does not.
    socket = open(`${relay}/client?user=${encodeURIComponent(await handleOf(username))}`);
  } catch {
    throw new LoginRefused(`${relay} is not an address this browser can open.`);
  }
  socket.binaryType = 'arraybuffer';

  const inbox: Uint8Array[] = [];
  let waiter: ((frame: Uint8Array) => void) | undefined;
  let channel: Channel | undefined;
  let pumping = false;
  let relaySaid: { offline?: boolean; busy?: boolean } | undefined;
  let gone = false;
  // One consumer, so a frame never overtakes the one before it: the handshake takes them one at a
  // time, the channel takes every one in turn, and an arrival while neither is ready waits its turn.
  const pump = () => {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try {
        while (inbox.length) {
          if (channel) {
            await channel.receive(inbox.shift()!);
            continue;
          }
          if (waiter) {
            const take = waiter;
            waiter = undefined;
            take(inbox.shift()!);
            continue;
          }
          break;
        }
      } finally {
        pumping = false;
      }
    })();
  };
  socket.onmessage = (ev: MessageEvent) => {
    // Text is the relay speaking for itself; binary is her gateway, forwarded.
    if (typeof ev.data === 'string') {
      try {
        relaySaid = JSON.parse(ev.data);
      } catch {
        /* nothing this page understands */
      }
      return;
    }
    inbox.push(new Uint8Array(ev.data as ArrayBuffer));
    pump();
  };

  const ended = new Promise<void>((resolve) => {
    socket.onclose = () => {
      gone = true;
      channel?.fail('The connection to her ended.');
      resolve();
    };
    socket.onerror = () => {
      gone = true;
      resolve();
    };
  });
  const opened = new Promise<boolean>((resolve) => {
    socket.onopen = () => resolve(true);
    void ended.then(() => resolve(false));
  });
  if (!(await opened)) throw new LoginRefused(`Could not reach the relay at ${relay}.`);

  const recv = async (): Promise<string> => {
    const frame = await Promise.race([new Promise<Uint8Array>((resolve) => ((waiter = resolve), pump())), ended.then(() => undefined)]);
    if (!frame) {
      if (relaySaid?.offline) throw new LoginRefused('She is not connected right now. Her computer may be asleep, or she may have remote access turned off.');
      if (relaySaid?.busy) throw new LoginRefused('Too many windows are already open on her. Close one and try again.');
      throw new LoginRefused('The relay closed the connection without saying why.');
    }
    const text = td.decode(frame);
    // Her gateway, refusing in words while there are still no keys to say it with.
    if (text.startsWith('{')) throw new LoginRefused(String(JSON.parse(text).refused ?? 'She refused the sign-in.'));
    return text;
  };

  let sessionKey: string;
  try {
    ({ sessionKey } = await loginClient(username, password, (m) => socket.send(te.encode(m)), recv));
  } catch (err) {
    // A page that has learnt its own password is wrong closes at once: leaving the socket open
    // would hold one of her few sign-in slots for nothing.
    try {
      socket.close();
    } catch {
      /* already gone */
    }
    throw err instanceof LoginRefused ? err : new LoginRefused('The sign-in did not finish.');
  }
  channel = await Channel.create(sessionKey, 'page', (frame) => socket.send(frame));
  if (gone) throw new LoginRefused('The connection to her ended while signing in.');
  pump();
  return { socket, channel };
}

/* ---------- the transports the page runs on ---------- */

/** Stream 1 as the thing `WebHost` already knows how to talk to: a socket that sends and receives text. */
export function protocolSocket(channel: Channel): SocketLike {
  const before = channel.mux.get(1);
  if (before && !before.isClosed) before.close('');
  const stream = channel.mux.open(StreamKind.PROTOCOL);
  const socket = {
    readyState: 1,
    send: (data: string) => writeMessage(stream, data),
    close: () => stream.close(''),
    onopen: null as ((ev: unknown) => void) | null,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onclose: null as ((ev: unknown) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
  };
  readMessages(stream, (text) => socket.onmessage?.({ data: text }));
  stream.onClose(() => {
    socket.readyState = 3;
    socket.onclose?.({});
  });
  // The stream is open the moment it exists; `onopen` is still a turn later, as a socket's would be.
  setTimeout(() => socket.onopen?.({}), 0);
  return socket as SocketLike;
}

/**
 * Stream 2 as noVNC's "raw channel". `core/websock.js` names the eight properties it must have and
 * sets `binaryType`, `onmessage`, `onopen`, `onclose` and `onerror` on it; `readyState` is read as a
 * WebSocket's number. The bytes it hands to `send` are a view into a buffer it reuses, so they are
 * copied before they are queued — the stream sends them later, and by then the view has moved on.
 */
export function vncChannel(channel: Channel): unknown {
  const existing = channel.mux.get(2);
  if (existing && !existing.isClosed) existing.close('');
  const stream = channel.mux.open(StreamKind.VNC);
  const raw = {
    readyState: 1,
    protocol: 'binary',
    binaryType: 'arraybuffer',
    send: (data: Uint8Array) => stream.send(new Uint8Array(data)),
    close: () => stream.close(''),
    onopen: null as ((ev: unknown) => void) | null,
    onmessage: null as ((ev: { data: ArrayBuffer }) => void) | null,
    onclose: null as ((ev: unknown) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
  };
  stream.onData((data) => raw.onmessage?.({ data: data.slice().buffer as ArrayBuffer }));
  stream.onClose(() => {
    raw.readyState = 3;
    raw.onclose?.({});
  });
  return raw;
}

/** The next frame of a stream, or a throw when the stream ended first. */
function reader(stream: Stream): { next(): Promise<Uint8Array> } {
  const queue: Uint8Array[] = [];
  const waiting: { resolve: (d: Uint8Array) => void; reject: (e: Error) => void }[] = [];
  let ended: string | undefined;
  stream.onData((data) => {
    const w = waiting.shift();
    if (w) w.resolve(data);
    else queue.push(data);
  });
  stream.onClose((why) => {
    ended = why || 'the transfer ended';
    for (const w of waiting.splice(0)) w.reject(new Error(ended));
  });
  return {
    next: () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const have = queue.shift();
        if (have) return resolve(have);
        if (ended !== undefined) return reject(new Error(ended));
        waiting.push({ resolve, reject });
      }),
  };
}

/**
 * Files, one stream each: a header frame saying which way it goes, then the bytes, then one JSON
 * answer — `{ok}` or `{error}`, so a refusal reads as a sentence rather than a dropped stream. The
 * page closes the stream, because it is the end that knows it has everything.
 */
export function fileTransfer(channel: Channel): FileTransfer {
  return {
    async upload(name, file) {
      if (file.size > MAX_TRANSFER) throw new Error('that file is too large to copy into her desktop');
      const stream = channel.mux.open(StreamKind.FILE);
      const back = reader(stream);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        stream.send(te.encode(JSON.stringify({ put: { name, size: bytes.length } })));
        if (bytes.length) stream.send(bytes);
        const answer = JSON.parse(td.decode(await back.next())) as { ok?: DesktopFile; error?: string };
        if (answer.error || !answer.ok) throw new Error(answer.error ?? 'she did not say where it went');
        return answer.ok;
      } finally {
        stream.close('');
      }
    },
    async download(file) {
      const stream = channel.mux.open(StreamKind.FILE);
      const back = reader(stream);
      try {
        stream.send(te.encode(JSON.stringify({ get: { name: file.name, path: file.path, size: file.size } })));
        const answer = JSON.parse(td.decode(await back.next())) as { ok?: { size: number }; error?: string };
        if (answer.error || !answer.ok) throw new Error(answer.error ?? 'she did not send it');
        const parts: BlobPart[] = [];
        for (let have = 0; have < answer.ok.size; ) {
          const piece = await back.next();
          parts.push(piece.slice() as unknown as BlobPart);
          have += piece.length;
        }
        return new Blob(parts);
      } finally {
        stream.close('');
      }
    },
  };
}

/** Everything the ordinary page needs, over one channel instead of one port. */
export function channelEnv(live: Live, ui: ReturnType<typeof browserUi>): HostEnv {
  return {
    wsUrl: 'deskfish-channel:protocol',
    vncUrl: VNC_MARK,
    token: '',
    clientKind: 'remote',
    docsUrl: DOCS,
    files: fileTransfer(live.channel),
    // A channel that has closed cannot be reopened without a password, so the page asks for one
    // again rather than letting the host retry against something that is gone.
    openSocket: () => protocolSocket(live.channel),
    post: (pane, message) => ($(pane) as HTMLIFrameElement | null)?.contentWindow?.postMessage(message, '*'),
    fetch: () => Promise.reject(new Error('this page reaches her through a relay; there is no address to fetch')),
    ui,
  };
}

/* ---------- the page ---------- */

/** Show the sign-in card again, with the reason. The channel is gone; only a password makes another. */
function askAgain(sentence: string): void {
  const error = $('signinError');
  error.textContent = sentence;
  error.hidden = !sentence;
  $('signin').hidden = false;
  $<HTMLButtonElement>('signinGo').disabled = false;
  $<HTMLButtonElement>('signinGo').textContent = 'Open Deskfish';
  const pass = $<HTMLInputElement>('pass');
  pass.value = '';
  pass.focus();
}

export function bootRemote(): void {
  const relayInput = $<HTMLInputElement>('relay');
  const userInput = $<HTMLInputElement>('user');
  const passInput = $<HTMLInputElement>('pass');
  const button = $<HTMLButtonElement>('signinGo');
  relayInput.value = relayAddress(location.hostname, location.search, recall(RELAY_KEY));
  userInput.value = recall(USER_KEY);
  $('signin').hidden = false;
  (userInput.value ? passInput : userInput).focus();
  // Warming the WebAssembly while the person types costs nothing and takes a moment off the first sign-in.
  void warmOpaque().catch(() => {});

  let started = false;
  $<HTMLFormElement>('signinForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (button.disabled) return;
    const relay = normalizeRelay(relayInput.value);
    const username = userInput.value.trim().toLowerCase();
    const password = passInput.value;
    relayInput.value = relay;
    button.disabled = true;
    button.textContent = 'Signing in…';
    $('signinError').hidden = true;
    signIn(relay, username, password).then(
      (live) => {
        passInput.value = '';
        remember(RELAY_KEY, relay);
        remember(USER_KEY, username);
        $('signin').hidden = true;
        if (started) return void live.channel.fail('a second sign-in replaced this one');
        started = true;
        openPage(live);
      },
      (err: unknown) => {
        passInput.value = '';
        askAgain(err instanceof LoginRefused ? err.sentence : err instanceof Error ? err.message : String(err));
      },
    );
  });
}

/** Signed in: the views appear (they are kept in a template until now) and the ordinary page runs. */
function openPage(live: Live): void {
  const template = document.getElementById('page') as HTMLTemplateElement | null;
  if (template) {
    document.body.insertBefore(template.content.cloneNode(true), template);
    template.remove();
  }
  const ui = browserUi(document);
  const host = new WebHost(channelEnv(live, ui));
  const w = window as unknown as { deskfishHost: WebHost; deskfishVncChannel: () => unknown };
  w.deskfishHost = host;
  w.deskfishVncChannel = () => vncChannel(live.channel);
  wireTitleBar(host, ui);
  live.channel.onClose((reason) => {
    document.querySelectorAll('iframe').forEach((f) => f.remove());
    askAgain(`${reason} Sign in again to pick her up where you left her.`);
  });
  host.start();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bootRemote());
  else bootRemote();
}
