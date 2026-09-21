import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import * as tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { formatSize } from '../desktop/files';
import { vncUrlWithToken } from './config';
import { DEFAULT_PORT, EVENT_NAMES, MAX_FRAME, validate, type CommandName, type EventName, type Request } from './protocol';
import { MAX_TRANSFER, type DeskfishService, type MemoryBundle } from './service';
import { handleOf } from '../remote/channel';
import { RemoteUplink, enrollAtRelay, newUplinkKey, relayUrls, type ClientLink, type RemoteStatus } from './uplink';
import { VERSION } from './version';
import { WebClient, type WebResponse } from './web';

/**
 * The gateway's network face: one port, one token. `GET /status` answers without the token and says
 * only that a Deskfish gateway is here; everything else needs it (`Authorization: Bearer <token>`, or
 * `?token=` where a browser cannot set headers): `/ws` (the protocol), `/vnc` (a byte pipe to the
 * tank's websockify, so a client needs no second port), `/files` (upload into the tank's Uploads,
 * download a file from the tank), `/` (the web page: `web.ts`), `/docs` (the documentation). Without the
 * token `/` answers 401 with a sign-in page that sends the token this browser kept (a form POST, so the
 * token is in no URL). Binds loopback unless `allowRemote`.
 * No `vscode` import.
 */

export interface GatewayServerOptions {
  service: DeskfishService;
  token: string;
  host?: string;
  port?: number;
  /** Bind a non-loopback address (the docs say: use an SSH tunnel or Tailscale instead). */
  allowRemote?: boolean;
  log?: (line: string) => void;
  /** The recent log lines, for `log.tail`. */
  logTail?: (lines: number) => string[];
  /** Called after `shutdown` was answered. */
  onShutdown?: () => void;
  /**
   * Opens a visible terminal on this computer running `command` (the app gives one: a person sits at
   * this screen). Without it `desktop.install` answers false and the page copies the command instead.
   */
  openTerminal?: (command: string) => void | Promise<void>;
  /** The Deskfish folder holding `web/`, `media/`, `dist/webview/`, `dist/web/` and `docs/site/`; without it `/` is a placeholder. */
  webRoot?: string;
}

/**
 * One client, as the protocol sees it: something that frames text both ways. A WebSocket is one
 * (`onConnection`); so is a browser at the far end of the relay, whose frames arrive sealed inside
 * the uplink's channel (`uplink.ts`). Nothing below this line knows which it is talking to.
 */
interface Conn {
  send(text: string): void;
  /** Cut it off without ceremony (the gateway is closing). */
  end(): void;
  open(): boolean;
  hello: boolean;
  client?: string;
  poll: boolean;
}

