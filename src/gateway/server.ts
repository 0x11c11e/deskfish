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

interface Conn {
  ws: WebSocket;
  hello: boolean;
  client?: string;
  poll: boolean;
}

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
    for (const c of this.conns) c.ws.terminate();
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
    const conn: Conn = { ws, hello: false, poll: false };
    this.conns.add(conn);
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return this.reply(conn, null, false, 'binary frames are not part of the protocol');
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this.reply(conn, null, false, 'not JSON');
      }
      const v = validate(msg);
      if (!v.ok) return this.reply(conn, v.id, false, v.error);
      this.handle(conn, v.req);
    });
    ws.on('close', () => {
      this.conns.delete(conn);
      this.setPoll(conn, false);
    });
    ws.on('error', () => ws.terminate());
  }

  private reply(conn: Conn, id: number | null, ok: boolean, payload: unknown): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(JSON.stringify(ok ? { id, ok: true, result: payload ?? null } : { id, ok: false, error: String(payload) }));
  }

  private broadcast(event: EventName, data: unknown): void {
    if (!this.conns.size) return;
    const frame = JSON.stringify({ event, data });
    for (const c of this.conns) if (c.hello && c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
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
        return s.patchConfig({ provider: a.provider, model: a.model, baseUrl: a.baseUrl });
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
