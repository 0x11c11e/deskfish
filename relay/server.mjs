import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { JsonUsers, USERNAME, sameSecret } from './store.mjs';

/**
 * The relay: a post box for one Deskfish, or for many.
 *
 * Her gateway at home dials *out* and holds one WebSocket here (the uplink), so her computer opens
 * no port at all. A browser dials in and names a username. From then on this program copies frames
 * between the two and **never opens one**. Everything inside a forwarded frame is sealed by the
 * page and her gateway with keys that were agreed through here and are not derivable from anything
 * that crossed it, so the machine this runs on — and whoever rents it out — carries ciphertext it
 * cannot read. That is the whole point, and it is only true while this file stays dull: the one
 * thing it ever reads out of a frame is the four-byte client number at its front.
 *
 * What it does know, and an operator can see: usernames, when a connection began and ended, the
 * address it came from, and how many bytes went by. What it stores: the users list, unspent
 * enrolment codes, and daily byte and second counts (`store.mjs`). Never a frame, never a message,
 * never a screenshot.
 *
 * ```
 * GET    /status                 { name, version } and nothing else
 * POST   /admin/codes            (admin key) mint a one-time enrolment code
 * DELETE /admin/users/:name      (admin key) revoke a username
 * GET    /admin/usage/:name      (admin key) daily seconds and bytes
 * POST   /enroll                 { code, username, publicKey } — no admin key; the code is spent
 * WS     /uplink                 her gateway, after answering a challenge with its Ed25519 key
 * WS     /client?user=<name>     a browser; { "offline": true } and a close when she is not here
 * ```
 *
 * Configured only by the environment: RELAY_PORT (8080), RELAY_DATA (/data), RELAY_ADMIN_KEY
 * (required — it refuses to start without one), RELAY_LOG (quiet | events), RELAY_MAX_CLIENTS_PER_USER
 * (8), RELAY_RATE (connections per address per minute, 30), RELAY_PING_SECONDS (30),
 * RELAY_USAGE_FLUSH_SECONDS (300).
 *
 * Node 22, one dependency (`ws`). Nothing here imports anything of Deskfish's: this folder is its
 * own package and its own container, and the product could be rewritten around it.
 */

export const VERSION = '0.2.0';

/** The most one WebSocket message may be. Backpressure belongs to the channel; this only refuses to be a buffer. */
const MAX_PAYLOAD = 1024 * 1024;
/** A client that has this much unsent is dropped rather than buffered. */
const MAX_BACKLOG = 4 * 1024 * 1024;
/** What the gateway signs, between the challenge and its name, so a signature cannot be reused elsewhere. */
const UPLINK_CONTEXT = 'deskfish-uplink';
/** The client number that means "this message is for the relay itself", never a browser. */
const CONTROL = 0;
/**
 * How often every socket is pinged, and therefore how long a dead one is held: a socket that has
 * not answered the previous ping is closed at the next sweep. Nothing else notices a laptop that
 * slept, a NAT that forgot an idle flow or a proxy that cut a quiet socket — TCP can take an hour,
 * and until it does the relay hands browsers to an uplink nobody is listening to.
 */
const PING_INTERVAL_MS = 30_000;
/** How often a running session's seconds and bytes are added to the store; see `flushUsage`. */
const USAGE_FLUSH_MS = 300_000;

const nowSeconds = () => Date.now() / 1000;

/** An interval given in seconds by the environment, in milliseconds; anything unusable is the default. */
function everyMs(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : fallback;
}

/* ---------- little helpers ---------- */

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** An Ed25519 public key as the gateway sends it: base64url of the 32 raw bytes. */
function publicKeyFrom(raw) {
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  // The SPKI prefix for Ed25519; Node has no "raw public key" import.
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

/**
 * The address a connection came from, as far as a reverse proxy tells us. Counted for the rate
 * limit, never stored. `x-forwarded-for` is trusted because this program is meant to sit behind a
 * proxy you run — and it is the *last* address in that header that is read, because that is the
 * one your proxy appended; the first is whatever the client itself put there (nginx's
 * `$proxy_add_x_forwarded_for` appends, it does not replace), so keying on it would let a client
 * pick its own bucket. Exposed directly to the internet a client could set the whole header and
 * slip the limit, which is one more reason the README puts TLS in front rather than in here.
 */
function addressOf(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',').pop().trim();
  return req.socket.remoteAddress ?? '?';
}

