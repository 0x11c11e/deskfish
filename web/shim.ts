import type { AgentEvent, AgentStatus } from '../src/agent/loop';
import { PRESETS, isLocalEndpoint, keySlotFor, presetFor, type Preset } from '../src/agent/presets';
import { formatSize, safeFileName } from '../src/desktop/files';
import type { DesktopStatus } from '../src/desktop/supervisor';
import type { DeskfishConfig } from '../src/gateway/config';
import { EVENT_NAMES, MAX_TRANSFER, type CommandArgs, type CommandName, type CommandResult, type DesktopView, type EventName, type Events, type Snapshot } from '../src/gateway/protocol';
import type { MemoryBundle } from '../src/gateway/service';
import { VERSION } from '../src/gateway/version';
import { answerAsk, isViewCommand, snapshotChat } from '../src/webview/bridge';
import type { DesktopFile, FromChat, FromDesktop, PanelName, ToChat, ToDesktop, UiConfig } from '../src/webview/protocol';

/**
 * The web page's stand-in for VS Code. The chat and the Desktop view run their webview bundles
 * unchanged, each in an `<iframe srcdoc>` whose `acquireVsCodeApi()` returns `WebHost.api(pane)`:
 * what a view posts (`FromChat`, `FromDesktop`) becomes a command over the gateway's WebSocket, and
 * the gateway's snapshot and events become the messages the views already understand (`ToChat`,
 * `ToDesktop`) — the work `ChatViewProvider`, `DesktopPanel` and the controller do in VS Code. What
 * only VS Code had gets a browser version: a file input and `POST /files` for attach, a download of
 * `GET /files/…` for save, `navigator.clipboard` for copy, `/docs` in a new tab, small dialogs for the
 * model and the key, the log in a dialog, a toast instead of a popup. The view's `ask` (its panels'
 * gateway commands) goes over the same socket; the title bar opens the panels and holds a `…` menu
 * for what VS Code has as commands (reflect, export, import, delete past chats, log, docs).
 *
 * The mapping is pure (`Mirror`, `viewCommand`) so it is tested without a browser; `boot()` runs only
 * in one.
 */

export type Pane = 'chat' | 'desktop';

/** Messages for the two views. */
export interface Out {
  chat: ToChat[];
  desktop: ToDesktop[];
}

const none = (): Out => ({ chat: [], desktop: [] });
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The same status for the views (the rule `RemoteDesktop` uses: a repeated "still on" is not news). */
const sameDesktop = (a: DesktopStatus, b: DesktopStatus) => a.state === b.state && a.message === b.message && a.runtime?.cli === b.runtime?.cli;

/** What the page knows of the gateway, kept current by snapshots and events; turns both into view messages. */
export class Mirror {
  config?: DeskfishConfig;
  keys: string[] = [];
  desktop: DesktopStatus = { state: 'unknown' };
  status: AgentStatus = 'idle';
  statusMessage?: string;
  screenFree = false;
  screenshot?: { dataUrl: string; width: number; height: number };

  /** `vncUrl`: the gateway's `/vnc` with the token (the live view's address). */
  constructor(readonly vncUrl: string) {}

  /** The chat's header rows, as `ChatViewProvider.sendConfig` builds them from VS Code settings. */
  uiConfig(): UiConfig | undefined {
    const c = this.config;
    if (!c) return undefined;
    const slot = keySlotFor(c.provider, c.baseUrl);
    return { provider: c.provider, model: c.model, baseUrl: c.baseUrl, daemonUrl: c.daemonUrl, vncUrl: c.vncUrl, hasApiKey: !!slot && this.keys.includes(slot), maxSteps: c.maxSteps, desktop: this.desktop, keyStored: 'Stored in the gateway' };
  }

  private configMessage(): ToChat[] {
    const config = this.uiConfig();
    return config ? [{ type: 'config', config }] : [];
  }

  connectMessage(): ToDesktop {
    return { type: 'connect', url: this.vncUrl, password: this.config?.vncPassword || undefined };
  }

  /** A snapshot (after hello, or asked for when the chat opens): the messages that rebuild both views. */
  absorbSnapshot(s: Snapshot): Out {
    this.config = s.config;
    this.keys = s.keys;
    this.desktop = s.desktop.status;
    this.status = s.status;
    this.statusMessage = s.statusMessage;
    this.screenFree = s.screenFree;
    this.screenshot = s.screenshot ? { dataUrl: s.screenshot.dataUrl, width: s.screenshot.width, height: s.screenshot.height } : undefined;
    return { chat: [...snapshotChat(s), ...this.configMessage()], desktop: this.desktopState() };
  }

  /** Everything the Desktop view needs when it (re)opens. */
  desktopState(): ToDesktop[] {
    const out: ToDesktop[] = [{ type: 'desktop', status: this.desktop }, this.connectMessage(), { type: 'agentStatus', status: this.status, message: this.statusMessage, screenFree: this.screenFree }];
    if (this.screenshot) out.push({ type: 'screenshot', ...this.screenshot });
    return out;
  }

