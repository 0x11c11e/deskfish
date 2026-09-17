import type { AgentEvent, AgentStatus } from '../src/agent/loop';
import { PRESETS, isLocalEndpoint, keySlotFor, presetFor, type Preset } from '../src/agent/presets';
import { WEEKDAYS, inAnHour, parseBudget, whenFromFields, type WhenFields } from '../src/agent/scheduleForm';
import { formatSize, safeFileName } from '../src/desktop/files';
import type { DesktopStatus } from '../src/desktop/supervisor';
import type { DeskfishConfig } from '../src/gateway/config';
import { patchBetween } from '../src/gateway/configSync';
import { GROUP_TITLES, settingLabel, type SettingsEntry, type SettingsSchema } from '../src/gateway/settingsSchema';
import { EVENT_NAMES, MAX_TRANSFER, type CommandArgs, type CommandName, type CommandResult, type DesktopView, type EventName, type Events, type Snapshot } from '../src/gateway/protocol';
import { VERSION } from '../src/gateway/version';
import type { DesktopFile, FromChat, FromDesktop, ToChat, ToDesktop, UiConfig } from '../src/webview/protocol';

/**
 * The web page's stand-in for VS Code. The chat and the Desktop view run their webview bundles
 * unchanged, each in an `<iframe srcdoc>` whose `acquireVsCodeApi()` returns `WebHost.api(pane)`:
 * what a view posts (`FromChat`, `FromDesktop`) becomes a command over the gateway's WebSocket, and
 * the gateway's snapshot and events become the messages the views already understand (`ToChat`,
 * `ToDesktop`) — the work `ChatViewProvider`, `DesktopPanel` and the controller do in VS Code. What
 * only VS Code had gets a browser version: a file input and `POST /files` for attach, a download of
 * `GET /files/…` for save, `navigator.clipboard` for copy, `/docs` in a new tab, small dialogs for the
 * model and the key, the log in a dialog, a toast instead of a popup — and what VS Code has as its
 * settings editor and schedule commands: a Settings dialog over the gateway's `config.schema`, and a
 * Schedules dialog.
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
    const chat: ToChat[] = [{ type: 'newChat' }];
    if (s.chat.length) chat.push({ type: 'replay', title: '', items: s.chat, live: true });
    if (s.usage) chat.push({ type: 'event', event: s.usage });
    if (s.screenshot) chat.push({ type: 'event', event: { type: 'screenshot', step: s.screenshot.step, jpegBase64: '', width: s.screenshot.width, height: s.screenshot.height } });
    // A finished run's status line is already in the transcript; only a live one is re-announced.
    if (s.status === 'running' || s.status === 'paused') chat.push({ type: 'event', event: { type: 'status', status: s.status, message: s.statusMessage, ...(s.screenFree ? { screenFree: true } : {}) } });
    chat.push({ type: 'desktop', status: s.desktop.status }, ...this.configMessage());
    return { chat, desktop: this.desktopState() };
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

/** The view messages that are plain gateway commands; the rest (dialogs, files, clipboard, docs) are the page's own work. */
export function viewCommand(pane: Pane, m: FromChat | FromDesktop): { cmd: CommandName; args?: Record<string, unknown>; what: string } | undefined {
  const files = (a?: DesktopFile[]) => (a?.length ? { attachments: a.map((f) => ({ name: f.name, path: f.path, size: f.size })) } : {});
  if (pane === 'chat') {
    const c = m as FromChat;
    switch (c.type) {
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

/* ---------- settings and schedules: the pure parts of the two dialogs ---------- */

/** What a settings field holds in the form: its text, or a checkbox's state. */
export type FieldInput = string | boolean;

/** Settings shown as a password field. */
export const SECRET_SETTINGS = new Set<keyof DeskfishConfig>(['daemonToken', 'vncPassword']);

/** Trimmed on save, as VS Code reads them. */
const TRIMMED_SETTINGS = new Set<keyof DeskfishConfig>(['userName', 'anthropicWorkspaceId']);

/** A field's value as the form shows it. */
export function fieldInput(e: SettingsEntry, cfg: DeskfishConfig): FieldInput {
  const v = cfg[e.key];
  if (e.type === 'boolean') return v === true;
  return v === null || v === undefined ? '' : String(v);
}

/** A field's value for the config, or why it cannot be one (an empty number means null only where null is allowed). */
export function readField(e: SettingsEntry, raw: FieldInput): { value: string | number | boolean | null } | { error: string } {
  if (e.type === 'boolean') return { value: raw === true };
  const text = String(raw);
  if (e.type === 'number') {
    if (!text.trim()) return e.nullable ? { value: null } : { error: 'Enter a number.' };
    const n = Number(text);
    return Number.isFinite(n) ? { value: n } : { error: 'Enter a number.' };
  }
  if (e.enum && !e.enum.includes(text)) return { error: `Pick one of: ${e.enum.map((x) => x || 'default').join(', ')}.` };
  return { value: TRIMMED_SETTINGS.has(e.key) ? text.trim() : text };
}

/** The gateway refused a setting: which one (from "bad value for X" / "unknown setting: X") and its words. */
export interface SettingsRefusal {
  key?: keyof DeskfishConfig;
  message: string;
}

export function refusalOf(error: string): SettingsRefusal {
  const m = /(?:bad value for|unknown setting:) (\w+)/.exec(error);
  return m ? { key: m[1] as keyof DeskfishConfig, message: `Not accepted: ${error}.` } : { message: error };
}

/** The schedule form, as the person filled it in. */
export interface ScheduleForm extends WhenFields {
  task: string;
  autonomy: 'free' | 'guided';
  /** Empty: the setting's budget. */
  budget: string;
}

export interface ScheduleRow {
  id: string;
  /** The gateway's own line: when, the task, next, the fence, the last outcome. */
  line: string;
}

/** The two answers of "How much should she decide on her own", with VS Code's words. */
export const AUTONOMY_DETAILS: Record<'guided' | 'free', string> = {
  guided: 'She asks before anything irreversible and uses no credentials you did not give her — the safer choice for a run nobody is watching.',
  free: 'The tank is the boundary: she may use any account or login in it and finishes what you asked.',
};

export interface ScheduleActions {
  /** A line under the budget field: what an empty budget means now. */
  budgetHint: string;
  add(form: ScheduleForm): Promise<{ error: string } | { done: string }>;
  /** Resolves with the reason when it failed. */
  remove(id: string): Promise<string | undefined>;
  runNow(id: string): Promise<void>;
}

/** The open Schedules dialog, as the host keeps it current. */
export interface SchedulesView {
  rows(list: ScheduleRow[]): void;
  note(text: string, tone?: 'error' | 'ok'): void;
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
  pickFiles(pane: Pane): Promise<File[]>;
  saveBlob(name: string, blob: Blob): void;
  copy(pane: Pane, text: string): Promise<boolean>;
  readClipboard(pane: Pane): Promise<string | undefined>;
  writeClipboard(pane: Pane, text: string): Promise<void>;
  openDocs(pane: Pane, load: () => Promise<Blob>): void;
  askKey(title: string): Promise<string | undefined>;
  askModel(config: DeskfishConfig): Promise<ModelChoice | undefined>;
  /** The settings dialog: `save` gets every field's value and answers a refusal, or nothing when it is saved (the dialog closes). */
  editSettings(schema: SettingsSchema, config: DeskfishConfig, save: (values: DeskfishConfig) => Promise<SettingsRefusal | undefined>): Promise<void>;
  /** The schedules dialog; `onClose` when the person closes it. */
  showSchedules(actions: ScheduleActions, onClose: () => void): SchedulesView;
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
  private schema?: SettingsSchema;
  private schedules?: SchedulesView;

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
    if (name === 'schedule') void this.refreshSchedules();
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
    const command = viewCommand(pane, m);
    if (command) {
      void this.attempt(command.what, this.call(command.cmd, command.args as never));
      return;
    }
    if (pane === 'chat') void this.fromChat(m as FromChat);
    else this.fromDesktop(m as FromDesktop);
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
      case 'showLog': {
        const lines = await this.attempt('read the log', this.call('log.tail', { lines: 400 }));
        this.logLine = ui.showLog(lines ?? [], () => (this.logLine = undefined));
        break;
      }
      case 'openDocs':
        ui.openDocs('chat', async () => {
          const res = await this.env.fetch('/docs', { headers: { authorization: `Bearer ${this.env.token}` } });
          if (!res.ok) throw new Error(`the documentation is not there (HTTP ${res.status})`);
          return res.blob();
        });
        break;
      case 'copy':
        await ui.copy('chat', m.text);
        break;
      case 'installRuntime': {
        const rt = this.mirror.desktop.runtime;
        const command = rt?.cli === 'none' ? rt.install.command : undefined;
        if (!command) break;
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

  /** The page's Settings button: the dialog over the gateway's schema, filled from the config the page already has. */
  async openSettings(): Promise<void> {
    const cfg = this.mirror.config;
    if (!cfg) return;
    this.schema ??= await this.attempt('read the settings', this.call('config.schema'));
    if (!this.schema) return;
    await this.env.ui.editSettings(this.schema, cfg, (values) => this.saveSettings(cfg, values));
  }

  /**
   * Save in the settings dialog: only what the person changed since the dialog opened goes out (a value
   * another client set meanwhile is not sent back), never the model's three keys (the model dialog's).
   * The header re-renders from the `config` event, as for any client's change.
   */
  async saveSettings(opened: DeskfishConfig, values: DeskfishConfig): Promise<SettingsRefusal | undefined> {
    const keys = (this.schema ?? []).filter((e) => e.group !== 'model').map((e) => e.key);
    const patch = patchBetween(opened, values, keys);
    if (!Object.keys(patch).length) return undefined;
    try {
      await this.call('config.set', { patch });
      return undefined;
    } catch (err) {
      return refusalOf(msg(err));
    }
  }

  /** The page's Schedules button. */
  async openSchedules(): Promise<void> {
    if (this.schedules || !this.mirror.config) return;
    const setting = this.mirror.config.unattendedMaxCostUsd;
    this.schedules = this.env.ui.showSchedules(
      {
        budgetHint: `Empty: the Unattended Max Cost Usd setting (${setting > 0 ? `$${setting.toFixed(2)}` : 'no budget'}). 0 = no budget. A budget acts where the model has a known price or reports its cost.`,
        add: (form) => this.addSchedule(form),
        remove: (id) => this.call('schedules.remove', { id }).then(() => this.refreshSchedules().then(() => undefined), (err) => msg(err)),
        runNow: (id) => this.runScheduleNow(id),
      },
      () => (this.schedules = undefined),
    );
    await this.refreshSchedules();
  }

  private async refreshSchedules(): Promise<void> {
    const view = this.schedules;
    if (!view) return;
    try {
      const r = await this.call('schedules.list');
      view.rows(r.schedules.map((s, i) => ({ id: s.id, line: r.lines[i] ?? s.task })));
    } catch (err) {
      view.note(`Could not list the scheduled tasks: ${msg(err)}`, 'error');
    }
  }

  /** Add from the form: the same questions as VS Code's "Schedule a Task…", checked here first and by the gateway again. */
  async addSchedule(form: ScheduleForm): Promise<{ error: string } | { done: string }> {
    const when = whenFromFields(form);
    if ('error' in when) return when;
    const task = form.task.trim();
    if (!task) return { error: 'Say what she should do.' };
    const budget = parseBudget(form.budget);
    if (budget === 'bad') return { error: 'The budget is a number of dollars, 0 or more — or empty for the setting.' };
    try {
      const s = await this.call('schedules.add', { task, when: when.when, autonomy: form.autonomy, ...(budget !== undefined ? { maxCostUsd: budget } : {}) });
      const r = await this.call('schedules.list');
      this.schedules?.rows(r.schedules.map((x, i) => ({ id: x.id, line: r.lines[i] ?? x.task })));
      const line = r.lines[r.schedules.findIndex((x) => x.id === s.id)];
      return { done: `Added: ${line ?? s.task}` };
    } catch (err) {
      return { error: `Could not schedule: ${msg(err)}` };
    }
  }

  /** "Run now": a person asked, so it runs attended, in its own chat — or after the current task. */
  async runScheduleNow(id: string): Promise<void> {
    const busy = this.mirror.status === 'running' || this.mirror.status === 'paused';
    const done = await this.attempt('run the scheduled task', this.call('schedules.runNow', { id }));
    if (done !== undefined && busy) this.env.ui.toast('She is busy; the task will run when she is free.');
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
  const win = (pane: Pane): Window => frame(pane)?.contentWindow ?? window;
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
    pickFiles(pane) {
      return new Promise((resolve) => {
        const input = win(pane).document.createElement('input');
        input.type = 'file';
        input.multiple = true;
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
    editSettings(schema, cfg, save) {
      const dialog = $<HTMLDialogElement>('settingsDialog');
      const body = $('settingsFields');
      const note = $('settingsNote');
      const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.actions button'));
      const saveButton = buttons.find((b) => b.value === 'save')!;
      const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
        const e = doc.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined) e.textContent = text;
        return e;
      };
      type Field = { entry: SettingsEntry; get: () => FieldInput; control: HTMLElement; box: HTMLElement; error: HTMLElement };
      const fields: Field[] = [];
      const render = (e: SettingsEntry): HTMLElement => {
        const box = el('div', 'field');
        const id = `setting-${e.key}`;
        const error = el('p', 'hint error');
        error.hidden = true;
        let control: HTMLInputElement | HTMLSelectElement;
        let get: () => FieldInput;
        if (e.type === 'boolean') {
          const input = el('input');
          input.type = 'checkbox';
          input.id = id;
          input.checked = fieldInput(e, cfg) === true;
          const label = el('label', 'check');
          label.append(input, doc.createTextNode(settingLabel(e.setting)));
          box.append(label);
          control = input;
          get = () => input.checked;
        } else {
          const label = el('label', undefined, settingLabel(e.setting));
          label.htmlFor = id;
          label.append(el('span', 'setting-id', e.setting));
          box.append(label);
          if (e.enum) {
            const select = el('select');
            e.enum.forEach((v, i) => {
              const o = el('option', undefined, v || 'default');
              o.value = v;
              if (e.enumDescriptions?.[i]) o.title = e.enumDescriptions[i];
              select.append(o);
            });
            select.value = String(fieldInput(e, cfg));
            control = select;
            get = () => select.value;
          } else {
            const input = el('input');
            input.type = e.type === 'number' ? 'number' : SECRET_SETTINGS.has(e.key) ? 'password' : 'text';
            if (e.type === 'number') {
              input.step = 'any';
              if (e.minimum !== undefined) input.min = String(e.minimum);
              if (e.maximum !== undefined) input.max = String(e.maximum);
            }
            if (e.nullable) input.placeholder = 'not set';
            input.autocomplete = 'off';
            input.spellcheck = false;
            input.value = String(fieldInput(e, cfg));
            control = input;
            get = () => input.value;
          }
          control.id = id;
          box.append(control);
        }
        box.append(error);
        if (e.description) box.append(el('p', 'hint', e.description));
        if (e.enumDescriptions && control instanceof HTMLSelectElement) {
          const select = control;
          const which = el('p', 'hint');
          const show = () => (which.textContent = e.enumDescriptions![e.enum!.indexOf(select.value)] ?? '');
          select.addEventListener('change', show);
          show();
          box.append(which);
        }
        fields.push({ entry: e, get, control, box, error });
        return box;
      };
      const sections: HTMLElement[] = [];
      for (const group of ['work', 'desktop', 'advanced'] as const) {
        const entries = schema.filter((e) => e.group === group);
        if (!entries.length) continue;
        const section = group === 'advanced' ? el('details', 'group') : el('section');
        section.append(group === 'advanced' ? el('summary', undefined, GROUP_TITLES[group]) : el('h3', undefined, GROUP_TITLES[group]));
        for (const e of entries) section.append(render(e));
        sections.push(section);
      }
      body.replaceChildren(...sections);
      body.scrollTop = 0;
      note.textContent = '';
      note.className = 'hint note';
      const refuse = (f: Field, text: string) => {
        f.error.textContent = text;
        f.error.hidden = false;
        f.box.classList.add('refused');
        const folded = f.box.closest('details');
        if (folded) folded.open = true;
        f.control.focus();
        f.box.scrollIntoView({ block: 'nearest' });
      };
      let saving = false;
      const submit = async () => {
        if (saving) return;
        for (const f of fields) {
          f.error.hidden = true;
          f.box.classList.remove('refused');
        }
        note.textContent = '';
        note.className = 'hint note';
        const values: Record<string, unknown> = { ...cfg };
        let bad: Field | undefined;
        for (const f of fields) {
          const r = readField(f.entry, f.get());
          if ('error' in r) {
            if (!bad) bad = f;
            f.error.textContent = r.error;
            f.error.hidden = false;
            f.box.classList.add('refused');
          } else values[f.entry.key] = r.value;
        }
        if (bad) return refuse(bad, bad.error.textContent ?? '');
        saving = true;
        saveButton.disabled = true;
        note.textContent = 'Saving…';
        const refusal = await save(values as unknown as DeskfishConfig).catch((err): SettingsRefusal => ({ message: msg(err) }));
        saving = false;
        saveButton.disabled = false;
        note.textContent = '';
        if (!refusal) {
          dialog.close('save');
          return;
        }
        const f = refusal.key ? fields.find((x) => x.entry.key === refusal.key) : undefined;
        if (f) refuse(f, refusal.message);
        else {
          note.textContent = refusal.message;
          note.className = 'hint note error';
        }
      };
      return new Promise<void>((resolve) => {
        for (const b of buttons) b.onclick = () => (b.value === 'save' ? void submit() : dialog.close(b.value));
        // No <form> (a password field in a form makes the browser offer to keep it as a login): Enter in a field saves.
        dialog.onkeydown = (ev) => {
          const t = ev.target as HTMLElement;
          if (ev.key === 'Enter' && t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox') {
            ev.preventDefault();
            void submit();
          }
        };
        dialog.addEventListener(
          'close',
          () => {
            dialog.onkeydown = null;
            body.replaceChildren();
            resolve();
          },
          { once: true },
        );
        dialog.showModal();
      });
    },
    showSchedules(actions, onClose) {
      const dialog = $<HTMLDialogElement>('schedulesDialog');
      const list = $('scheduleList');
      const empty = $('scheduleEmpty');
      const note = $('schedNote');
      const kind = $<HTMLSelectElement>('schedKind');
      const at = $<HTMLInputElement>('schedAt');
      const day = $<HTMLSelectElement>('schedDay');
      const time = $<HTMLInputElement>('schedTime');
      const minutes = $<HTMLInputElement>('schedMinutes');
      const task = $<HTMLTextAreaElement>('schedTask');
      const autonomy = $<HTMLSelectElement>('schedAutonomy');
      const budget = $<HTMLInputElement>('schedBudget');
      if (!day.options.length) {
        WEEKDAYS.forEach((name, i) => {
          const o = doc.createElement('option');
          o.value = String(i);
          o.textContent = name;
          day.append(o);
        });
      }
      const setNote = (text: string, tone?: 'error' | 'ok') => {
        note.textContent = text;
        note.className = `hint note${tone ? ` ${tone}` : ''}`;
      };
      const showKind = () => {
        const k = kind.value;
        $('schedAtRow').hidden = k !== 'once';
        $('schedDayRow').hidden = k !== 'weekly';
        $('schedTimeRow').hidden = k !== 'daily' && k !== 'weekly';
        $('schedEveryRow').hidden = k !== 'every';
      };
      const showAutonomy = () => ($('schedAutonomyDetail').textContent = AUTONOMY_DETAILS[autonomy.value === 'free' ? 'free' : 'guided']);
      kind.value = 'once';
      at.value = inAnHour();
      day.value = '1';
      time.value = '09:00';
      minutes.value = '60';
      task.value = '';
      autonomy.value = 'guided';
      budget.value = '';
      $('schedBudgetHint').textContent = actions.budgetHint;
      kind.onchange = showKind;
      autonomy.onchange = showAutonomy;
      showKind();
      showAutonomy();
      setNote('');
      list.replaceChildren();
      empty.hidden = true;
      const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.actions button'));
      const addButton = buttons.find((b) => b.value === 'add')!;
      const add = async () => {
        addButton.disabled = true;
        setNote('');
        const r = await actions.add({ kind: kind.value as ScheduleForm['kind'], at: at.value, day: day.value, time: time.value, minutes: minutes.value, task: task.value, autonomy: autonomy.value === 'free' ? 'free' : 'guided', budget: budget.value });
        addButton.disabled = false;
        if ('error' in r) return setNote(r.error, 'error');
        // The next schedule starts from the defaults again (guided, the setting's budget); when and how often stay.
        task.value = '';
        budget.value = '';
        autonomy.value = 'guided';
        showAutonomy();
        setNote(r.done, 'ok');
      };
      for (const b of buttons) b.onclick = () => (b.value === 'add' ? void add() : dialog.close());
      dialog.addEventListener('close', onClose, { once: true });
      dialog.showModal();
      return {
        rows(rows) {
          empty.hidden = rows.length > 0;
          list.replaceChildren(
            ...rows.map((row) => {
              const li = doc.createElement('li');
              const line = doc.createElement('span');
              line.className = 'line';
              line.textContent = row.line;
              const run = doc.createElement('button');
              run.type = 'button';
              run.textContent = 'Run now';
              // The chat shows the run: the dialog gets out of the way.
              run.onclick = () => {
                dialog.close();
                void actions.runNow(row.id);
              };
              const remove = doc.createElement('button');
              remove.type = 'button';
              remove.textContent = 'Remove';
              // Asked once, inside the dialog (a browser confirm() would block the page).
              remove.onclick = async () => {
                if (!remove.classList.contains('confirm')) {
                  remove.classList.add('confirm');
                  remove.textContent = 'Remove?';
                  return;
                }
                remove.disabled = true;
                const failed = await actions.remove(row.id);
                if (failed) {
                  remove.disabled = false;
                  setNote(`Could not remove it: ${failed}`, 'error');
                }
              };
              li.append(line, run, remove);
              return li;
            }),
          );
        },
        note: setNote,
      };
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
  const ws = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = `token=${encodeURIComponent(token)}`;
  const host = new WebHost({
    wsUrl: `${ws}//${location.host}/ws?${q}`,
    vncUrl: `${ws}//${location.host}/vnc?${q}`,
    token,
    openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    post: (pane, message) => (document.getElementById(pane) as HTMLIFrameElement | null)?.contentWindow?.postMessage(message, '*'),
    fetch: (url, init) => fetch(url, init),
    ui: browserUi(document),
  });
  (window as unknown as { deskfishHost: WebHost }).deskfishHost = host;
  document.addEventListener('visibilitychange', () => host.visibility());
  // The page's own buttons (VS Code has New chat in the view's title bar, settings and schedules as commands); New chat's answer is `reset`.
  document.addEventListener('click', (ev) => {
    const target = ev.target as Element | null;
    if (target?.closest?.('#newChat')) host.newChat();
    else if (target?.closest?.('#settings')) void host.openSettings();
    else if (target?.closest?.('#schedules')) void host.openSchedules();
  });
  host.start();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof location !== 'undefined') boot();
