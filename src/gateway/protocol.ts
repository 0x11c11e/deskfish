import type { ReplayItem } from '../agent/chats';
import type { AgentEvent, AgentStatus } from '../agent/loop';
import type { Schedule, When } from '../agent/schedule';
import type { NewDownload } from '../desktop/files';
import type { RuntimeStatus } from '../desktop/runtime';
import type { DesktopStatus } from '../desktop/supervisor';
import type { DesktopFile } from '../webview/protocol';
import type { DeskfishConfig } from './config';
import type { MemoryBundle } from './service';
import type { SettingsSchema } from './settingsSchema';

/**
 * The wire between the gateway and its clients (VS Code, the web page, the CLI): JSON over a
 * WebSocket at `/ws`. A client sends `{id, cmd, args}`; the gateway answers `{id, ok: true, result}`
 * or `{id, ok: false, error}`. Events are pushed to every client that said `hello`, as
 * `{event, data}`, in the order the service fired them. No `vscode` import.
 */

export const PROTOCOL = 1;
export const DEFAULT_PORT = 9980;
/** Largest WebSocket frame; bigger files go through `POST /files`. */
export const MAX_FRAME = 64 * 1024 * 1024;
/** Largest file copied into or out of the tank. */
export const MAX_TRANSFER = 100 * 1024 * 1024;

export type ClientKind = 'vscode' | 'web' | 'cli';

/**
 * A run request. `unattended` marks a run nobody asked for and nobody is watching (a schedule,
 * later a wake): the gateway gives it the fence — `guided` and a cost ceiling from `maxCostUsd`
 * or `deskfish.unattendedMaxCostUsd`. `reason` says what started it.
 */
export interface RunRequest {
  task: string;
  attachments?: DesktopFile[];
  unattended?: boolean;
  maxCostUsd?: number;
  reason?: string;
}

export interface ChatInfo {
  name: string;
  /** YYYY-MM-DD HH:MM */
  startedAt: string;
  firstTask: string;
  bytes: number;
}

/** Files a client may read (and, the first two, write) through `memory.read` / `memory.write` and the read commands. */
export type EditableFile = 'memory.md' | 'charter.md';

export interface DesktopView {
  status: DesktopStatus;
  networkMode?: 'isolated' | 'host';
}

/** What a client needs to render the present exactly as a client that watched from the start. */
export interface Snapshot {
  name: 'deskfish';
  version: string;
  protocol: number;
  dataDir: string;
  status: AgentStatus;
  statusMessage?: string;
  screenFree: boolean;
  busy: boolean;
  queued: number;
  /** The current chat as the sidebar renders a transcript (empty after New chat). */
  chat: ReplayItem[];
  /** Usage totals of the current chat, as one usage event. */
  usage?: Extract<AgentEvent, { type: 'usage' }>;
  /** The latest screenshot of the running desktop (for the Desktop tab's placeholder and the step counter). */
  screenshot?: { dataUrl: string; width: number; height: number; step: number };
  desktop: DesktopView;
  config: DeskfishConfig;
  /** The gateway has a `config.json` (found at start or written since): false only before the first client seeded it. */
  configSaved: boolean;
  /** Slots that hold an API key (names only). */
  keys: string[];
}