  /** The chat's header after a change the page made itself (a key saved, the desktop refreshed). */
  headerOut(): Out {
    return { chat: this.configMessage(), desktop: [] };
  }

  /** One gateway event. */
  event<K extends EventName>(name: K, data: Events[K]): Out {
    const out = none();
    switch (name) {
      case 'event': {
        const e = data as AgentEvent;
        out.chat.push({ type: 'event', event: e });
        if (e.type === 'status') {
          this.status = e.status;
          this.statusMessage = e.message;
          this.screenFree = !!e.screenFree;
          out.desktop.push({ type: 'agentStatus', status: e.status, message: e.message, screenFree: e.screenFree });
        } else if (e.type === 'action') {
          out.desktop.push({ type: 'agentAction', action: e.action });
        } else if (e.type === 'screenshot' && e.jpegBase64) {
          this.screenshot = { dataUrl: `data:image/jpeg;base64,${e.jpegBase64}`, width: e.width, height: e.height };
          out.desktop.push({ type: 'screenshot', ...this.screenshot });
        }
        break;
      }
      case 'desktop': {
        const status = data as DesktopStatus;
        const was = this.desktop;
        this.desktop = status;
        if (status.state !== 'on') this.screenshot = undefined;
        if (sameDesktop(was, status)) break;
        out.chat.push({ type: 'desktop', status });
        out.desktop.push({ type: 'desktop', status });
        // Reconnect only when the desktop actually comes up, never on repeated "still on" pings.
        if (status.state === 'on' && was.state !== 'on') out.desktop.push(this.connectMessage());
        break;
      }
      case 'reset':
        this.screenshot = undefined;
        out.chat.push({ type: 'newChat' });
        break;
      case 'replay': {
        const r = data as Events['replay'];
        out.chat.push({ type: 'replay', title: r.title, items: r.items });
        break;
      }
      case 'schedule': {
        const s = data as Events['schedule'];
        out.chat.push(s.kind === 'fired' ? { type: 'user', text: s.text } : { type: 'notice', text: s.text });
        break;
      }
      case 'notice':
        out.chat.push({ type: 'notice', text: (data as Events['notice']).text });
        break;
      case 'download': {
        const f = data as Events['download'];
        out.chat.push({ type: 'download', file: { name: f.name, path: f.path, size: f.size } });
        break;
      }
      case 'config':
        this.config = data as DeskfishConfig;
        out.chat.push(...this.configMessage());
        break;
      case 'keys':
        this.keys = data as string[];
        out.chat.push(...this.configMessage());
        break;
      default:
        // task, log and the desktop.* popups: VS Code shows those outside the views.
        break;
    }
    return out;
  }
}

/**
 * The view messages that are plain gateway commands; the rest (dialogs, files, clipboard, docs) are the
 * page's own work. An `ask` maps to its command only when the view may ask it (`VIEW_COMMANDS`).
 */
export function viewCommand(pane: Pane, m: FromChat | FromDesktop): { cmd: CommandName; args?: Record<string, unknown>; what: string } | undefined {
  const files = (a?: DesktopFile[]) => (a?.length ? { attachments: a.map((f) => ({ name: f.name, path: f.path, size: f.size })) } : {});
  if (pane === 'chat') {
    const c = m as FromChat;
    switch (c.type) {
      case 'ask':
        return isViewCommand(c.cmd) ? { cmd: c.cmd, ...(c.args ? { args: c.args } : {}), what: 'ask' } : undefined;
      case 'run':
        return { cmd: 'run', args: { task: c.task, ...files(c.attachments) }, what: 'start the task' };
      case 'say':
        return { cmd: 'say', args: { text: c.text, ...files(c.attachments) }, what: 'send the message' };
      case 'stop':
        return { cmd: 'stop', what: 'stop' };
      case 'pause':
        return { cmd: 'pause', what: 'pause' };
      case 'resume':
        return { cmd: 'resume', what: 'resume' };
      case 'startDesktop':
        return { cmd: 'desktop.on', what: 'turn on the desktop' };
      case 'stopDesktop':
        return { cmd: 'desktop.off', what: 'turn off the desktop' };
      case 'restartDesktop':
        return { cmd: 'desktop.restart', what: 'restart the desktop' };
      default:
        return undefined;
    }
  }
  const d = m as FromDesktop;
  switch (d.type) {
    case 'takeover':
      return { cmd: 'pause', what: 'take over' };
    case 'handback':
      return { cmd: 'resume', what: 'hand back' };
    case 'startDesktop':
      return { cmd: 'desktop.on', what: 'turn on the desktop' };
    case 'releaseInput':
      return { cmd: 'releaseInput', what: 'release the input' };
    default:
      return undefined;
  }
}

