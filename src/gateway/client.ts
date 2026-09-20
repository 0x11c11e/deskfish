import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { AgentEvent, AgentStatus } from '../agent/loop';
import type { RuntimeStatus } from '../desktop/runtime';
import type { DesktopStatus, SupervisorLike } from '../desktop/supervisor';
import type { DesktopFile } from '../webview/protocol';
import { EVENT_NAMES, MAX_FRAME, type ClientKind, type CommandArgs, type CommandName, type CommandResult, type EventName, type RunRequest, type Snapshot } from './protocol';

/**
 * A client of the gateway with the service's shape: commands become requests over `/ws`, the
 * service's events come back as the same events (`event`, `desktop`, `task`, `notice`, …), and it
 * reconnects with backoff. After every (re)connect it says hello and emits `connected` with a fresh
 * snapshot; `disconnected` when the socket drops. Files go over HTTP (`/files`); the live view's
 * address is `vncUrl()`. No `vscode` import.
 */

export interface GatewayClientOptions {
  /** The gateway's base address, e.g. http://127.0.0.1:9980 */
  url: string;
  token: string;
  client: ClientKind;
  version: string;
  /** Called before each reconnect attempt (the extension restarts a local gateway that went away). */
  beforeReconnect?: () => Promise<void>;
  log?: (line: string) => void;
}

export class GatewayError extends Error {}

/** `sync` runs inside the frame handler, before any later frame: the snapshot must land before the events that follow it. */
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; sync?: (v: any) => void };

export class GatewayClient extends EventEmitter {
  private ws?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private backoff = 500;
  private retry?: NodeJS.Timeout;
  private isConnected = false;
  private errorLogged = false;
  /** `connect()` has been called: a token set before that is simply the token the first open uses. */
  private started = false;
  private readonly log: (line: string) => void;

  /** Mirrors of the gateway's state, kept current by events. */
  snapshot?: Snapshot;
  status: AgentStatus = 'idle';
  screenFree = false;
  latestScreenshot?: { dataUrl: string; width: number; height: number };
  keys: string[] = [];
  /** Who the endpoint is signed in as ("Sign in with Grok"), when it is. A display name, never a token. */
  signedInAs?: string;
  readonly desktop: RemoteDesktop;

  constructor(private opts: GatewayClientOptions) {
    super();
    this.setMaxListeners(50);
    this.log = opts.log ?? (() => {});
    this.desktop = new RemoteDesktop(this);
  }