/** Every command: [args, result]. */
export interface Commands {
  hello: [{ client: ClientKind; version: string }, Snapshot];
  snapshot: [Record<string, never>, Snapshot];
  run: [RunRequest, null];
  say: [{ text: string; attachments?: DesktopFile[] }, null];
  pause: [Record<string, never>, null];
  resume: [Record<string, never>, null];
  stop: [Record<string, never>, null];
  newChat: [Record<string, never>, null];
  reflect: [Record<string, never>, 'busy' | 'started' | 'failed'];
  /** Turn the desktop on if it is off; true when it is usable. */
  'desktop.on': [Record<string, never>, boolean];
  /** Stop a running task, then the desktop. */
  'desktop.off': [Record<string, never>, null];
  'desktop.restart': [Record<string, never>, null];
  'desktop.toggle': [Record<string, never>, null];
  /** The desktop's status; `refresh` probes the daemon first. */
  'desktop.status': [{ refresh?: boolean }, DesktopView];
  'desktop.detectRuntime': [Record<string, never>, RuntimeStatus];
  /** This client wants the 15 s health poll while it shows the desktop's state. */
  'desktop.poll': [{ on: boolean }, null];
  'files.upload': [{ name: string; base64: string }, DesktopFile];
  'files.list': [Record<string, never>, DesktopFile[]];
  /** Bot desktop → client clipboard: the text when it is new, else null. */
  'clipboard.get': [{ hint?: string }, string | null];
  'clipboard.set': [{ text: string }, boolean];
  releaseInput: [Record<string, never>, null];
  'config.get': [Record<string, never>, DeskfishConfig];
  'config.set': [{ patch: Partial<DeskfishConfig> }, DeskfishConfig];
  /** The settings dialog's fields, from the gateway's own package.json (never `deskfish.gateway.*`). */
  'config.schema': [Record<string, never>, SettingsSchema];
  /** An empty key clears the slot. Returns the slots that hold a key. */
  'key.set': [{ slot: string; key: string }, string[]];
  'key.status': [Record<string, never>, string[]];
  'model.set': [{ provider: DeskfishConfig['provider']; model: string; baseUrl: string }, DeskfishConfig];
  'schedules.list': [Record<string, never>, { schedules: Schedule[]; lines: string[] }];
  /** `autonomy` and `maxCostUsd` are the fence on the runs this schedule starts unattended; both optional (guided, `deskfish.unattendedMaxCostUsd`). */
  'schedules.add': [{ task: string; when: When; autonomy?: 'free' | 'guided'; maxCostUsd?: number }, Schedule];
  'schedules.remove': [{ id: string }, null];
  'schedules.runNow': [{ id: string }, null];
  'memory.read': [{ file: EditableFile }, { text: string; facts: number }];
  'memory.write': [{ file: EditableFile; text: string }, null];
  /** Forget every fact; returns how many there were. */
  'memory.clearFacts': [Record<string, never>, number];
  /** Her self page, with the line on who wrote it and whether the signature holds. */
  'self.read': [Record<string, never>, string];
  'journal.read': [Record<string, never>, string];
  'playbook.read': [Record<string, never>, string];
  'chats.list': [Record<string, never>, ChatInfo[]];
  'chats.read': [{ name: string }, string];
  /** Delete every past chat; returns how many there were. */
  'chats.delete': [Record<string, never>, number];
  /** Reopen a past chat in the sidebar; the next task continues it. */
  'chats.continue': [{ name: string }, null];
  export: [Record<string, never>, MemoryBundle];
  import: [{ bundle: MemoryBundle }, null];
  'log.tail': [{ lines?: number }, string[]];
  /** Stop the gateway process (the tank keeps running). */
  shutdown: [Record<string, never>, null];
}

export type CommandName = keyof Commands;
export type CommandArgs<K extends CommandName> = Commands[K][0];
export type CommandResult<K extends CommandName> = Commands[K][1];

export interface Request<K extends CommandName = CommandName> {
  id: number;
  cmd: K;
  args?: CommandArgs<K>;
}

export type Reply = { id: number | null; ok: true; result: unknown } | { id: number | null; ok: false; error: string };

/** Events pushed to clients: the service's own (see `DeskfishService`) plus the gateway's. */
export interface Events {
  event: AgentEvent;
  desktop: DesktopStatus;
  task: { text: string };
  notice: { text: string };
  schedule: { kind: 'fired' | 'missed'; text: string; task: string; dueAt?: number; auto: boolean };
  reset: undefined;
  replay: { title: string; items: ReplayItem[] };
  download: NewDownload;
  config: DeskfishConfig;
  keys: string[];
  /** A line of the gateway's log (already masked where the service masks). */
  log: string;
  'desktop.hostNetwork': undefined;
  'desktop.startFailed': string;
  'desktop.stopFailed': string;
}

export type EventName = keyof Events;
export const EVENT_NAMES: EventName[] = ['event', 'desktop', 'task', 'notice', 'schedule', 'reset', 'replay', 'download', 'config', 'keys', 'log', 'desktop.hostNetwork', 'desktop.startFailed', 'desktop.stopFailed'];

export interface EventFrame<K extends EventName = EventName> {
  event: K;
  data: Events[K];
}

/* ---------- validation (hand-written: unknown commands, unknown fields and wrong types are refused) ---------- */

type Field = 'string' | 'string?' | 'number?' | 'boolean' | 'boolean?' | 'object' | 'files?' | 'when' | 'editable' | 'client' | 'provider' | 'autonomy?';