/* ---------- the host: one WebSocket, two views ---------- */

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface ModelChoice {
  preset: Preset;
  provider: DeskfishConfig['provider'];
  model: string;
  baseUrl: string;
}

/** What only a browser can do; `browserUi()` is the real one, tests pass a fake. */
export interface HostUi {
  visible(): boolean;
  connection(connected: boolean): void;
  toast(text: string): void;
  /** She knocked (true) or is working again (false): the tab's title says so while it is in the background. */
  knock(on: boolean): void;
  showDesktop(): void;
  /** `page`: a click on the page itself (its title bar), not inside a view. */
  pickFiles(pane: Pane | 'page', accept?: string): Promise<File[]>;
  saveBlob(name: string, blob: Blob): void;
  copy(pane: Pane, text: string): Promise<boolean>;
  readClipboard(pane: Pane): Promise<string | undefined>;
  writeClipboard(pane: Pane, text: string): Promise<void>;
  openDocs(pane: Pane | 'page', load: () => Promise<Blob>): void;
  askKey(title: string): Promise<string | undefined>;
  askModel(config: DeskfishConfig): Promise<ModelChoice | undefined>;
  /** Ask once, inside the page (a browser `confirm()` would block it); true when `action` was pressed. */
  confirm(text: string, action: string): Promise<boolean>;
  /** Shows the lines; returns a function that appends a live line while the log is open. */
  showLog(lines: string[], onClose: () => void): (line: string) => void;
  reload(): void;
}

export interface HostEnv {
  /** The gateway's `/ws` with the token, e.g. ws://127.0.0.1:9980/ws?token=… */
  wsUrl: string;
  vncUrl: string;
  token: string;
  openSocket(url: string): SocketLike;
  post(pane: Pane, message: ToChat | ToDesktop): void;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  ui: HostUi;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; sync?: (v: any) => void };

export class WebHost {
  readonly mirror: Mirror;
  private ws?: SocketLike;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private connected = false;
  private opened = false;
  private backoff = 500;
  private failures = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private readonly ready: Record<Pane, boolean> = { chat: false, desktop: false };
  private readonly state: Record<Pane, unknown> = { chat: undefined, desktop: undefined };
  private autoStarted = false;
  private logLine?: (line: string) => void;

  constructor(private readonly env: HostEnv) {
    this.mirror = new Mirror(env.vncUrl);
  }