/** Connections per address per minute. A plain sliding window; no address is kept past its minute. */
class RateLimit {
  #per;
  #seen = new Map();
  constructor(perMinute) {
    this.#per = perMinute;
  }
  allow(address) {
    const now = Date.now();
    const recent = (this.#seen.get(address) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.#per) {
      this.#seen.set(address, recent);
      return false;
    }
    recent.push(now);
    this.#seen.set(address, recent);
    if (this.#seen.size > 10_000) for (const [k, v] of this.#seen) if (!v.some((t) => now - t < 60_000)) this.#seen.delete(k);
    return true;
  }
}

/* ---------- one gateway's uplink and the browsers on it ---------- */

class Uplink {
  /** @type {Map<number, import('ws').WebSocket>} */
  clients = new Map();
  nextId = 1;
  bytesUp = 0;
  bytesDown = 0;
  startedAt = nowSeconds();
  /** What of the above has already been written to the store, so a flush adds only what is new. */
  countedSeconds = 0;
  countedUp = 0;
  countedDown = 0;

  constructor(username, ws) {
    this.username = username;
    this.ws = ws;
  }

  /** `[clientId u32][bytes]` — the whole of what this program does with a frame. */
  toGateway(clientId, bytes) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    const frame = Buffer.allocUnsafe(4 + bytes.length);
    frame.writeUInt32BE(clientId, 0);
    frame.set(bytes, 4);
    this.bytesUp += bytes.length;
    this.ws.send(frame, { binary: true });
  }

  control(message) {
    this.toGateway(CONTROL, Buffer.from(JSON.stringify(message)));
  }
}

/**
 * Starts the relay. `options` exists for the tests, which run it in this process: `port: 0` for a
 * free one, `onFrame` to record what crossed — the only way to prove, from the outside, that a
 * whole session is ciphertext — and `pingIntervalMs` / `usageFlushMs` to make the two intervals
 * short enough for a suite. Nothing sets `onFrame` in the container: `main()` does not pass it.
 */