  get url(): string {
    return this.opts.url;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /** Connect (and keep reconnecting until close()). Resolves with the first snapshot. */
  connect(): Promise<Snapshot> {
    this.started = true;
    this.closed = false;
    const first = new Promise<Snapshot>((resolve) => this.once('connected', resolve));
    this.open();
    return first;
  }

  /** Resolves once connected, or rejects after `timeoutMs`. */
  whenConnected(timeoutMs = 10_000): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off('connected', done);
        reject(new GatewayError('Deskfish is not connected to its gateway'));
      }, timeoutMs);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      this.once('connected', done);
    });
  }

  /**
   * A new token (someone just entered one for a gateway on another machine). Used from now on, and
   * the connection is made again at once — entering the token is the whole step, not a step plus a
   * window reload.
   */
  setToken(token: string): void {
    if (token === this.opts.token) return;
    this.opts.token = token;
    if (!this.started || this.closed) return;
    clearTimeout(this.retry);
    this.backoff = 500;
    this.errorLogged = false;
    const old = this.ws;
    this.ws = undefined;
    old?.removeAllListeners(); // closing it is this method's doing, not an outage to log
    // …but a socket still shaking hands answers terminate() with an 'error' event, and an
    // EventEmitter with no listener for that throws it at the extension host.
    old?.on('error', () => {});
    old?.terminate();
    if (this.isConnected) {
      this.isConnected = false;
      this.dropPending('the gateway token changed');
      this.emit('disconnected');
    }
    this.open();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.ws?.terminate();
    this.ws = undefined;
    this.dropPending('the client closed');
  }

  private wsUrl(path: string): string {
    const u = new URL(path, this.opts.url);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  }

  private open(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.wsUrl('/ws'), { headers: { authorization: `Bearer ${this.opts.token}` }, maxPayload: MAX_FRAME });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 500;
      this.send('hello', { client: this.opts.client, version: this.opts.version }, (snap: Snapshot) => {
        this.isConnected = true;
        this.errorLogged = false;
        this.absorb(snap);
        this.emit('connected', snap);
      }).catch((err) => this.log(`gateway hello failed: ${err.message}`));
    });
    ws.on('message', (raw) => this.onFrame(raw.toString()));
    ws.on('unexpected-response', (_req, res) => {
      this.log(`gateway refused the connection: HTTP ${res.statusCode}`);
      if (res.statusCode === 401) this.emit('unauthorized');
    });
    ws.on('error', (err) => {
      // Once per outage, not once per retry.
      if (this.errorLogged) return;
      this.errorLogged = true;
      this.log(`gateway socket: ${err.message}`);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      const was = this.isConnected;
      this.isConnected = false;
      this.dropPending('the gateway connection closed');
      if (was) this.emit('disconnected');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    clearTimeout(this.retry);
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 10_000);
    this.retry = setTimeout(async () => {
      try {
        await this.opts.beforeReconnect?.();
      } catch (err) {
        this.log(`gateway: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.open();
    }, delay);
  }

  private dropPending(why: string): void {
    for (const p of this.pending.values()) p.reject(new GatewayError(why));
    this.pending.clear();
  }

  private onFrame(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.event === 'string') {
      if (!EVENT_NAMES.includes(msg.event)) return;
      this.track(msg.event, msg.data);
      this.emit(msg.event, msg.data);
      return;
    }
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) {
      p.sync?.(msg.result);
      p.resolve(msg.result);
    }
    else p.reject(new GatewayError(String(msg.error)));
  }

  /** Keep the mirrors current before listeners hear the event. */
  private track(name: EventName, data: any): void {
    if (name === 'event') {
      const e = data as AgentEvent;
      if (e.type === 'status') {
        this.status = e.status;
        this.screenFree = !!e.screenFree;
      } else if (e.type === 'screenshot' && e.jpegBase64) {
        // No frame means the step took none (a passive batch); the mirror keeps the last real one.
        this.latestScreenshot = { dataUrl: `data:image/jpeg;base64,${e.jpegBase64}`, width: e.width, height: e.height };
      }
    } else if (name === 'desktop') {
      if ((data as DesktopStatus).state !== 'on') this.latestScreenshot = undefined;
      this.desktop.absorb(data as DesktopStatus);
    } else if (name === 'keys') {
      this.keys = data as string[];
    } else if (name === 'reset') {
      this.latestScreenshot = undefined;
    } else if (name === 'desktop.hostNetwork') {
      this.desktop.networkModeSeen('host');
    }
  }

  private absorb(s: Snapshot): void {
    this.snapshot = s;
    this.status = s.status;
    this.screenFree = s.screenFree;
    this.latestScreenshot = s.screenshot ? { dataUrl: s.screenshot.dataUrl, width: s.screenshot.width, height: s.screenshot.height } : undefined;
    this.keys = s.keys;
    this.signedInAs = s.signedInAs;
    this.desktop.absorb(s.desktop.status, s.desktop.networkMode);
  }

  private send<K extends CommandName>(cmd: K, args?: CommandArgs<K>, sync?: (result: CommandResult<K>) => void): Promise<CommandResult<K>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new GatewayError('Deskfish is not connected to its gateway'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sync });
      ws.send(JSON.stringify({ id, cmd, args }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  /** A command, once connected (waits up to 10 s for a reconnect). */
  async call<K extends CommandName>(cmd: K, args?: CommandArgs<K>): Promise<CommandResult<K>> {
    await this.whenConnected();
    return this.send(cmd, args);
  }

  /** A fresh snapshot (also refreshes the mirrors). `render` runs before any event that follows it is emitted. */
  async refreshSnapshot(render?: (s: Snapshot) => void): Promise<Snapshot> {
    await this.whenConnected();
    return this.send('snapshot', undefined, (s) => {
      this.absorb(s);
      render?.(s);
    });
  }

  /* ---------- HTTP: files and the live view ---------- */

  private httpUrl(path: string): string {
    return new URL(path, this.opts.url).toString();
  }

  private async http(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.httpUrl(path), { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.opts.token}` } });
    if (!res.ok) {
      let error = `HTTP ${res.status}`;
      try {
        error = ((await res.json()) as { error?: string }).error ?? error;
      } catch {
        /* not JSON */
      }
      throw new GatewayError(error);
    }
    return res;
  }

  /** Copy bytes into the tank's Uploads folder. */
  async uploadFile(name: string, data: Uint8Array): Promise<DesktopFile> {
    const res = await this.http(`/files?name=${encodeURIComponent(name)}`, { method: 'POST', body: data as unknown as BodyInit, headers: { 'content-type': 'application/octet-stream' } });
    return (await res.json()) as DesktopFile;
  }

  /** The bytes of a file on the tank. */
  async readFile(file: DesktopFile): Promise<Buffer> {
    const res = await this.http(`/files${file.path.split('/').map(encodeURIComponent).join('/')}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** The live view's WebSocket address (the gateway pipes it to the tank's websockify). */
  vncUrl(): string {
    const u = new URL(this.wsUrl('/vnc'));
    u.searchParams.set('token', this.opts.token);
    return u.toString();
  }

  /* ---------- the service's shape ---------- */

  run(task: string, attachments?: DesktopFile[], opts: Omit<RunRequest, 'task' | 'attachments'> = {}): Promise<null> {
    return this.call('run', { task, ...(attachments?.length ? { attachments } : {}), ...opts });
  }

  say(text: string, attachments?: DesktopFile[]): Promise<null> {
    return this.call('say', { text, ...(attachments?.length ? { attachments } : {}) });
  }

  pause(): Promise<null> {
    return this.call('pause');
  }

  resume(): Promise<null> {
    return this.call('resume');
  }

  stop(): Promise<null> {
    return this.call('stop');
  }

  newConversation(): Promise<null> {
    return this.call('newChat');
  }

  reflect(): Promise<'busy' | 'started' | 'failed'> {
    return this.call('reflect');
  }

  releaseInput(): Promise<null> {
    return this.call('releaseInput');
  }
}

/** The tank's supervisor as seen through the gateway: same surface, state mirrored from `desktop` events. */
export class RemoteDesktop extends EventEmitter implements SupervisorLike {
  private status: DesktopStatus = { state: 'unknown' };
  private mode?: 'isolated' | 'host';
  private polling = false;

  constructor(private readonly client: GatewayClient) {
    super();
    client.on('connected', () => {
      // A new gateway process (or the same after a drop) knows nothing of this client's poll.
      if (this.polling) void client.call('desktop.poll', { on: true }).catch(() => {});
    });
    client.on('desktop.hostNetwork', () => this.emit('hostNetwork'));
    client.on('desktop.startFailed', (m: string) => this.emit('startFailed', m));
    client.on('desktop.stopFailed', (m: string) => this.emit('stopFailed', m));
  }

  /** @internal a status from the gateway; emits `change` when it differs. */
  absorb(status: DesktopStatus, networkMode?: 'isolated' | 'host'): void {
    if (networkMode) this.mode = networkMode;
    else if (status.state === 'off' || status.state === 'stopping') this.mode = undefined;
    const same = this.status.state === status.state && this.status.message === status.message && this.status.runtime?.cli === status.runtime?.cli;
    this.status = status;
    if (!same) this.emit('change', status);
  }

  /** @internal */
  networkModeSeen(mode: 'isolated' | 'host'): void {
    this.mode = mode;
  }

  get current(): DesktopStatus {
    return this.status;
  }

  get runtime(): RuntimeStatus | undefined {
    return this.status.runtime;
  }

  get runtimeMissing(): boolean {
    return this.status.runtime?.cli === 'none';
  }

  get networkMode(): 'isolated' | 'host' | undefined {
    return this.mode;
  }

  async refresh(): Promise<DesktopStatus> {
    const v = await this.client.call('desktop.status', { refresh: true });
    this.absorb(v.status, v.networkMode);
    return v.status;
  }

  async detectRuntime(): Promise<RuntimeStatus> {
    return this.client.call('desktop.detectRuntime');
  }

  startPolling(): void {
    this.polling = true;
    if (this.client.connected) void this.client.call('desktop.poll', { on: true }).catch(() => {});
  }

  stopPolling(): void {
    this.polling = false;
    if (this.client.connected) void this.client.call('desktop.poll', { on: false }).catch(() => {});
  }

  ensureOn(): Promise<boolean> {
    return this.client.call('desktop.on');
  }

  start(): Promise<boolean> {
    return this.client.call('desktop.on');
  }

  async stop(): Promise<void> {
    await this.client.call('desktop.off');
  }

  async toggle(): Promise<void> {
    await this.client.call('desktop.toggle');
  }
}