  /** What `acquireVsCodeApi()` returns inside a view. */
  api(pane: Pane): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void } {
    return {
      postMessage: (m) => this.receive(pane, m as FromChat | FromDesktop),
      getState: () => this.state[pane],
      setState: (s) => void (this.state[pane] = s),
    };
  }

  start(): void {
    this.open();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** The page became visible or hidden: the desktop's health poll runs while someone looks. */
  visibility(): void {
    if (this.connected) void this.call('desktop.poll', { on: this.env.ui.visible() }).catch(() => {});
  }

  /* ---------- the socket ---------- */

  private open(): void {
    const ws = this.env.openSocket(this.env.wsUrl);
    this.ws = ws;
    this.opened = false;
    ws.onopen = () => {
      this.opened = true;
      this.backoff = 500;
      this.request('hello', { client: 'web', version: VERSION }, (snap) => this.onConnected(snap)).catch(() => {});
    };
    ws.onmessage = (ev) => this.onFrame(String(ev.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.connected = false;
      for (const p of this.pending.values()) p.reject(new Error('the connection to Deskfish closed'));
      this.pending.clear();
      this.env.ui.connection(false);
      if (!this.opened) this.failures++;
      void this.checkToken();
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    };
  }

  /**
   * A browser cannot see why a WebSocket was refused. From the third refusal in a row, ask the
   * gateway over HTTP: any path but `/status` answers 401 first when the token is wrong, and then
   * the page reloads into the sign-in page (a gateway that is not reachable is asked again after
   * the next refusal).
   */
  private async checkToken(): Promise<void> {
    if (this.failures < 3) return;
    try {
      const res = await this.env.fetch('/docs', { method: 'HEAD', headers: { authorization: `Bearer ${this.env.token}` } });
      if (res.status === 401) this.env.ui.reload();
    } catch {
      /* the gateway is not reachable: keep retrying */
    }
  }

  private onConnected(snap: Snapshot): void {
    this.connected = true;
    this.failures = 0;
    this.env.ui.connection(true);
    this.send(this.mirror.absorbSnapshot(snap));
    this.visibility();
    void this.autoStart();
  }

  private onFrame(text: string): void {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof m.event === 'string') {
      if (EVENT_NAMES.includes(m.event)) this.onEvent(m.event, m.data);
      return;
    }
    const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) {
      // Inside the frame handler: a snapshot is rendered before any event that follows it.
      p.sync?.(m.result);
      p.resolve(m.result);
    } else {
      p.reject(new Error(String(m.error)));
    }
  }

  private onEvent(name: EventName, data: any): void {
    this.send(this.mirror.event(name, data));
    if (name === 'log') this.logLine?.(data);
    if (name === 'event' && data.type === 'needs_user') this.env.ui.knock(true);
    if (name === 'event' && data.type === 'status' && data.status !== 'paused') this.env.ui.knock(false);
  }

  private send(out: Out): void {
    if (this.ready.chat) for (const m of out.chat) this.env.post('chat', m);
    if (this.ready.desktop) for (const m of out.desktop) this.env.post('desktop', m);
  }

  private request<K extends CommandName>(cmd: K, args?: CommandArgs<K>, sync?: (r: CommandResult<K>) => void): Promise<CommandResult<K>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('Deskfish is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sync });
      ws.send(JSON.stringify({ id, cmd, args }));
    });
  }

  /** A command once connected. */
  call<K extends CommandName>(cmd: K, args?: CommandArgs<K>): Promise<CommandResult<K>> {
    if (!this.connected) return Promise.reject(new Error('Deskfish is not connected'));
    return this.request(cmd, args);
  }

  /** A command from a button: an error becomes a toast. */
  private attempt<T>(what: string, p: Promise<T>): Promise<T | undefined> {
    return p.catch((err) => {
      this.env.ui.toast(`Could not ${what}: ${msg(err)}`);
      return undefined;
    });
  }

  /* ---------- the views ---------- */

  receive(pane: Pane, m: FromChat | FromDesktop): void {
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    if (pane === 'chat' && m.type === 'ask') {
      this.ask(m);
      return;
    }
    const command = viewCommand(pane, m);
    if (command) {
      void this.attempt(command.what, this.call(command.cmd, command.args as never));
      return;
    }
    if (pane === 'chat') void this.fromChat(m as FromChat);
    else this.fromDesktop(m as FromDesktop);
  }

  /** A panel's gateway command: forwarded when the view may ask it, answered either way. A snapshot is answered inside its frame, before the events after it. */
  private ask(m: Extract<FromChat, { type: 'ask' }>): void {
    void answerAsk(
      m,
      (cmd, args, respond) => {
        if (!this.connected) return Promise.reject(new Error('Deskfish is not connected'));
        return this.request(cmd, args as never, (result) => respond({ type: 'answer', id: m.id, ok: true, result }));
      },
      (a) => this.env.post('chat', a),
    );
  }

  private async fromChat(m: FromChat): Promise<void> {
    const ui = this.env.ui;
    switch (m.type) {
      case 'ready':
        this.ready.chat = true;
        // The chat opens on the present: a fresh snapshot, rendered before the events after it.
        if (this.connected) await this.request('snapshot', undefined, (snap) => this.send({ chat: this.mirror.absorbSnapshot(snap).chat, desktop: [] })).catch(() => {});
        break;
      case 'refresh': {
        const v = await this.attempt('check the desktop', this.call('desktop.status', { refresh: true }));
        if (v) this.send(this.mirror.event('desktop', (v as DesktopView).status));
        this.send(this.mirror.headerOut());
        break;
      }
      case 'attach':
        await this.attach(await ui.pickFiles('chat'));
        break;
      case 'saveFile':
        await this.save(m.file);
        break;
      case 'revealFile':
        // Never asked: a saved file is in the browser's downloads, and the card offers no "Show in folder".
        break;
      case 'openDesktop':
        ui.showDesktop();
        break;
      case 'setApiKey':
        await this.setKey();
        break;
      case 'openSettings':
        await this.changeModel();
        break;
      case 'showLog':
        await this.showLog();
        break;
      case 'openDocs':
        this.openDocs('chat');
        break;
      case 'copy':
        await ui.copy('chat', m.text);
        break;
      case 'installRuntime': {
        const rt = this.mirror.desktop.runtime;
        const command = rt?.cli === 'none' ? rt.install.command : undefined;
        if (!command) break;
        // The app's gateway opens a terminal on its own screen; any other gateway answers false.
        if (await this.call('desktop.install').catch(() => false)) {
          ui.toast('A terminal opened with the install command. When it has finished, click Check again.');
          break;
        }
        const copied = await ui.copy('chat', command);
        ui.toast(copied ? 'The install command is on your clipboard: run it in a terminal on the computer where Deskfish runs, then click Check again.' : `Run this in a terminal on the computer where Deskfish runs, then click Check again: ${command}`);
        break;
      }
      default:
        break;
    }
  }

  private fromDesktop(m: FromDesktop): void {
    const ui = this.env.ui;
    switch (m.type) {
      case 'ready':
        this.ready.desktop = true;
        // Before the gateway has answered there is nothing to connect to: the snapshot brings the view its
        // state (an attempt on an unknown desktop left "connection lost" on the pill when it was just off).
        if (this.connected) this.send({ chat: [], desktop: this.mirror.desktopState() });
        break;
      case 'clipboardSync':
        // Only a paste reads this browser's clipboard (a read may ask for permission); focus and clicks do not.
        if (!m.paste) break;
        void ui
          .readClipboard('desktop')
          .then((text) => (text === undefined || !this.connected ? false : this.call('clipboard.set', { text })))
          .catch(() => false)
          .then((ok) => this.env.post('desktop', { type: 'clipboardSynced', ok: !!ok, paste: true }));
        break;
      case 'clipboardChanged':
        if (!this.connected || this.mirror.desktop.state !== 'on') break;
        void this.call('clipboard.get', { hint: m.text })
          .then((text) => (text === null ? undefined : ui.writeClipboard('desktop', text)))
          .catch(() => {});
        break;
      case 'log':
        (m.level === 'error' ? console.error : m.level === 'warn' ? console.warn : console.info)(`[desktop] ${m.message}`);
        break;
      default:
        break;
    }
  }

  /** Turn the desktop on once per page when the setting asks for it, as the VS Code sidebar does. */
  private async autoStart(): Promise<void> {
    if (this.autoStarted || !this.mirror.config?.autoStart) return;
    const v = await this.call('desktop.status', { refresh: true }).catch(() => undefined);
    if (!v) return;
    this.send(this.mirror.event('desktop', v.status));
    if (v.status.state === 'off' && v.status.runtime?.cli !== 'none') {
      this.autoStarted = true;
      void this.call('desktop.on').catch(() => {});
    }
  }

  /** Copy files the person picked into the tank's Uploads folder, then show them in the composer. */
  async attach(files: File[]): Promise<void> {
    if (!files.length) return;
    const on = await this.attempt('turn on the desktop', this.call('desktop.on'));
    if (!on) {
      if (on === false) this.env.ui.toast('The desktop is not running, so the files could not be copied to it.');
      return;
    }
    const out: DesktopFile[] = [];
    for (const f of files) {
      const name = safeFileName(f.name);
      try {
        if (f.size > MAX_TRANSFER) throw new Error(`larger than ${formatSize(MAX_TRANSFER)}`);
        const res = await this.env.fetch(`/files?name=${encodeURIComponent(name)}`, { method: 'POST', body: f, headers: { authorization: `Bearer ${this.env.token}`, 'content-type': 'application/octet-stream' } });
        if (!res.ok) throw new Error(await errorOf(res));
        out.push((await res.json()) as DesktopFile);
      } catch (err) {
        this.env.ui.toast(`Could not attach ${name}: ${msg(err)}`);
      }
    }
    if (out.length) this.env.post('chat', { type: 'attached', files: out });
  }

  /** A file from the tank's Downloads to this browser's downloads. */
  async save(file: DesktopFile): Promise<void> {
    try {
      if (this.mirror.desktop.state !== 'on') throw new Error('the desktop is not running');
      if (file.size > MAX_TRANSFER) throw new Error(`${file.name} is larger than ${formatSize(MAX_TRANSFER)}`);
      const res = await this.env.fetch(`/files${file.path.split('/').map(encodeURIComponent).join('/')}`, { headers: { authorization: `Bearer ${this.env.token}` } });
      if (!res.ok) throw new Error(await errorOf(res));
      this.env.ui.saveBlob(file.name, await res.blob());
      // The browser keeps the file in its downloads; the card's button comes back for another copy.
      this.env.post('chat', { type: 'saveFailed', path: file.path, error: '' });
      this.env.ui.toast(`${file.name} is in your browser's downloads.`);
    } catch (err) {
      this.env.post('chat', { type: 'saveFailed', path: file.path, error: msg(err) });
    }
  }

  /** New chat (the page's title bar). */
  newChat(): void {
    void this.attempt('start a new chat', this.call('newChat'));
  }

  /** A title bar button: the panel opens inside the chat view. */
  openPanel(panel: PanelName): void {
    if (this.ready.chat) this.env.post('chat', { type: 'open', panel });
  }

  async showLog(): Promise<void> {
    const lines = await this.attempt('read the log', this.call('log.tail', { lines: 400 }));
    this.logLine = this.env.ui.showLog(lines ?? [], () => (this.logLine = undefined));
  }

  openDocs(from: Pane | 'page'): void {
    this.env.ui.openDocs(from, async () => {
      const res = await this.env.fetch('/docs', { headers: { authorization: `Bearer ${this.env.token}` } });
      if (!res.ok) throw new Error(`the documentation is not there (HTTP ${res.status})`);
      return res.blob();
    });
  }

  /* ---------- the title bar's … menu: what VS Code has as commands ---------- */

  /** "Let her reflect now". */
  async reflectNow(): Promise<void> {
    const r = await this.attempt('start a reflection', this.call('reflect'));
    if (r === 'busy') this.env.ui.toast('She is busy; let her finish first.');
    else if (r === 'failed') this.env.ui.toast('Could not start a reflection; the log says why.');
  }

  /** One JSON file with everything that makes her, into the browser's downloads (the bytes VS Code's export writes). */
  async exportMemory(): Promise<void> {
    const bundle = await this.attempt('export her memory', this.call('export'));
    if (!bundle) return;
    const name = `deskfish-export-${new Date().toISOString().slice(0, 10)}.json`;
    this.env.ui.saveBlob(name, new Blob([JSON.stringify(bundle, null, 1)], { type: 'application/json' }));
    this.env.ui.toast(`Her memory is in your browser's downloads (${name}).`);
  }

  /** Replace facts, self and journal from an export, after the same question VS Code asks; then the page rebuilds. */
  async importMemory(files: File[]): Promise<void> {
    const file = files[0];
    if (!file) return;
    let bundle: MemoryBundle;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      this.env.ui.toast('That file is not a memory export.');
      return;
    }
    if (!bundle || bundle.format !== 'deskfish-memory' || typeof bundle.self !== 'string') {
      this.env.ui.toast('That file is not a memory export.');
      return;
    }
    const yes = await this.env.ui.confirm('Replace her facts, her self file and her journal with the ones in this file? The current versions are kept in her history, but the next chat starts from the imported ones.', 'Import');
    if (!yes) return;
    if ((await this.attempt('import her memory', this.call('import', { bundle }))) === undefined) return;
    await this.request('snapshot', undefined, (snap) => this.send(this.mirror.absorbSnapshot(snap))).catch(() => {});
    this.env.ui.toast('Her memory is imported. The next chat starts from it.');
  }

  /** "Delete all past chats" (the history panel has the same button at its foot). */
  async deleteAllChats(): Promise<void> {
    const list = await this.attempt('list past chats', this.call('chats.list'));
    if (!list) return;
    const n = list.length;
    if (!n) {
      this.env.ui.toast('There are no past chats.');
      return;
    }
    if (!(await this.env.ui.confirm(`Delete all ${n} past chat${n === 1 ? '' : 's'}? Her journal, facts and self are not touched.`, 'Delete'))) return;
    const deleted = await this.attempt('delete past chats', this.call('chats.delete'));
    if (deleted !== undefined) this.env.ui.toast(`Deleted ${deleted} past chat${deleted === 1 ? '' : 's'}.`);
  }

  /** The "Set API key" / "Change" button of the key row. */
  async setKey(): Promise<void> {
    const cfg = this.mirror.config;
    if (!cfg) return;
    const slot = keySlotFor(cfg.provider, cfg.baseUrl);
    if (!slot) {
      this.env.ui.toast('The demo model needs no key.');
      return;
    }
    const where = presetFor(cfg.provider, cfg.baseUrl)?.label ?? (cfg.baseUrl || cfg.provider);
    const key = await this.env.ui.askKey(`API key for ${where} (${cfg.model})`);
    if (key === undefined) return;
    const slots = await this.attempt('save the key', this.call('key.set', { slot, key: key.trim() }));
    if (!slots) return;
    this.mirror.keys = slots;
    this.send(this.mirror.headerOut());
    this.env.ui.toast(key.trim() ? `API key for ${where} saved.` : `API key for ${where} cleared.`);
  }

  /** The model row's "Change": where the model comes from, which model, then the key if that place needs one and has none. */
  async changeModel(): Promise<void> {
    const cfg = this.mirror.config;
    if (!cfg) return;
    const choice = await this.env.ui.askModel(cfg);
    if (!choice) return;
    const next = await this.attempt('change the model', this.call('model.set', { provider: choice.provider, model: choice.model, baseUrl: choice.baseUrl }));
    if (!next) return;
    this.mirror.config = next;
    this.send(this.mirror.headerOut());
    const slot = keySlotFor(choice.provider, choice.baseUrl);
    if (choice.preset.needsKey && !isLocalEndpoint(choice.baseUrl) && slot && !this.mirror.keys.includes(slot)) await this.setKey();
    else this.env.ui.toast(`Using ${choice.model} via ${choice.preset.label}.`);
  }
}