export function startRelay(options = {}) {
  const env = options.env ?? process.env;
  const adminKey = options.adminKey ?? env.RELAY_ADMIN_KEY ?? '';
  if (!adminKey) throw new Error('RELAY_ADMIN_KEY is not set: the relay will not start without one');
  const dataDir = options.dataDir ?? env.RELAY_DATA ?? '/data';
  const port = options.port ?? Number(env.RELAY_PORT ?? 8080);
  const host = options.host ?? env.RELAY_HOST ?? '0.0.0.0';
  const logLevel = options.log ?? env.RELAY_LOG ?? 'quiet';
  const maxClients = Number(options.maxClientsPerUser ?? env.RELAY_MAX_CLIENTS_PER_USER ?? 8);
  const rate = new RateLimit(Number(options.rate ?? env.RELAY_RATE ?? 30));
  const users = options.users ?? new JsonUsers(join(dataDir, 'users.json'));
  users.checkWritable?.();
  const onFrame = options.onFrame;
  // Both intervals are options so the tests can lower them to milliseconds; 0 means never.
  const pingIntervalMs = options.pingIntervalMs ?? everyMs(env.RELAY_PING_SECONDS, PING_INTERVAL_MS);
  const usageFlushMs = options.usageFlushMs ?? everyMs(env.RELAY_USAGE_FLUSH_SECONDS, USAGE_FLUSH_MS);

  const say = (line) => {
    if (logLevel === 'events') console.log(`${new Date().toISOString()} ${line}`);
  };
  const complain = (line) => console.error(`${new Date().toISOString()} ${line}`);

  /** username → the one uplink that holds it. */
  const uplinks = new Map();

  /**
   * Every socket this relay holds, browsers and uplinks alike. One interval walks the lot: a socket
   * that has not answered since the last sweep is terminated, which runs its ordinary close handling
   * (an uplink's browsers are told, a browser's `{close}` goes up). A socket that said anything at
   * all counts as alive, so a busy session is never pinged out of existence.
   */
  const sockets = new Set();
  const watch = (ws) => {
    ws.deskfishAlive = true;
    sockets.add(ws);
    const alive = () => {
      ws.deskfishAlive = true;
    };
    ws.on('pong', alive);
    ws.on('message', alive);
    ws.on('close', () => sockets.delete(ws));
  };

  const http = createServer((req, res) => {
    void handle(req, res).catch((err) => json(res, 500, { error: String(err?.message ?? err) }));
  });

  const authorized = (req) => {
    const header = req.headers.authorization ?? '';
    return header.startsWith('Bearer ') && sameSecret(header.slice(7).trim(), adminKey);
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://relay');
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, { name: 'deskfish-relay', version: VERSION });

    if (url.pathname === '/enroll' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'));
      } catch {
        return json(res, 400, { error: 'that is not JSON' });
      }
      try {
        const user = users.claim(String(body.username ?? ''), String(body.publicKey ?? ''), String(body.code ?? ''));
        say(`enrolled ${user.username}`);
        return json(res, 200, { username: user.username, enrolledAt: user.enrolledAt });
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) });
      }
    }

    if (url.pathname.startsWith('/admin/')) {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/admin/codes' && req.method === 'POST') {
        let body = {};
        try {
          const raw = (await readBody(req)).toString('utf8');
          if (raw.trim()) body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'that is not JSON' });
        }
        try {
          const username = body.username === undefined || body.username === null ? undefined : String(body.username);
          const code = users.mintCode(username);
          say(`minted an enrolment code${username ? ` for ${username}` : ''}`);
          return json(res, 200, { code, username: username ?? null });
        } catch (err) {
          return json(res, 400, { error: String(err?.message ?? err) });
        }
      }
      const one = /^\/admin\/(users|usage)\/([^/]+)$/.exec(url.pathname);
      if (one) {
        const name = decodeURIComponent(one[2]);
        if (!USERNAME.test(name)) return json(res, 400, { error: 'that is not a username' });
        if (one[1] === 'users' && req.method === 'DELETE') {
          const gone = users.revoke(name);
          const live = uplinks.get(name);
          if (live) dropUplink(live, 'revoked');
          say(`revoked ${name}`);
          return json(res, 200, { revoked: gone });
        }
        if (one[1] === 'usage' && req.method === 'GET') return json(res, 200, users.usage(name));
      }
      return json(res, 404, { error: 'not found' });
    }
    return json(res, 404, { error: 'not found' });
  }

  const uplinkServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const clientServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url ?? '/', 'http://relay');
    const address = addressOf(req);
    if (!rate.allow(address)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (url.pathname === '/uplink') return uplinkServer.handleUpgrade(req, socket, head, (ws) => acceptUplink(ws, address));
    if (url.pathname === '/client') return clientServer.handleUpgrade(req, socket, head, (ws) => acceptClient(ws, url.searchParams.get('user') ?? '', address));
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  /* ---------- the gateway's side ---------- */

  function acceptUplink(ws, address) {
    watch(ws);
    const challenge = randomBytes(32);
    let uplink;
    let settled = false;
    const refuse = (why) => {
      say(`uplink refused from ${address}: ${why}`);
      try {
        ws.close(1008, why);
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      if (!settled) refuse('no answer to the challenge');
    }, 10_000);

    ws.send(JSON.stringify({ challenge: challenge.toString('base64url'), context: UPLINK_CONTEXT, version: VERSION }));

    ws.on('message', (data, isBinary) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (isBinary) return refuse('the answer to the challenge must be text');
        let answer;
        try {
          answer = JSON.parse(data.toString('utf8'));
        } catch {
          return refuse('the answer to the challenge is not JSON');
        }
        const username = String(answer.username ?? '');
        if (!USERNAME.test(username)) return refuse('that is not a username');
        const user = users.get(username);
        if (!user) return refuse('that username is not enrolled here');
        let ok = false;
        try {
          const signed = Buffer.concat([challenge, Buffer.from(UPLINK_CONTEXT), Buffer.from(username)]);
          ok = verify(null, signed, publicKeyFrom(user.publicKey), Buffer.from(String(answer.signature ?? ''), 'base64url'));
        } catch {
          ok = false;
        }
        if (!ok) return refuse('that signature is not the key we have for this username');

        const previous = uplinks.get(username);
        if (previous) {
          say(`${username}: a second uplink replaces the first`);
          dropUplink(previous, 'replaced');
        }
        uplink = new Uplink(username, ws);
        uplinks.set(username, uplink);
        ws.send(JSON.stringify({ ok: true, version: VERSION }));
        say(`${username}: uplink up from ${address}`);
        return;
      }
      if (!uplink) return;
      if (!isBinary) {
        refuse('only the challenge is text; everything after it is binary');
        return;
      }
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (frame.length < 4) return;
      const clientId = frame.readUInt32BE(0);
      const bytes = frame.subarray(4);
      uplink.bytesDown += bytes.length;
      onFrame?.({ from: 'gateway', user: uplink.username, clientId, bytes: Buffer.from(bytes) });
      if (clientId === CONTROL) return gatewaySaid(uplink, bytes);
      const client = uplink.clients.get(clientId);
      if (!client || client.readyState !== client.OPEN) return;
      if (client.bufferedAmount > MAX_BACKLOG) {
        say(`${uplink.username}: client ${clientId} could not keep up`);
        client.close(1013, 'too slow');
        return;
      }
      client.send(bytes, { binary: true });
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (!uplink || uplinks.get(uplink.username) !== uplink) return;
      uplinks.delete(uplink.username);
      endSession(uplink, 'the uplink went');
    });
    ws.on('error', () => ws.terminate());
  }

  /** The one thing the gateway may say to the relay rather than through it. */
  function gatewaySaid(uplink, bytes) {
    let message;
    try {
      message = JSON.parse(bytes.toString('utf8'));
    } catch {
      return;
    }
    if (typeof message.close === 'number') {
      const client = uplink.clients.get(message.close);
      uplink.clients.delete(message.close);
      try {
        client?.close(1000, 'closed by the gateway');
      } catch {
        /* already gone */
      }
    }
  }

  function dropUplink(uplink, why) {
    uplinks.delete(uplink.username);
    endSession(uplink, why);
    try {
      uplink.ws.close(1012, why);
    } catch {
      /* already gone */
    }
  }

  /**
   * Add to the store what this uplink has accrued since the last time — on a timer while it runs and
   * once more when it ends, so the two together count everything exactly once. Written while a
   * session runs because an uplink that stays up for a week would otherwise be invisible to
   * `GET /admin/usage/:name` for the whole week, which is no use to anyone billing or capping by it.
   * The seconds are kept as whole numbers *already counted*, so the daily total is the rounded
   * length of the session however often it was flushed.
   */
  function flushUsage(uplink) {
    const seconds = Math.round(nowSeconds() - uplink.startedAt) - uplink.countedSeconds;
    const up = uplink.bytesUp - uplink.countedUp;
    const down = uplink.bytesDown - uplink.countedDown;
    if (!seconds && !up && !down) return;
    uplink.countedSeconds += seconds;
    uplink.countedUp += up;
    uplink.countedDown += down;
    try {
      users.addUsage(uplink.username, seconds, up, down);
    } catch (err) {
      complain(`could not write usage for ${uplink.username}: ${String(err?.message ?? err)}`);
    }
  }

  /** The clients of an uplink that ended, and the last of the counts an operator bills by. */
  function endSession(uplink, why) {
    for (const client of uplink.clients.values()) {
      try {
        client.close(1012, why);
      } catch {
        /* already gone */
      }
    }
    uplink.clients.clear();
    flushUsage(uplink);
    say(`${uplink.username}: uplink down (${why}), ${Math.round(nowSeconds() - uplink.startedAt)}s, ${uplink.bytesUp}↑ ${uplink.bytesDown}↓`);
  }

  /* ---------- the browser's side ---------- */

  function acceptClient(ws, username, address) {
    watch(ws);
    // A name that is not one, a name nobody enrolled and a name whose gateway is asleep all get the
    // same answer on purpose: a browser cannot learn from here which usernames exist on this relay.
    if (!USERNAME.test(username)) {
      ws.send(JSON.stringify({ offline: true }));
      ws.close(1008, 'she is not connected');
      return;
    }
    const uplink = uplinks.get(username);
    if (!uplink) {
      say(`${username}: a browser called from ${address} and she is not here`);
      ws.send(JSON.stringify({ offline: true }));
      ws.close(1000, 'she is not connected');
      return;
    }
    if (uplink.clients.size >= maxClients) {
      ws.send(JSON.stringify({ busy: true }));
      ws.close(1013, 'too many windows on this one');
      return;
    }
    const clientId = uplink.nextId++;
    uplink.clients.set(clientId, ws);
    uplink.control({ open: clientId });
    say(`${username}: browser ${clientId} from ${address}`);

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        ws.close(1003, 'this connection carries binary frames only');
        return;
      }
      if (uplink.ws.readyState !== uplink.ws.OPEN) return;
      if (uplink.ws.bufferedAmount > MAX_BACKLOG) {
        ws.close(1013, 'the gateway could not keep up');
        return;
      }
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      onFrame?.({ from: 'client', user: username, clientId, bytes: Buffer.from(bytes) });
      uplink.toGateway(clientId, bytes);
    });
    ws.on('close', () => {
      if (uplink.clients.get(clientId) !== ws) return;
      uplink.clients.delete(clientId);
      uplink.control({ close: clientId });
      say(`${username}: browser ${clientId} gone`);
    });
    ws.on('error', () => ws.terminate());
  }

  /* ---------- lifecycle ---------- */

  const pingTimer = pingIntervalMs > 0 ? setInterval(() => {
    for (const ws of sockets) {
      if (!ws.deskfishAlive) {
        ws.terminate();
        continue;
      }
      ws.deskfishAlive = false;
      try {
        ws.ping();
      } catch {
        /* it is going anyway */
      }
    }
  }, pingIntervalMs) : undefined;
  const usageTimer = usageFlushMs > 0 ? setInterval(() => {
    for (const uplink of uplinks.values()) flushUsage(uplink);
  }, usageFlushMs) : undefined;
  // Neither keeps a process alive: a relay is kept running by its sockets, and a test by its work.
  pingTimer?.unref?.();
  usageTimer?.unref?.();

  const listening = new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      http.off('error', reject);
      resolve(http.address().port);
    });
  });

  return {
    get port() {
      return http.address()?.port;
    },
    listening,
    users,
    /** How many uplinks are held right now — for the tests and for an operator's own curiosity. */
    get connected() {
      return [...uplinks.keys()];
    },
    async close() {
      if (pingTimer) clearInterval(pingTimer);
      if (usageTimer) clearInterval(usageTimer);
      for (const uplink of [...uplinks.values()]) dropUplink(uplink, 'the relay is stopping');
      uplinkServer.close();
      clientServer.close();
      await new Promise((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections?.();
      });
    },
  };
}

/** The container's entry point: the environment, a listen, and two signals. Never `onFrame`. */
async function main() {
  let relay;
  try {
    relay = startRelay();
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
  const port = await relay.listening;
  console.log(`deskfish-relay ${VERSION} listening on ${port}`);
  const stop = () => void relay.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) void main();