/** A username on a relay: lowercase, starts with a letter or digit, 3 to 32 characters (the relay's own rule). */
const RELAY_USERNAME = /^[a-z0-9][a-z0-9-]{2,31}$/;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Constant-time token comparison. */
function tokenMatches(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

export class GatewayServer {
  private readonly http: http.Server;
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private readonly service: DeskfishService;
  private readonly log: (line: string) => void;
  private readonly off: (() => void)[] = [];
  private pollers = 0;
  private readonly web?: WebClient;
  /** Open `/vnc` pipes: detached from the HTTP server once upgraded, so `close()` ends them itself. */
  private readonly pipes = new Set<() => void>();
  /** The one outbound connection to a relay, when `remote.*` is set up. Never an inbound anything. */
  private uplink?: RemoteUplink;
  /** The relay and username the live uplink was made for, so a settings change is noticed. */
  private uplinkFor?: string;
  /** Her name and the handle derived from it, so `remote.status` does not hash at every call. */
  private handleOfName?: { username: string; handle: string };

  constructor(private readonly opts: GatewayServerOptions) {
    this.service = opts.service;
    this.log = opts.log ?? (() => {});
    if (opts.webRoot) this.web = new WebClient(opts.webRoot);
    this.http = http.createServer((req, res) => void this.onRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    this.wss.on('connection', (ws) => this.onConnection(ws));

    const relay = (name: EventName, source: NodeJS.EventEmitter, from: string = name) => {
      const fn = (data: unknown) => this.broadcast(name, data);
      source.on(from, fn);
      this.off.push(() => source.off(from, fn));
    };
    for (const name of EVENT_NAMES) if (name !== 'log' && !name.startsWith('desktop.')) relay(name, this.service);
    relay('desktop.hostNetwork', this.service.desktop, 'hostNetwork');
    relay('desktop.startFailed', this.service.desktop, 'startFailed');
    relay('desktop.stopFailed', this.service.desktop, 'stopFailed');

    // A relay address typed in the settings view is a change like any other: the uplink follows it.
    const onConfig = () => this.syncUplink();
    this.service.on('config', onConfig);
    this.off.push(() => this.service.off('config', onConfig));
  }

  /** Listen; resolves with the port (useful with port 0). */
  listen(): Promise<number> {
    const host = this.opts.host ?? '127.0.0.1';
    if (!LOOPBACK.has(host) && !this.opts.allowRemote) {
      return Promise.reject(new Error(`refusing to listen on ${host}: the gateway binds loopback only unless --allow-remote is given (prefer an SSH tunnel or Tailscale)`));
    }
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.opts.port ?? DEFAULT_PORT, host, () => {
        this.http.off('error', reject);
        this.syncUplink();
        resolve((this.http.address() as net.AddressInfo).port);
      });
    });
  }

  /** A log line to every client (the VS Code output channel mirrors them). */
  logLine(line: string): void {
    this.broadcast('log', line);
  }

  close(): Promise<void> {
    this.off.forEach((f) => f());
    this.uplink?.stop('the gateway is stopping');
    this.uplink = undefined;
    for (const c of this.conns) c.end();
    this.conns.clear();
    // A live view still open would otherwise keep the server's close waiting forever (the gateway never exits).
    for (const end of [...this.pipes]) end();
    if (this.pollers) this.service.desktop.stopPolling();
    this.wss.close();
    return new Promise((resolve) => {
      this.http.close(() => resolve());
      this.http.closeAllConnections?.();
    });
  }

  /** The install command of the runtime this computer lacks, in a terminal of its own; never a command a client sent. */
  private async installRuntime(): Promise<boolean> {
    if (!this.opts.openTerminal) return false;
    const rt = await this.service.desktop.detectRuntime();
    if (rt.cli !== 'none' || !rt.install.command) return false;
    this.log(`— opening a terminal with the install command: ${rt.install.command} —`);
    await this.opts.openTerminal(rt.install.command);
    return true;
  }

  /* ---------- reaching her from anywhere (13-relay-plan.md) ---------- */

  /**
   * Start, stop or replace the uplink so it matches the settings and the keys on disk. Called at
   * every `config` event and whenever the `remote.*` commands change something; doing nothing when
   * nothing changed is the common case.
   */
  private syncUplink(restart = false): void {
    const cfg = this.service.config;
    const kept = this.service.secrets.remote;
    const ready = !!(cfg.remoteRelay && cfg.remoteUsername && kept.key && kept.record && kept.serverSetup && kept.username === cfg.remoteUsername);
    const wanted = ready ? `${cfg.remoteRelay}|${cfg.remoteUsername}` : undefined;
    if (this.uplink && (!wanted || restart || wanted !== this.uplinkFor)) {
      this.uplink.stop(restart ? 'the settings changed' : 'remote access was turned off');
      this.uplink = undefined;
      this.uplinkFor = undefined;
      if (!wanted) this.log('— remote access is off —');
    }
    if (!wanted || this.uplink) {
      // A relay with no password yet is a half-finished setup, and saying so beats silence.
      if (!ready && cfg.remoteRelay && !this.uplink) this.log(`— remote access is not ready: ${cfg.remoteUsername ? (kept.key ? 'no password is set yet' : 'this gateway is not enrolled at the relay') : 'no username is set'} —`);
      return;
    }
    this.uplink = new RemoteUplink({
      relay: cfg.remoteRelay,
      username: cfg.remoteUsername,
      privateKey: kept.key!,
      record: { username: cfg.remoteUsername, serverSetup: kept.serverSetup!, record: kept.record! },
      host: {
        attach: (_kind, send) => this.attach(send),
        config: () => this.service.config,
        uploadFile: (name, data) => this.service.uploadFile(name, data),
        readFile: (file) => this.service.readFile(file),
        log: (line) => this.log(line),
      },
    });
    this.uplinkFor = wanted;
    this.uplink.start();
  }

  /**
   * What the settings view and `deskfish remote status` show. Never a key, never the password — and
   * the handle beside her name, because that is what an operator must be told to mint a code for
   * (the relay is never given the name itself).
   */
  private async remoteStatus(): Promise<RemoteStatus> {
    const cfg = this.service.config;
    const kept = this.service.secrets.remote;
    const live = this.uplink?.status;
    return {
      relay: cfg.remoteRelay,
      username: cfg.remoteUsername,
      handle: await this.relayHandle(cfg.remoteUsername),
      enrolled: !!(kept.key && kept.username),
      hasPassword: !!(kept.record && kept.serverSetup),
      state: live?.state ?? 'off',
      clients: live?.clients ?? 0,
      lastError: live?.lastError,
      since: live?.since ?? 0,
    };
  }

  /** The handle for a name, kept because every status asks for it and the answer never changes. */
  private async relayHandle(username: string): Promise<string> {
    if (!username) return '';
    if (this.handleOfName?.username !== username) this.handleOfName = { username, handle: await handleOf(username) };
    return this.handleOfName.handle;
  }

  /** Spend a one-time enrolment code at a relay. The key is made here and its private half stays here. */
  private async remoteEnroll(a: { relay: string; username: string; code: string }): Promise<RemoteStatus> {
    const relay = a.relay.trim();
    const username = a.username.trim().toLowerCase();
    if (!RELAY_USERNAME.test(username)) throw new Error('a username is 3 to 32 characters: lowercase letters, digits and dashes, starting with a letter or a digit');
    if (!a.code.trim()) throw new Error('an enrolment code is needed: the person who runs the relay mints one');
    relayUrls(relay); // throws the sentence when it is not an address
    const kept = this.service.secrets.remote;
    // The same name keeps its key, so enrolling twice at a new relay does not strand the old one.
    const key = kept.key && kept.publicKey && kept.username === username ? { privateKey: kept.key, publicKey: kept.publicKey } : newUplinkKey();
    await enrollAtRelay(relay, username, a.code.trim(), key.publicKey);
    this.service.secrets.setRemote({ key: key.privateKey, publicKey: key.publicKey, username });
    this.service.patchConfig({ remoteRelay: relay, remoteUsername: username });
    this.log(`— enrolled at ${relay} as ${username} —`);
    this.syncUplink(true);
    return this.remoteStatus();
  }

  /**
   * Keep the record a password was turned into. The password itself never reaches this process:
   * whoever typed it ran both OPAQUE roles where it was typed and sent only what cannot be read
   * backwards (requirement 5).
   */
  private remotePassword(a: { serverSetup: string; record: string }): Promise<RemoteStatus> {
    const username = this.service.config.remoteUsername || this.service.secrets.remote.username;
    if (!username) throw new Error('enrol at a relay first: a password is kept against the name she answers to');
    if (!a.serverSetup || !a.record) throw new Error('that is not a password record');
    this.service.secrets.setRemote({ serverSetup: a.serverSetup, record: a.record, username });
    this.log('— the remote access password was set —');
    this.syncUplink(true);
    return this.remoteStatus();
  }

  /** Stop dialling out. `forget` also drops the keys; the relay keeps the public one until it is revoked there. */
  private remoteOff(forget: boolean): Promise<RemoteStatus> {
    this.service.patchConfig({ remoteRelay: '', remoteUsername: '' });
    if (forget) this.service.secrets.clearRemote();
    this.syncUplink();
    return this.remoteStatus();
  }

  /* ---------- auth ---------- */

  private authorized(req: http.IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    return tokenMatches(bearer ?? url.searchParams.get('token') ?? undefined, this.opts.token);
  }

  private static url(req: http.IncomingMessage): URL {
    return new URL(req.url ?? '/', 'http://gateway');
  }

  /* ---------- HTTP ---------- */

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = GatewayServer.url(req);
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'GET' && url.pathname === '/status') {
      json(res, 200, { name: 'deskfish', version: VERSION });
      return;
    }
    if (url.pathname === '/' && this.web?.available() && (req.method === 'GET' || req.method === 'POST')) {
      await this.servePage(req, res, url).catch((err) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    if (!this.authorized(req, url)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    try {
      if (url.pathname === '/files' && req.method === 'POST') {
        const name = url.searchParams.get('name');
        if (!name) return json(res, 400, { error: 'name is required' });
        const data = Number(req.headers['content-length'] ?? 0) > MAX_TRANSFER ? undefined : await readBody(req, MAX_TRANSFER);
        if (!data) {
          // Answer, then drop the connection rather than read the rest of a body that is too large.
          res.setHeader('connection', 'close');
          res.on('finish', () => req.destroy());
          return json(res, 413, { error: `larger than ${formatSize(MAX_TRANSFER)}` });
        }
        json(res, 200, await this.service.uploadFile(name, data));
        return;
      }
      if (url.pathname.startsWith('/files/') && req.method === 'GET') {
        const file = path.posix.normalize(decodeURIComponent(url.pathname.slice('/files'.length)));
        if (!file.startsWith('/') || file.includes('\0')) return json(res, 400, { error: 'bad path' });
        const data = await this.service.readFile({ name: path.posix.basename(file), path: file, size: 0 });
        if (data.length > MAX_TRANSFER) return json(res, 413, { error: `larger than ${formatSize(MAX_TRANSFER)}` });
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': data.length,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(file))}`,
        });
        res.end(data);
        return;
      }
      if (url.pathname === '/docs' && req.method === 'GET') {
        const docs = this.web?.docs();
        if (!docs) return json(res, 404, { error: 'not found' });
        return html(res, 200, docs);
      }
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Deskfish</title><p>The Deskfish gateway is running. The web page arrives in a later version.</p>');
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * `/`: the page with the token (`?token=` in the link `deskfish` gives, `Authorization`, or a form
   * POST from the sign-in page), else 401 with the sign-in page.
   */
  private async servePage(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const web = this.web!;
    if (req.method === 'GET') {
      if (this.authorized(req, url)) return html(res, 200, web.page(req.headers.host));
      return html(res, 401, web.signIn(url.searchParams.has('token') ? 'link' : ''));
    }
    const form = /^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '') ? await readBody(req, 4096) : undefined;
    const given = form ? new URLSearchParams(form.toString('utf8')).get('token') ?? undefined : undefined;
    if (tokenMatches(given, this.opts.token)) return html(res, 200, web.page(req.headers.host));
    if (!form) res.setHeader('connection', 'close');
    return html(res, 401, web.signIn('post'));
  }

  /* ---------- upgrades: /ws and /vnc ---------- */

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = GatewayServer.url(req);
    socket.on('error', () => socket.destroy());
    if (url.pathname !== '/ws' && url.pathname !== '/vnc') {
      refuse(socket, 404, 'Not Found');
      return;
    }
    if (!this.authorized(req, url)) {
      refuse(socket, 401, 'Unauthorized');
      return;
    }
    if (url.pathname === '/ws') this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    else this.proxyVnc(req, socket, head);
  }

  /**
   * A byte pipe to the tank's websockify: the upgrade request is replayed to the address in
   * `vncUrl` (with the daemon token when one is set, never the gateway's), and from then on bytes
   * flow both ways untouched, the 101 answer and every frame included.
   */
  private proxyVnc(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    let target: URL;
    try {
      target = new URL(vncUrlWithToken(this.service.config));
    } catch {
      refuse(socket, 502, 'Bad Gateway');
      return;
    }
    const secure = target.protocol === 'wss:' || target.protocol === 'https:';
    const port = Number(target.port) || (secure ? 443 : 80);
    const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
    const upstream: net.Socket = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
    const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      if (/^(host|authorization|cookie)$/i.test(name)) continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.once(secure ? 'secureConnect' : 'connect', () => {
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const end = () => {
      this.pipes.delete(end);
      upstream.destroy();
      socket.destroy();
    };
    this.pipes.add(end);
    upstream.on('error', (err) => {
      this.log(`vnc proxy: ${err.message}`);
      if (!upstream.readableFlowing) refuse(socket, 502, 'Bad Gateway');
      end();
    });
    upstream.on('close', end);
    socket.on('close', end);
  }

  /* ---------- the protocol ---------- */

  private onConnection(ws: WebSocket): void {
    const link = this.attach(
      (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text);
      },
      () => ws.readyState === ws.OPEN,
      () => ws.terminate(),
    );
    ws.on('message', (raw, isBinary) => (isBinary ? link.refuse('binary frames are not part of the protocol') : link.message(raw.toString())));
    ws.on('close', () => link.close());
    ws.on('error', () => ws.terminate());
  }

  /**
   * Attach a client that is not a WebSocket — today the browsers the relay hands to the uplink, one
   * per sealed channel. It gets exactly what a socket gets: the same validation, the same snapshot,
   * the same events, and the same refusals.
   */
  attach(send: (text: string) => void, open: () => boolean = () => true, end: () => void = () => {}): ClientLink {
    const conn: Conn = { send, open, end, hello: false, poll: false };
    this.conns.add(conn);
    return {
      message: (text) => {
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return this.reply(conn, null, false, 'not JSON');
        }
        const v = validate(msg);
        if (!v.ok) return this.reply(conn, v.id, false, v.error);
        this.handle(conn, v.req);
      },
      refuse: (why) => this.reply(conn, null, false, why),
      close: () => {
        this.conns.delete(conn);
        this.setPoll(conn, false);
      },
    };
  }

  private reply(conn: Conn, id: number | null, ok: boolean, payload: unknown): void {
    if (!conn.open()) return;
    conn.send(JSON.stringify(ok ? { id, ok: true, result: payload ?? null } : { id, ok: false, error: String(payload) }));
  }

  private broadcast(event: EventName, data: unknown): void {
    if (!this.conns.size) return;
    const frame = JSON.stringify({ event, data });
    for (const c of this.conns) if (c.hello && c.open()) c.send(frame);
  }

  private setPoll(conn: Conn, on: boolean): void {
    if (conn.poll === on) return;
    conn.poll = on;
    this.pollers += on ? 1 : -1;
    if (on && this.pollers === 1) this.service.desktop.startPolling();
    if (!on && this.pollers === 0) this.service.desktop.stopPolling();
  }

  private handle(conn: Conn, req: Request): void {
    if (req.cmd === 'hello' || req.cmd === 'snapshot') {
      if (req.cmd === 'hello') {
        const a = req.args as { client: string; version: string };
        conn.client = a.client;
        this.log(`— ${a.client} client connected (${a.version}) —`);
      } else if (!conn.hello) {
        return this.reply(conn, req.id, false, 'say hello first');
      }
      // Synchronously: the snapshot, then (from the next event on) the events after it.
      this.reply(conn, req.id, true, this.service.snapshot());
      conn.hello = true;
      return;
    }
    if (!conn.hello) return this.reply(conn, req.id, false, 'say hello first');
    let result: unknown;
    try {
      result = this.dispatch(conn, req.cmd, (req.args ?? {}) as Record<string, any>);
    } catch (err) {
      return this.reply(conn, req.id, false, err instanceof Error ? err.message : String(err));
    }
    if (result instanceof Promise) {
      result.then(
        (r) => this.reply(conn, req.id, true, r),
        (err) => this.reply(conn, req.id, false, err instanceof Error ? err.message : String(err)),
      );
    } else {
      this.reply(conn, req.id, true, result);
    }
    if (req.cmd === 'shutdown') setTimeout(() => this.opts.onShutdown?.(), 50);
  }

  private dispatch(conn: Conn, cmd: CommandName, a: Record<string, any>): unknown {
    const s = this.service;
    switch (cmd) {
      case 'run':
        return s.run(a.task, a.attachments, { unattended: a.unattended, maxCostUsd: a.maxCostUsd, reason: a.reason }).then(() => null);
      case 'say':
        return s.say(a.text, a.attachments), null;
      case 'pause':
        return s.pause(), null;
      case 'resume':
        return s.resume(), null;
      case 'fill':
        // The one command whose arguments are never logged, here or anywhere below it: the values
        // live in this call, in the loop's hands for the seconds of the typing, and nowhere else.
        return s.fill(a.values), null;
      case 'stop':
        return s.stop(), null;
      case 'newChat':
        return s.newConversation(), null;
      case 'reflect':
        return s.reflect(false);
      case 'desktop.on':
        return s.desktop.ensureOn();
      case 'desktop.off':
        return s.stopDesktop().then(() => null);
      case 'desktop.restart':
        return s.restartDesktop().then(() => null);
      case 'desktop.toggle':
        return s.desktop.refresh().then((st): Promise<unknown> => (st.state === 'on' ? s.stopDesktop() : s.desktop.start())).then(() => null);
      case 'desktop.status':
        return (a.refresh ? s.desktop.refresh() : Promise.resolve(s.desktop.current)).then((status) => ({ status, networkMode: s.desktop.networkMode }));
      case 'desktop.detectRuntime':
        return s.desktop.detectRuntime();
      case 'desktop.install':
        return this.installRuntime();
      case 'desktop.poll':
        return this.setPoll(conn, a.on), null;
      case 'desktop.screenshot':
        return s.desktopScreenshot();
      case 'files.upload': {
        const data = Buffer.from(a.base64, 'base64');
        return s.uploadFile(a.name, data);
      }
      case 'files.list':
        return s.listDownloads();
      case 'clipboard.get':
        return s.clipboardGet(a.hint ?? '').then((t) => t ?? null);
      case 'clipboard.set':
        return s.clipboardSet(a.text);
      case 'releaseInput':
        return s.releaseInput().then(() => null);
      case 'config.get':
        return s.config;
      case 'config.set':
        return s.patchConfig(a.patch);
      case 'config.schema':
        return s.settingsSchema;
      case 'model.set':
        return s.patchConfig({ provider: a.provider, model: a.model, baseUrl: a.baseUrl, auth: a.auth ?? '' });
      case 'auth.start':
        return s.authStart();
      case 'auth.poll':
        return s.authPoll();
      case 'auth.signOut':
        return s.authSignOut().then(() => null);
      case 'key.set':
        if (!/^deskfish\.apiKey\.[\w.:-]+$/.test(a.slot)) throw new Error('bad key slot');
        s.setKey(a.slot, a.key || undefined);
        return s.secrets.slots();
      case 'key.status':
        return s.secrets.slots();
      case 'schedules.list':
        return { schedules: s.schedules.list(), lines: s.schedules.describe() };
      case 'schedules.add':
        return s.addSchedule(a.task, a.when, { autonomy: a.autonomy, maxCostUsd: a.maxCostUsd });
      case 'schedules.remove':
        return s.removeSchedule(a.id), null;
      case 'schedules.runNow':
        return s.runSchedule(a.id).then(() => null);
      case 'memory.read':
        return s.readHerFile(a.file);
      case 'memory.write':
        return s.writeHerFile(a.file, a.text), null;
      case 'memory.clearFacts': {
        const n = s.memory.list().length;
        s.clearFacts();
        return n;
      }
      case 'self.read':
        return s.whoSheIs();
      case 'journal.read':
        return s.journal.raw();
      case 'playbook.read':
        return s.playbook.raw();
      case 'chats.list':
        return s.chatList();
      case 'chats.read':
        return s.chats.read(s.chatByName(a.name).file);
      case 'chats.open':
        return s.openPastChat(a.name);
      case 'chats.delete':
        return a.name === undefined ? s.deleteAllChats() : s.deleteChat(a.name);
      case 'chats.continue': {
        const chat = s.chatByName(a.name);
        return s.openChat(chat.file, chat.startedAt), null;
      }
      case 'export':
        return s.exportBundle();
      case 'import': {
        const bundle = a.bundle as MemoryBundle;
        if (bundle.format !== 'deskfish-memory' || typeof bundle.self !== 'string') throw new Error('that is not a memory export');
        return s.importBundle(bundle as MemoryBundle & { self: string }), null;
      }
      case 'log.tail':
        return this.opts.logTail?.(Math.max(1, Math.min(5000, a.lines ?? 200))) ?? [];
      case 'remote.enroll':
        return this.remoteEnroll({ relay: a.relay, username: a.username, code: a.code });
      case 'remote.password':
        return this.remotePassword({ serverSetup: a.serverSetup, record: a.record });
      case 'remote.status':
        return this.remoteStatus();
      case 'remote.off':
        return this.remoteOff(!!a.forget);
      case 'shutdown':
        this.log('— shutdown asked by a client —');
        return null;
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function html(res: http.ServerResponse, status: number, page: WebResponse): void {
  res.writeHead(status, page.headers);
  res.end(page.html);
}

function refuse(socket: Duplex, status: number, text: string): void {
  if (socket.writable) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  else socket.destroy();
}

/** The request body, or undefined when it passes `limit` bytes. */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        chunks.length = 0;
        resolve(undefined);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