async function errorOf(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/* ---------- the browser ---------- */

const TOKEN_KEY = 'deskfish.token';

/** The real `HostUi`: the page's toast, banner and dialogs, and the views' own windows for what needs the person's click. */
export function browserUi(doc: Document): HostUi {
  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
  const frame = (pane: Pane) => $<HTMLIFrameElement>(pane);
  // The click happened inside a view: file pickers, the clipboard and new tabs are asked of that view's window.
  const win = (pane: Pane | 'page'): Window => (pane === 'page' ? window : (frame(pane)?.contentWindow ?? window));
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let connTimer: ReturnType<typeof setTimeout> | undefined;
  let knocking = false;

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible' && knocking) doc.title = 'Deskfish';
  });

  const execCopy = (d: Document, text: string): boolean => {
    const ta = d.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    d.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = d.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  };

  /**
   * Resolves with the button that closed the dialog ('' for Escape). Plain buttons close it with their
   * value; the key dialog has no form, so the browser's password manager never offers to keep an API key.
   */
  const run = (dialog: HTMLDialogElement): Promise<string> =>
    new Promise((resolve) => {
      dialog.returnValue = '';
      for (const b of Array.from(dialog.querySelectorAll<HTMLButtonElement>('button[type="button"]'))) b.onclick = () => dialog.close(b.value);
      dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
      dialog.showModal();
    });

  const ui: HostUi = {
    visible: () => doc.visibilityState === 'visible',
    connection(connected) {
      clearTimeout(connTimer);
      const el = $('conn');
      if (connected) el.hidden = true;
      // A short blip (a reconnect) shows nothing.
      else connTimer = setTimeout(() => (el.hidden = false), 1500);
    },
    toast(text) {
      const el = $('toast');
      el.textContent = text;
      el.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (el.hidden = true), Math.min(12_000, 4000 + text.length * 40));
    },
    knock(on) {
      knocking = on;
      doc.title = on && doc.visibilityState !== 'visible' ? '✋ Deskfish needs you' : 'Deskfish';
    },
    showDesktop() {
      const f = frame('desktop');
      f.scrollIntoView({ behavior: 'smooth', block: 'start' });
      f.focus();
    },
    pickFiles(pane, accept) {
      return new Promise((resolve) => {
        const input = win(pane).document.createElement('input');
        input.type = 'file';
        input.multiple = !accept;
        if (accept) input.accept = accept;
        input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true });
        input.addEventListener('cancel', () => resolve([]), { once: true });
        input.click();
      });
    },
    saveBlob(name, blob) {
      const url = URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = name;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    async copy(pane, text) {
      const w = win(pane);
      try {
        await w.navigator.clipboard.writeText(text);
        return true;
      } catch {
        return execCopy(w.document, text);
      }
    },
    async readClipboard(pane) {
      try {
        return await win(pane).navigator.clipboard.readText();
      } catch {
        return undefined;
      }
    },
    async writeClipboard(pane, text) {
      await win(pane).navigator.clipboard.writeText(text);
    },
    openDocs(pane, load) {
      // Opened inside the click, filled when the documentation arrives (a pop-up opened later is blocked).
      const tab = win(pane).open('', '_blank');
      if (!tab) {
        ui.toast('The browser blocked the documentation tab; allow pop-ups for this page.');
        return;
      }
      // The new tab keeps no handle on this page (a site someone types into that tab could otherwise navigate it).
      tab.opener = null;
      load().then(
        (blob) => {
          const url = URL.createObjectURL(blob);
          tab.location.replace(url);
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        },
        (err) => {
          tab.close();
          ui.toast(`Could not open the documentation: ${msg(err)}`);
        },
      );
    },
    async askKey(title) {
      const dialog = $<HTMLDialogElement>('keyDialog');
      $('keyTitle').textContent = title;
      const input = $<HTMLInputElement>('keyInput');
      input.value = '';
      input.onkeydown = (ev) => {
        if (ev.key !== 'Enter') return;
        // Without preventDefault the same Enter would press the button focus returns to, and open the dialog again.
        ev.preventDefault();
        dialog.close('save');
      };
      const how = await run(dialog);
      const value = input.value;
      input.value = '';
      return how === 'save' ? value : undefined;
    },
    async askModel(cfg) {
      const dialog = $<HTMLDialogElement>('modelDialog');
      const select = $<HTMLSelectElement>('preset');
      const detail = $('presetDetail');
      const baseRow = $('baseUrlRow');
      const base = $<HTMLInputElement>('baseUrl');
      const modelRow = $('modelRow');
      const model = $<HTMLInputElement>('model');
      const list = $('modelList');
      const error = $('modelError');
      const current = presetFor(cfg.provider, cfg.baseUrl) ?? (cfg.provider === 'openai-compatible' ? PRESETS.find((p) => p.id === 'custom') : undefined);
      if (!select.options.length) {
        for (const p of PRESETS) {
          const o = doc.createElement('option');
          o.value = p.id;
          o.textContent = p.label;
          select.appendChild(o);
        }
      }
      const preset = () => PRESETS.find((p) => p.id === select.value) ?? PRESETS[0];
      const show = () => {
        const p = preset();
        const isCurrent = p.id === current?.id;
        detail.textContent = p.detail;
        baseRow.hidden = !p.askBaseUrl;
        base.value = p.askBaseUrl ? (isCurrent ? cfg.baseUrl : 'https://') : '';
        modelRow.hidden = p.provider === 'mock';
        list.replaceChildren(
          ...p.models.map((m) => {
            const o = doc.createElement('option');
            o.value = m.name;
            if (m.note) o.label = m.note;
            return o;
          }),
        );
        model.value = isCurrent ? cfg.model : (p.models[0]?.name ?? '');
        error.hidden = true;
      };
      select.value = current?.id ?? PRESETS[0].id;
      show();
      select.onchange = show;
      const form = dialog.querySelector('form')!;
      const validate = (ev: SubmitEvent) => {
        if ((ev.submitter as HTMLButtonElement | null)?.value !== 'save') return;
        const p = preset();
        const problem = p.askBaseUrl && !/^https?:\/\/\S+/.test(base.value.trim()) ? 'Enter a base URL starting with http:// or https://' : p.provider !== 'mock' && !model.value.trim() ? 'Enter a model name' : '';
        if (problem) {
          ev.preventDefault();
          error.textContent = problem;
          error.hidden = false;
        }
      };
      form.addEventListener('submit', validate);
      const how = await run(dialog);
      form.removeEventListener('submit', validate);
      if (how !== 'save') return undefined;
      const p = preset();
      return { preset: p, provider: p.provider, baseUrl: p.askBaseUrl ? base.value.trim().replace(/\/+$/, '') : p.baseUrl, model: p.provider === 'mock' ? (p.models[0]?.name ?? 'mock') : model.value.trim() };
    },
    async confirm(text, action) {
      const dialog = $<HTMLDialogElement>('confirmDialog');
      $('confirmText').textContent = text;
      $('confirmOk').textContent = action;
      return (await run(dialog)) === 'ok';
    },
    showLog(lines, onClose) {
      const dialog = $<HTMLDialogElement>('logDialog');
      const pre = $('logText');
      pre.textContent = lines.length ? `${lines.join('\n')}\n` : '(the log is empty)\n';
      dialog.addEventListener('close', onClose, { once: true });
      dialog.showModal();
      pre.scrollTop = pre.scrollHeight;
      return (line) => {
        const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
        pre.textContent += `${line}\n`;
        if (atEnd) pre.scrollTop = pre.scrollHeight;
      };
    },
    reload: () => location.reload(),
  };
  return ui;
}