const NONE: Record<string, Field> = {};
const SPEC: { [K in CommandName]: Record<string, Field> } = {
  hello: { client: 'client', version: 'string' },
  snapshot: NONE,
  run: { task: 'string', attachments: 'files?', unattended: 'boolean?', maxCostUsd: 'number?', reason: 'string?' },
  say: { text: 'string', attachments: 'files?' },
  pause: NONE,
  resume: NONE,
  stop: NONE,
  newChat: NONE,
  reflect: NONE,
  'desktop.on': NONE,
  'desktop.off': NONE,
  'desktop.restart': NONE,
  'desktop.toggle': NONE,
  'desktop.status': { refresh: 'boolean?' },
  'desktop.detectRuntime': NONE,
  'desktop.poll': { on: 'boolean' },
  'files.upload': { name: 'string', base64: 'string' },
  'files.list': NONE,
  'clipboard.get': { hint: 'string?' },
  'clipboard.set': { text: 'string' },
  releaseInput: NONE,
  'config.get': NONE,
  'config.set': { patch: 'object' },
  'config.schema': NONE,
  'key.set': { slot: 'string', key: 'string' },
  'key.status': NONE,
  'model.set': { provider: 'provider', model: 'string', baseUrl: 'string' },
  'schedules.list': NONE,
  'schedules.add': { task: 'string', when: 'when', autonomy: 'autonomy?', maxCostUsd: 'number?' },
  'schedules.remove': { id: 'string' },
  'schedules.runNow': { id: 'string' },
  'memory.read': { file: 'editable' },
  'memory.write': { file: 'editable', text: 'string' },
  'memory.clearFacts': NONE,
  'self.read': NONE,
  'journal.read': NONE,
  'playbook.read': NONE,
  'chats.list': NONE,
  'chats.read': { name: 'string' },
  'chats.delete': NONE,
  'chats.continue': { name: 'string' },
  export: NONE,
  import: { bundle: 'object' },
  'log.tail': { lines: 'number?' },
  shutdown: NONE,
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fieldOk(type: Field, v: unknown): boolean {
  if (v === undefined) return type.endsWith('?');
  switch (type.replace('?', '')) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return isObject(v);
    case 'files':
      return Array.isArray(v) && v.length <= 100 && v.every((f) => isObject(f) && typeof f.name === 'string' && typeof f.path === 'string' && typeof f.size === 'number' && Object.keys(f).length === 3);
    case 'when':
      return isObject(v) && ['once', 'daily', 'weekly', 'every'].includes(v.kind as string);
    case 'editable':
      return v === 'memory.md' || v === 'charter.md';
    case 'client':
      return v === 'vscode' || v === 'web' || v === 'cli';
    case 'provider':
      return v === 'anthropic' || v === 'openai-compatible' || v === 'mock';
    case 'autonomy':
      return v === 'free' || v === 'guided';
    default:
      return false;
  }
}

/** A request with a known command and exactly the fields it takes, or the reason it is refused. */
export function validate(msg: unknown): { ok: true; req: Request } | { ok: false; id: number | null; error: string } {
  if (!isObject(msg)) return { ok: false, id: null, error: 'a request is a JSON object' };
  const id = typeof msg.id === 'number' && Number.isSafeInteger(msg.id) ? msg.id : null;
  if (id === null) return { ok: false, id: null, error: 'a request needs a numeric id' };
  for (const k of Object.keys(msg)) if (k !== 'id' && k !== 'cmd' && k !== 'args') return { ok: false, id, error: `unknown field: ${k}` };
  if (typeof msg.cmd !== 'string' || !Object.prototype.hasOwnProperty.call(SPEC, msg.cmd)) return { ok: false, id, error: `unknown command: ${String(msg.cmd)}` };
  const cmd = msg.cmd as CommandName;
  const args = msg.args === undefined ? {} : msg.args;
  if (!isObject(args)) return { ok: false, id, error: `${cmd}: args must be an object` };
  const spec = SPEC[cmd];
  for (const k of Object.keys(args)) if (!(k in spec)) return { ok: false, id, error: `${cmd}: unknown argument ${k}` };
  for (const [k, type] of Object.entries(spec)) if (!fieldOk(type, args[k])) return { ok: false, id, error: `${cmd}: ${k} must be ${type.replace('?', '')}` };
  return { ok: true, req: { id, cmd, args: args as never } };
}