/**
 * Runs in the page's first script, before the two views exist: the token from `?token=` (then kept
 * in this browser) or from what the sign-in page stored; the address bar loses the query and the
 * form post (a reload is a plain GET, which the sign-in page answers); `window.deskfishHost` is there
 * for the views' `acquireVsCodeApi()`.
 */
export function boot(): void {
  const params = new URLSearchParams(location.search);
  let token = params.get('token') ?? '';
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else token = localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    /* storage refused (a private window's policy): the token lives as long as the page */
  }
  history.replaceState(null, '', location.pathname);
  const ui = browserUi(document);
  const ws = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = `token=${encodeURIComponent(token)}`;
  const host = new WebHost({
    wsUrl: `${ws}//${location.host}/ws?${q}`,
    vncUrl: `${ws}//${location.host}/vnc?${q}`,
    token,
    openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    post: (pane, message) => (document.getElementById(pane) as HTMLIFrameElement | null)?.contentWindow?.postMessage(message, '*'),
    fetch: (url, init) => fetch(url, init),
    ui,
  });
  (window as unknown as { deskfishHost: WebHost }).deskfishHost = host;
  document.addEventListener('visibilitychange', () => host.visibility());
  // The title bar (VS Code has these in the view's title bar and as commands): the panels open inside the chat view; New chat's answer is `reset`.
  // Looked up when used: this script runs before the page's body exists.
  const showMenu = (open: boolean) => {
    const menu = document.getElementById('menu');
    if (!menu) return;
    menu.hidden = !open;
    document.getElementById('menuBtn')?.setAttribute('aria-expanded', String(open));
    if (open) (menu.querySelector('button') as HTMLElement | null)?.focus();
  };
  const menuOpen = () => document.getElementById('menu')?.hidden === false;
  const PANELS: Record<string, PanelName> = { history: 'history', schedules: 'schedules', settings: 'settings', files: 'files' };
  document.addEventListener('click', (ev) => {
    const target = ev.target as Element | null;
    const button = target?.closest?.('button');
    if (button?.id === 'menuBtn') return showMenu(!menuOpen());
    const item = target?.closest?.('[data-menu]') as HTMLElement | null;
    if (menuOpen() && !item) showMenu(false);
    if (item) {
      showMenu(false);
      const what = item.dataset.menu;
      if (what === 'reflect') void host.reflectNow();
      else if (what === 'export') void host.exportMemory();
      else if (what === 'import') void ui.pickFiles('page', 'application/json,.json').then((files) => host.importMemory(files));
      else if (what === 'deleteChats') void host.deleteAllChats();
      else if (what === 'log') void host.showLog();
      else if (what === 'docs') host.openDocs('page');
      return;
    }
    if (button?.id === 'newChat') host.newChat();
    else if (button && PANELS[button.id]) host.openPanel(PANELS[button.id]);
  });
  // A click inside a view does not reach this document; the page losing focus to it closes the menu.
  window.addEventListener('blur', () => showMenu(false));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && menuOpen()) showMenu(false);
  });
  host.start();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof location !== 'undefined') boot();
