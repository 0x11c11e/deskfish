import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAdapter } from '../agent/adapters';
import { DocsLibrary } from '../agent/docs';
import { MemoryStore } from '../agent/memory';
import { SelfStore } from '../agent/self';
import { endFragment, JournalStore, type JournalState } from '../agent/journal';
import { PlaybookStore } from '../agent/playbook';
import { Library } from '../agent/library';
import { DEFAULT_CHARTER } from '../agent/charter';
import { ScheduleStore, describeWhen, formatLocal, type Schedule, type When } from '../agent/schedule';
import { HeldMessage } from '../agent/held';
import { STARTER_PLAYBOOKS } from '../agent/starter';
import { ChatStore, parseTranscript, type ChatTranscript, type ReplayItem } from '../agent/chats';
import { DEFAULT_SELF } from '../agent/seed';
import type { AgentNotes } from '../agent/adapters/types';
import { priceForConfig } from '../agent/pricing';
import { AgentRunner, type AgentEvent, type AgentStatus } from '../agent/loop';
import { DesktopDaemonComputer } from '../computer/daemon';
import { scalePng } from '../image/resize';
import { describeAction } from '../computer/types';
import { maskDeep, maskSecrets } from '../agent/secrets';
import { driftLine } from '../agent/prompts';
import { keySlotFor } from '../agent/presets';
import { discover, needsRefresh, parseTokens, pollOnce, refreshTokens, revoke, serializeTokens, startDeviceFlow, type DeviceGrant, type PollState, type XaiTokens } from './xaiOauth';
import { DOWNLOADS_DIR, DownloadsWatcher, UPLOADS_DIR, formatSize, isTemporary, safeFileName, type NewDownload } from '../desktop/files';
import { DesktopSupervisor, type DesktopStatus, type SupervisorOptions } from '../desktop/supervisor';
import type { DesktopFile } from '../webview/protocol';
import { applyConfigPatch, type DeskfishConfig } from './config';
import { MAX_TRANSFER, type ChatInfo, type EditableFile, type RunRequest, type Snapshot } from './protocol';
import { clearState, interruptedLine, readState, resumeNote, writeState, type RunState } from './state';
import { settingsSchema, type SettingsSchema } from './settingsSchema';
import { SecretsFile } from './storage';
import { VERSION } from './version';

export { MAX_TRANSFER };

/** The settings schema from `<resourceDir>/package.json`; empty (and one log line) when it cannot be read. */
function readSettingsSchema(resourceDir: string, log: (line: string) => void): SettingsSchema {
  try {
    return settingsSchema(JSON.parse(fs.readFileSync(path.join(resourceDir, 'package.json'), 'utf8')));
  } catch (err) {
    log(`the settings schema could not be read from ${resourceDir}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export interface ServiceOptions {
  /** Where her files live: memory.md, self.md, journal.md, playbook.md, charter.md, chats/, schedules.json. */
  dataDir: string;
  /** What ships with Deskfish: docs/, library/, docker/desktop. The extension's folder today. */
  resourceDir: string;
  config: DeskfishConfig;
  /** The config came from a saved `config.json` (the CLI knows); a client seeds a gateway that has none. */
  configSaved?: boolean;
  /** API keys by slot and the self key; `<dataDir>/secrets.json` when not given. */
  secrets?: SecretsFile;
  /** One line per call; the output channel in VS Code, a log file under the gateway. */
  log?: (line: string) => void;
  /** Tests replace the container engine. */
  createEngine?: SupervisorOptions['createEngine'];
  /** The OAuth issuer "Sign in with Grok" talks to; only a test points it anywhere but xAI. */
  authIssuer?: string;
  /** How often the clock is checked for due schedules and the running task's state is written. Default 30 s; tests make it short. */
  tickMs?: number;
}

/** A memory export: facts, self (+ history), journal (+ state), playbooks, charter, chats. No keys. */
export interface MemoryBundle {
  format?: string;
  version?: number;
  exportedAt?: string;
  memory?: string;
  self?: string;
  selfHistory?: unknown[];
  journal?: string;
  journalState?: Record<string, unknown>;
  playbook?: string;
  charter?: string;
  chats?: { name: string; text: string }[];
}

/**
 * The owner: the stores, the agent runner and its one queue, transcripts, schedules, the Downloads
 * watcher and the desktop. No `vscode` import — VS Code is one client (the controller), a gateway
 * process the next. Exactly one of these writes her files.
 *
 * Events (all through `on`):
 *   `event`     AgentEvent from the loop (masked), after the transcript and the log saw it
 *   `desktop`   DesktopStatus
 *   `task`      {text} a task was submitted and is about to start (VS Code opens the Desktop tab)
 *   `notice`    {text} a line from Deskfish itself for the chat
 *   `schedule`  {kind: 'fired'|'missed', text, task, dueAt?, auto}
 *   `reset`     a new chat (the UI clears its log)
 *   `replay`    {title, items} a past chat to render (always right after a reset)
 *   `download`  NewDownload
 *   `config`    DeskfishConfig after setConfig
 *   `keys`      string[] the slots that hold a key, after one changed (never the keys)
 */
export class DeskfishService extends EventEmitter {
  private cfg: DeskfishConfig;
  /** A `config.json` exists (found at start, or written since the first `setConfig`). */
  private configSaved: boolean;
  /** The settings dialog's fields, from the `package.json` Deskfish shipped with (read once at start). */
  readonly settingsSchema: SettingsSchema;
  /** Where "Sign in with Grok" signs in; undefined means xAI's own issuer. */
  private readonly authIssuer?: string;
  /** API keys by slot and the self key, in `secrets.json` (0600). */
  readonly secrets: SecretsFile;
  private readonly log: (line: string) => void;
  private readonly resourceDir: string;
  readonly dataDir: string;
  private runner?: AgentRunner;
  /** Model setup the current runner was built with; a change starts a fresh conversation. */
  private runnerFingerprint?: string;
  /** Bumped by newConversation(); events from an older runner (e.g. its late "stopped") are dropped. */
  private generation = 0;
  /** A message typed while she reflects: it starts as a task when the reflection ends. */
  private readonly held = new HeldMessage<DesktopFile>();
  /** Tasks submitted while another one runs: each starts after the one before it ends. */
  private readonly queue: { task: string; attachments?: DesktopFile[]; opts?: RunOptions }[] = [];
  /** A run or reflection was accepted and is waiting for the desktop to come on; later runs queue behind it. */
  private starting = false;
  /** Bumped by stop(): a run still waiting for the desktop sees it and does not start. */
  private stopSeq = 0;
  /** Schedules: tasks that start themselves while Deskfish is running. */
  readonly schedules: ScheduleStore;
  private scheduleTimer?: NodeJS.Timeout;
  private firstTick?: NodeJS.Timeout;
  /** Occurrences seen due while she was busy: they fire when she is free, however long that takes. */
  private readonly pendingSchedules = new Set<string>();
  private status: AgentStatus = 'idle';
  private statusMessage?: string;
  /** What the running task is doing, mirrored to `state.json` so an interruption is not a hole. */
  private runState?: RunState;
  /** Set by `dispose()`: the record of the running task stays on disk for the next start. */
  private disposed = false;
  /**
   * The run a gateway start found unfinished. The next run that is not a reflection is told about
   * it and it is then forgotten; it survives New chat, because the interruption happened whatever
   * the person does next.
   */
  private pendingResume?: RunState;
  /**
   * Schedules missed between the gateway coming back and the resume note being delivered — what
   * happened while she was away. A schedule that *fires* is not in here: it becomes the run that
   * gets the note.
   */
  private schedulesSinceStart: { kind: 'fired' | 'missed'; task: string }[] = [];
  private lastScreenshot?: { dataUrl: string; width: number; height: number; step: number };
  /** Usage totals of the current chat (a client that connects late shows the same counter). */
  private usage?: Extract<AgentEvent, { type: 'usage' }>;
  /** The desktop container: state machine, health poll, engine. */
  readonly desktop: DesktopSupervisor;
  /** Reports new files in the desktop's Downloads folder while the desktop is on. */
  readonly downloads: DownloadsWatcher;
  /** The bot's documentation (docs/*.md shipped with the extension), loaded once per session. */
  private docs?: DocsLibrary;
  /** Long-term memory: a markdown file in the data dir, editable by the user. */
  readonly memory: MemoryStore;
  /** Who the bot is: its own file, signed with a per-install key; only the bot writes it. Set by init(). */
  self!: SelfStore;
  /** Episodic memory: one line per finished task, plus the bot's notes to itself. */
  readonly journal: JournalStore;
  /** Procedural memory: how-to notes per site or task. */
  readonly playbook: PlaybookStore;
  /** The readings library shipped with the extension, loaded once. */
  private library?: Library;
  /** The user's own charter, if they wrote one (replaces the default). */
  readonly charterFile: string;
  /** Past chats: one markdown transcript per conversation, written as it happens. */
  readonly chats: ChatStore;
  private transcript?: ChatTranscript;
  /** Text of an earlier chat to hand to the model with the next task ("continue this chat"). */
  private pendingContext?: string;
  private autoReflectTimer?: NodeJS.Timeout;

  constructor(opts: ServiceOptions) {
    super();
    this.cfg = opts.config;
    this.configSaved = !!opts.configSaved;
    this.log = opts.log ?? (() => {});
    this.settingsSchema = readSettingsSchema(opts.resourceDir, this.log);
    this.resourceDir = opts.resourceDir;
    this.dataDir = opts.dataDir;
    this.secrets = opts.secrets ?? new SecretsFile(path.join(opts.dataDir, 'secrets.json'));
    this.authIssuer = opts.authIssuer;
    this.desktop = new DesktopSupervisor({
      buildContext: path.join(opts.resourceDir, 'docker', 'desktop'),
      config: () => this.cfg,
      log: (line) => this.log(line),
      createEngine: opts.createEngine,
    });
    this.downloads = new DownloadsWatcher(() => this.daemon());
    this.downloads.onDidDownload((file) => this.fire('download', file));
    this.memory = new MemoryStore(path.join(opts.dataDir, 'memory.md'));
    this.journal = new JournalStore(path.join(opts.dataDir, 'journal.md'));
    this.playbook = new PlaybookStore(path.join(opts.dataDir, 'playbook.md'));
    this.charterFile = path.join(opts.dataDir, 'charter.md');
    this.chats = new ChatStore(path.join(opts.dataDir, 'chats'));
    this.schedules = new ScheduleStore(path.join(opts.dataDir, 'schedules.json'));
    // The scheduler: a clock check every 30 s (microseconds of work), nothing else running between.
    // The running task's state rides on the same tick, so `state.json` is never more than one tick old.
    this.scheduleTimer = setInterval(() => void this.tickSchedules(), opts.tickMs ?? 30_000);
    this.firstTick = setTimeout(() => void this.tickSchedules(), 3_000);
    this.desktop.on('change', (s: DesktopStatus) => {
      // A screenshot from a previous desktop session must not linger as a placeholder.
      if (s.state !== 'on') this.lastScreenshot = undefined;
      if (s.state === 'on') this.downloads.start();
      else this.downloads.stop();
      this.fire('desktop', s);
    });
    if (this.desktop.current.state === 'on') this.downloads.start();
  }

  /**
   * The self file needs its signing key (per install; a copy of the files elsewhere does not
   * verify): the one in the secrets file, created the first time, unless one is passed. Call once
   * before the first task, after any migration into the data dir.
   */
  init(selfKey?: string): void {
    this.self = new SelfStore(path.join(this.dataDir, 'self.md'), selfKey ?? this.secrets.ensureSelfKey());
    if (this.self.ensureSeed(DEFAULT_SELF)) {
      // Her first day: the seed of who she is, a few starter notes, and a first line in the journal
      // so the story has a beginning (life stories start with birth).
      this.playbook.ensureSeed(STARTER_PLAYBOOKS);
      this.journal.appendNote('I hatched today: first start on this machine, with the seed of who I am and a few starter notes from the people who made me. Everything after this line is mine.');
      this.log('— first start: wrote the seed self, the starter playbooks and the first journal line —');
    }
    this.resumeFromState();
  }

  /* ---------- state.json: the running task, so an interruption is not a hole ---------- */

  /**
   * A gateway that starts over a `state.json` was interrupted: the machine restarted, the process
   * was killed, an update replaced it. One line goes in her journal (the fact, in her own record),
   * and the next run that is not a reflection is handed a note about it — her requirement 3:
   * resume, not a zombie. An interrupted reflection gets the journal line only: its pending items
   * are still in the journal state and the next reflection covers them.
   */
  private resumeFromState(): void {
    const state = readState(this.dataDir);
    if (!state) return;
    const now = Date.now();
    if (!state.noted) {
      this.journal.appendNote(interruptedLine(state, now));
      writeState(this.dataDir, { ...state, noted: true });
    }
    this.log(`— ${interruptedLine(state, now)} —`);
    // A reflection's pending items are in the journal state and the next reflection sees them, so
    // an interrupted reflection is worth the journal line and nothing more.
    if (!state.reflection) this.pendingResume = state;
  }

  /**
   * The note for the next run, taken once. Written here rather than at startup because the tank's
   * state is only true once the run has turned it on: whether it is the same container decides
   * whether anything in its windows survived.
   */
  private async takeResumeNote(): Promise<string | undefined> {
    const state = this.pendingResume;
    if (!state) return undefined;
    this.pendingResume = undefined;
    const schedules = this.schedulesSinceStart;
    this.schedulesSinceStart = [];
    return resumeNote({ state, now: Date.now(), containerId: await this.desktop.containerId(), desktopOn: this.desktop.current.state === 'on', schedules });
  }

  /** Start recording a run: written before the first model call, so even step 1 is not lost. */
  private async beginState(task: string, opts: RunOptions | undefined, reflection: boolean): Promise<void> {
    const at = new Date().toISOString();
    this.runState = {
      task: reflection ? 'a reflection' : task,
      reflection,
      unattended: !!opts?.unattended,
      reason: opts?.reason,
      startedAt: at,
      steps: 0,
      lastStepAt: at,
      said: [],
      containerId: await this.desktop.containerId(),
    };
    this.flushState();
  }

  /** `state.json` now, if a run is recording. Called at every ledger and on every tick. */
  private flushState(): void {
    if (!this.runState) return;
    try {
      // Masked like every other file the gateway writes (decision 88): the task, what the user said
      // and her last line can quote a token; the note she gets back reads the masked form.
      writeState(this.dataDir, maskDeep(this.runState));
    } catch (err) {
      this.log(`state.json could not be written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The run ended (or the chat was cleared): nothing is interrupted, so nothing is left behind. */
  private endState(): void {
    // A gateway that is going away (`deskfish stop`, SIGTERM, an update) is exactly the
    // interruption the file exists for: the runner's late "stopped" must not erase it.
    if (this.disposed) return;
    this.runState = undefined;
    clearState(this.dataDir);
  }

  /* ---------- config and keys (pushed in by the client; the service reads no settings of its own) ---------- */

  get config(): DeskfishConfig {
    return this.cfg;
  }

  /** New settings. A running task keeps its runner; the next run rebuilds it when the model setup changed. */
  setConfig(cfg: DeskfishConfig): void {
    this.cfg = cfg;
    // Every `config` event is written to config.json by the process that owns the file.
    this.configSaved = true;
    this.fire('config', cfg);
  }

  /** The API key for a slot (`deskfish.apiKey.<anthropic|host>`), kept in the secrets file; empty clears it. */
  setKey(slot: string, key: string | undefined): void {
    if (this.secrets.set(slot, key || undefined)) this.fire('keys', this.secrets.slots());
  }

  /** The credential slot the current configuration uses: an API key slot, or an OAuth one when signed in. */
  private slot(): string | undefined {
    return keySlotFor(this.cfg.provider, this.cfg.baseUrl, this.cfg.auth);
  }

  /** The API key for the current provider's slot. Undefined while the configuration signs in instead. */
  apiKey(): string | undefined {
    if (this.cfg.auth) return undefined;
    const slot = this.slot();
    return slot ? this.secrets.get(slot) : undefined;
  }

  /* ---------- "Sign in with Grok": the device flow, the tokens, the refresh (one writer: here) ---------- */

  /** The sign-in the person is completing in their browser, between `auth.start` and `auth.poll`. */
  private grant?: DeviceGrant;
  /** One refresh in flight at a time: a second call waits for the first rather than racing it. */
  private refreshing?: Promise<XaiTokens>;

  /** The tokens in the current configuration's OAuth slot, if it has any. */
  private tokens(): XaiTokens | undefined {
    const slot = this.cfg.auth ? this.slot() : undefined;
    return slot ? parseTokens(this.secrets.get(slot)) : undefined;
  }

  /** Write tokens back to their slot (and tell the clients the slot list changed). */
  private storeTokens(t: XaiTokens | undefined): void {
    const slot = keySlotFor(this.cfg.provider, this.cfg.baseUrl, 'xai-oauth');
    if (!slot) return;
    if (this.secrets.set(slot, t ? serializeTokens(t) : undefined)) this.fire('keys', this.secrets.slots());
  }

  /**
   * The bearer for one model call: the stored access token, renewed when under an hour of it is
   * left or when the adapter says a 401 forced it. The rotated refresh token is written before this
   * resolves, so a crash right after cannot strand the grant.
   */
  private async bearer(force = false, baseUrl?: string): Promise<string> {
    if (!this.cfg.auth) {
      // The person switched to the API-key preset while this task waited at the pool's knock (the
      // knock says they may). Same endpoint, so the conversation goes on with the key; a different
      // endpoint is another conversation and this runner cannot follow it.
      const key = baseUrl === undefined || this.cfg.baseUrl === baseUrl ? this.apiKey() : undefined;
      if (key) return key;
      throw new Error('Not signed in with Grok. Sign in in Settings, or use an xAI API key.');
    }
    const have = this.tokens();
    if (!have) throw new Error('Not signed in with Grok. Sign in in Settings, or use an xAI API key.');
    if (!force && !needsRefresh(have)) return have.access;
    if (!this.refreshing) {
      this.refreshing = refreshTokens(have)
        .then((next) => {
          this.storeTokens(next);
          return next;
        })
        .finally(() => {
          this.refreshing = undefined;
        });
    }
    return (await this.refreshing).access;
  }

  /** Start the device flow: the code and the URL the person approves in their own browser. */
  async authStart(): Promise<{ userCode: string; verificationUri: string; expiresIn: number }> {
    const grant = await startDeviceFlow({ issuer: this.authIssuer });
    this.grant = grant;
    this.log(`— signing in with Grok: code ${grant.userCode} at ${grant.verificationUri} —`);
    return { userCode: grant.userCode, verificationUri: grant.verificationUri, expiresIn: Math.max(0, Math.round((grant.expiresAt - Date.now()) / 1000)) };
  }

  /** One poll of the sign-in in progress. The view asks; the gateway does the talking. */
  async authPoll(): Promise<{ state: PollState; detail?: string; who?: string }> {
    const grant = this.grant;
    if (!grant) return { state: 'expired', detail: 'That sign-in is no longer running. Start it again.' };
    const r = await pollOnce(grant);
    if (r.slowDown) grant.intervalMs += 5000;
    if (r.state === 'done' && r.tokens) {
      this.grant = undefined;
      this.storeTokens(r.tokens);
      this.log(`— signed in with Grok${r.tokens.who ? ` as ${r.tokens.who}` : ''} —`);
      return { state: 'done', who: r.tokens.who };
    }
    if (r.state !== 'pending') {
      this.grant = undefined;
      if (r.detail) this.log(`— Grok sign-in ${r.state}: ${r.detail} —`);
    }
    return { state: r.state, ...(r.detail ? { detail: r.detail } : {}) };
  }

  /** Sign out: tell xAI to forget the grant (best effort), then clear the slot. */
  async authSignOut(): Promise<void> {
    const have = this.tokens();
    this.grant = undefined;
    if (have) await revoke(have, await discover(this.authIssuer)).catch(() => false);
    this.storeTokens(undefined);
    this.log('— signed out of Grok —');
  }

  /** How long the sign-in in progress may still be polled, in seconds (0 when none is running). */
  authPending(): number {
    return this.grant ? Math.max(0, Math.round((this.grant.expiresAt - Date.now()) / 1000)) : 0;
  }

  /** The charter: the user's file when it exists and is not empty, else the default that ships with Deskfish. */
  charter(): string {
    try {
      const own = fs.readFileSync(this.charterFile, 'utf8');
      if (own.trim()) return own;
    } catch {
      /* no override */
    }
    return DEFAULT_CHARTER;
  }

  /** The charter file, created from the default the first time (for editing). */
  ensureCharterFile(): string {
    if (!fs.existsSync(this.charterFile)) {
      fs.mkdirSync(path.dirname(this.charterFile), { recursive: true });
      fs.writeFileSync(this.charterFile, DEFAULT_CHARTER + '\n');
    }
    return this.charterFile;
  }

  private readingsLibrary(): Library {
    if (!this.library) this.library = Library.load(path.join(this.resourceDir, 'library'));
    return this.library;
  }

  /** What the stores contribute to the system prompt; read fresh at every run start. */
  notes(): AgentNotes {
    const st = this.self.load();
    return {
      charter: this.charter(),
      memory: this.memory.render(),
      self: st.text,
      selfStatus: st.status === 'tampered' ? 'tampered' : 'ok',
      selfLastSigned: st.lastSigned,
      journal: this.journal.render(this.journal.recent()),
      playbooks: this.playbook.index(),
    };
  }

  get currentStatus(): AgentStatus {
    return this.status;
  }

  /** The current run is a reflection: the desktop is free for the person. */
  get screenFree(): boolean {
    return !!this.runner?.reflecting;
  }

  /** A run is active, or accepted and waiting for the desktop to come on. */
  get busy(): boolean {
    return this.starting || !!this.runner?.isActive;
  }

  get latestScreenshot() {
    return this.lastScreenshot;
  }

  /**
   * Start a task. While a task runs, the new one waits in the queue and starts when that one ends;
   * while she reflects, it is held and starts when the reflection ends. After a finished task, the
   * next one continues the same conversation so follow-ups keep their context. Turns the desktop
   * on first if it is off.
   */
  async run(task: string, attachments?: DesktopFile[], opts?: RunOptions): Promise<void> {
    if (this.busy) {
      // A reflection is hers alone: the person's message waits for it to end, then starts as a task.
      if (this.runner?.isActive && this.runner.reflecting) this.hold(task, attachments);
      else this.enqueue(task, attachments, opts);
      return;
    }
    // Until the runner is running, `starting` keeps a second run (or a reflection, or a due schedule)
    // from passing the check above while the desktop is still turning on.
    this.starting = true;
    try {
      await this.startRun(task, attachments, opts);
    } finally {
      this.starting = false;
    }
  }

  private async startRun(task: string, attachments?: DesktopFile[], opts?: RunOptions): Promise<void> {
    const gen = this.generation;
    const stopSeq = this.stopSeq;
    task = withAttachments(task, attachments);
    const cfgNow = this.cfg;
    if (!this.transcript) this.transcript = this.chats.start(task, { model: cfgNow.model, provider: cfgNow.provider });
    this.transcript.user(task);
    if (this.pendingContext) {
      task = `For context, the transcript of an earlier chat with the user (images omitted):\n<<<\n${this.pendingContext}\n>>>\n\nThe user now says: ${task}`;
      this.pendingContext = undefined;
    }

    // The client shows the screen as soon as a task is submitted (even while the tank is still
    // turning on — the Desktop tab shows the progress).
    this.fire('task', { text: task });

    const on = await this.desktop.ensureOn();
    if (gen !== this.generation) return; // New chat while the desktop turned on: this task went with the old chat.
    if (stopSeq !== this.stopSeq) {
      this.emitEvent({ type: 'status', status: 'stopped', message: 'Stopped before the desktop was on' });
      return;
    }
    if (!on) {
      this.emitEvent({ type: 'status', status: 'error', message: `The desktop is not running${this.desktop.current.message ? `: ${this.desktop.current.message}` : ''}` });
      return;
    }

    const runner = this.ensureRunner(opts);
    if (!runner) return;
    // `reason` says what put the task here (a schedule, a lesson from a teacher over MCP). It used to
    // be logged for unattended runs only, so an attended lesson looked like the person typing.
    const why = [opts?.unattended ? 'unattended' : '', opts?.reason ?? ''].filter(Boolean).join(', ');
    this.log(`▶ task${why ? ` (${why})` : ''}: ${maskSecrets(task)}`);
    await this.beginState(task, opts, false);
    // The container lookup is an await: a Stop or a New chat in that moment must still win.
    if (gen !== this.generation || stopSeq !== this.stopSeq) {
      this.endState();
      if (gen === this.generation) this.emitEvent({ type: 'status', status: 'stopped', message: 'Stopped before the task started' });
      return;
    }
    // The interruption note goes into the first observation of this run, and only once.
    const note = await this.takeResumeNote();
    if (note) this.log('  ↻ the previous run was interrupted; she is told about it before her first look');
    void runner.run(task, { ...(note ? { note } : {}), ...(opts?.reason ? { reason: opts.reason } : {}) }).catch((err) => {
      this.emitEvent({ type: 'status', status: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  }

  /**
   * Reflection: the bot alone with its journal and notes, allowed to save facts and revise its
   * own self file. Runs on the same conversation as the last task when there is one. `auto` =
   * triggered by the task counter (deskfish.reflectEvery) rather than by the user.
   */
  async reflect(auto = false): Promise<'busy' | 'started' | 'failed'> {
    if (this.busy) return 'busy';
    this.starting = true;
    try {
      const gen = this.generation;
      const stopSeq = this.stopSeq;
      const on = await this.desktop.ensureOn();
      if (gen !== this.generation || stopSeq !== this.stopSeq) return 'failed';
      if (!on) {
        if (!auto) this.emitEvent({ type: 'status', status: 'error', message: 'The desktop is not running' });
        return 'failed';
      }
      return await this.startReflection(auto, gen, stopSeq);
    } finally {
      this.starting = false;
    }
  }

  private async startReflection(auto: boolean, gen: number, stopSeq: number): Promise<'started' | 'failed'> {
    const runner = this.ensureRunner();
    if (!runner) return 'failed';
    this.log(`— reflection (${auto ? 'automatic' : 'asked by the user'}) —`);
    // A reflection is recorded too (an interrupted one gets the journal line), but it never takes
    // the resume note: its pending items are in the journal state and the next reflection sees them.
    // Recorded before it starts, so its end can never come before its record.
    await this.beginState('a reflection', undefined, true);
    if (gen !== this.generation || stopSeq !== this.stopSeq) {
      this.endState();
      return 'failed';
    }
    void runner.reflect().catch((err) => {
      this.emitEvent({ type: 'status', status: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    return 'started';
  }

  /**
   * The fence on a run nobody is watching (her requirement 2): it behaves like `guided` unless the
   * schedule says otherwise, and it carries a cost ceiling that stops rather than improvises —
   * the schedule's own budget, else `deskfish.unattendedMaxCostUsd` (default 2, 0 = none). An
   * attended run keeps the settings the person chose.
   */
  private fenceFor(opts?: RunOptions): { autonomy: DeskfishConfig['autonomy']; budgetUsd: number; budgetSetting: string } {
    const cfg = this.cfg;
    if (!opts?.unattended) return { autonomy: cfg.autonomy, budgetUsd: cfg.maxCostUsd, budgetSetting: 'deskfish.maxCostUsd' };
    return {
      autonomy: opts.autonomy ?? 'guided',
      budgetUsd: opts.maxCostUsd ?? cfg.unattendedMaxCostUsd,
      budgetSetting: opts.maxCostUsd === undefined ? 'deskfish.unattendedMaxCostUsd' : "this schedule's budget",
    };
  }

  /** Reuse the runner (same conversation) when the last run ended cleanly and nothing changed; otherwise build a new one. */
  private ensureRunner(opts?: RunOptions): AgentRunner | undefined {
    const cfg = this.cfg;
    const apiKey = this.apiKey();
    const fence = this.fenceFor(opts);
    // A follow-up task continues the previous conversation (the model keeps its context) as long
    // as the last run ended cleanly and the model setup is unchanged. After stop/error the
    // adapter may hold half-finished tool calls, so those start fresh.
    // The fence is part of the setup: an unattended run never continues an attended conversation
    // built with other rules (and a scheduled run is its own chat anyway).
    // The budget itself is not: "Stopped at the cost budget — raise deskfish.maxCostUsd or say
    // continue" must keep the conversation when the person does both (the raised budget applies
    // from the next fresh runner, as before step 5).
    // `auth` is part of the setup: the same endpoint with a sign-in instead of a key is another
    // credential and another conversation. The tokens themselves are not — they rotate mid-task.
    const fingerprint = JSON.stringify([cfg.provider, cfg.model, cfg.baseUrl, cfg.anthropicWorkspaceId, cfg.auth, fence.autonomy, cfg.daemonUrl, apiKey, cfg.effort, cfg.cacheTtl, opts?.unattended ? fence.budgetUsd : null]);
    let runner = this.runner;
    if (!runner || runner.currentStatus !== 'done' || fingerprint !== this.runnerFingerprint) {
      try {
        const docs = this.docsLibrary();
        // On a sign-in the list price does not apply: nothing is billed per token, so the loop must
        // not accumulate an imaginary spend (and the budget must not stop a task over it).
        const price = cfg.auth ? undefined : priceForConfig({ provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl });
        if (opts?.unattended && fence.budgetUsd > 0 && cfg.auth) {
          // Same honesty one provider further on: a run on a subscription spends a pool, not dollars,
          // so there is no figure for the budget to count — the pool running out is the knock.
          this.log(`  ⚠ the unattended budget ($${fence.budgetUsd.toFixed(2)}) cannot act while she is signed in with Grok: the run draws the subscription's pool, which has no dollar figure`);
        } else if (opts?.unattended && fence.budgetUsd > 0 && !price) {
          // Honest about the fence: without a list price the loop can only count what the provider
          // reports, and most OpenAI-compatible endpoints report nothing.
          this.log(`  ⚠ the unattended budget ($${fence.budgetUsd.toFixed(2)}) cannot act on ${cfg.model} (${cfg.provider}): no list price for it, so cost is only known if the endpoint reports it`);
        }
        const adapter = createAdapter({
          provider: cfg.provider,
          model: cfg.model,
          baseUrl: cfg.baseUrl || undefined,
          apiKey: apiKey || undefined,
          ...(cfg.auth ? { bearer: (force?: boolean) => this.bearer(force, cfg.baseUrl) } : {}),
          workspaceId: cfg.anthropicWorkspaceId || undefined,
          autonomy: fence.autonomy,
          docsIndex: docs.size ? docs.index() : undefined,
          notes: () => this.notes(),
          promptCaching: cfg.promptCaching,
          temperature: typeof cfg.temperature === 'number' ? cfg.temperature : undefined,
          cacheTtl: cfg.cacheTtl,
          effort: cfg.effort || undefined,
        });
        const gen = this.generation;
        runner = new AgentRunner({
          computer: new DesktopDaemonComputer(cfg.daemonUrl, { token: cfg.daemonToken || undefined }),
          adapter,
          maxSteps: cfg.maxSteps,
          screenshotWidth: cfg.screenshotWidth,
          settleMs: cfg.settleMs,
          docs,
          memory: this.memory,
          self: this.self,
          journal: this.journal,
          playbook: this.playbook,
          library: this.readingsLibrary(),
          chats: this.chats,
          environmentNote: () => {
            const name = this.cfg.userName;
            const who = name ? `The person talking with you in this chat is ${name} — the person you work for, the same one your page and journal mention by that name.` : '';
            const net =
              this.desktop.networkMode === undefined
                ? ''
                : this.desktop.networkMode === 'host'
                ? "Network: this tank shares the host machine's network namespace (the passt package is not installed), so it sees the host's interfaces and can reach the host's localhost services and the LAN."
                : "Network: this tank has a network namespace of its own (passt/pasta). It carries a copy of the host's LAN address and reaches the LAN and the internet through the host, like any program on it, but it does not see the host's other interfaces or the host's localhost services. Reaching LAN devices is therefore expected and is not host networking.";
            const note = [who, net].filter(Boolean).join(' ');
            return note || undefined;
          },
          reflectEvery: cfg.reflectEvery,
          ledgerEvery: cfg.ledgerEvery,
          ledgerTokens: cfg.ledgerTokens,
          budgetUsd: fence.budgetUsd,
          budgetSetting: fence.budgetSetting,
          price,
          subscription: !!cfg.auth,
          onEvent: (e) => {
            if (gen === this.generation) this.emitEvent(e);
          },
        });
      } catch (err) {
        this.emitEvent({ type: 'status', status: 'error', message: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
      this.runnerFingerprint = fingerprint;
      this.log(`  provider=${cfg.provider} model=${cfg.model} daemon=${cfg.daemonUrl} autonomy=${fence.autonomy}${fence.budgetUsd > 0 ? ` budget=$${fence.budgetUsd.toFixed(2)}` : ''}`);
    }
    this.runner = runner;
    return runner;
  }

  /** Write what the chat shows into the transcript of the current conversation. */
  private record(e: AgentEvent): void {
    const t = this.transcript;
    if (!t) return;
    switch (e.type) {
      case 'assistant':
        t.assistant(e.text);
        break;
      case 'action': {
        const a = e.action.type;
        const what = e.describe ?? describeAction(e.action);
        if (a === 'wait_for') {
          // A standby reads as its own line in the transcript, like in the chat.
          t.note(e.result.ok ? `⏳ ${(e.result.message ?? 'Stood by').split(/[;.] /)[0]} (${what})` : `⏳ Standby failed: ${e.result.error ?? ''}`);
          break;
        }
        const memoryish = a === 'remember' || a === 'forget' || a === 'revise_self' || a === 'restore_self' || a === 'note' || a === 'save_playbook' || a === 'archive_story';
        if (memoryish) t.note(e.result.ok ? (e.result.message ?? what) : `${what} — not done: ${e.result.error ?? ''}`);
        else t.action(e.step, what, e.result.ok);
        break;
      }
      case 'needs_user':
      case 'needs_fill':
        // Both knocks read the same in the transcript: what she asked for, never what was answered.
        t.needsUser(e.reason);
        break;
      case 'status':
        if (e.status === 'done' || e.status === 'stopped' || e.status === 'error') t.status(`${e.status}${e.message ? ` — ${e.message}` : ''}${endFragment(e.end)}`);
        break;
      case 'ledger':
        t.note(`📒 Ledger after ${e.step} steps: ${e.text.replace(/\s*\n+\s*/g, ' / ')}`);
        break;
      case 'drift':
        for (const s of e.shifts) t.note(driftLine(s));
        break;
      case 'charter_objection':
        for (const l of e.lines) t.note(`She disagrees with her charter: ${l}`);
        break;
      default:
        break;
    }
  }

  /**
   * A past chat, back in the chat the way it looked: the log is cleared, the transcript is
   * rendered as bubbles, and the next task carries the transcript as context so she can pick it up.
   */
  openChat(file: string, startedAt: string): void {
    const text = this.chats.read(file);
    if (!text.trim()) return;
    this.newConversation();
    const items: ReplayItem[] = parseTranscript(text);
    this.fire('replay', { title: `Past chat from ${startedAt}`, items });
    this.pendingContext = text.length > 16000 ? '…' + text.slice(-16000) : text;
    this.emitEvent({ type: 'status', status: 'idle', message: `Past chat from ${startedAt} — type below to continue it` });
  }

  /** Delete every past chat (not the current one, which is not a past chat yet); returns how many were deleted. */
  deleteAllChats(): number {
    let n = 0;
    for (const c of this.chats.list()) {
      if (c.file === this.transcript?.file) continue;
      try {
        this.chats.delete(c.file);
        n++;
      } catch {
        /* already gone */
      }
    }
    this.log(`— ${n} past chats deleted by the user —`);
    return n;
  }

  /** Forget every fact (her self file and journal are not touched). */
  clearFacts(): void {
    this.memory.clear();
    this.log('— memory cleared by the user —');
  }

  /* ---------- who she is, backups ---------- */

  /** The self file as a page to read, with a line on who wrote it and whether the signature holds. */
  whoSheIs(): string {
    const st = this.self.load();
    const hist = this.self.history();
    const last = hist.length ? hist[hist.length - 1] : undefined;
    const head =
      `> Written by Deskfish, in her own words. Only she changes this page (when she reflects). ` +
      `${st.status === 'tampered' ? '**Changed outside her own writing since she last signed it.**' : `Signed by her${last ? `, last written ${last.at.slice(0, 16).replace('T', ' ')} (${last.author})` : ''}.`}\n\n`;
    return head + (st.text || '(nothing written yet)');
  }

  /** One object with everything that makes her: facts, self (+ history), journal (+ state). No keys. */
  exportBundle(): MemoryBundle {
    const st = this.self.load();
    return {
      format: 'deskfish-memory',
      version: 1,
      exportedAt: new Date().toISOString(),
      memory: this.memory.raw(),
      self: st.text,
      selfHistory: this.self.history(),
      journal: this.journal.raw(),
      journalState: this.journal.state() as unknown as Record<string, unknown>,
      playbook: this.playbook.raw(),
      charter: fs.existsSync(this.charterFile) ? fs.readFileSync(this.charterFile, 'utf8') : undefined,
      chats: this.chats.dump(),
    };
  }

  /** Replace facts, self and journal from an export (the caller has validated and confirmed). The self is re-signed with this install's key. */
  importBundle(bundle: MemoryBundle & { self: string }): void {
    if (this.runner?.isActive) this.runner.stop();
    this.memory.importText(bundle.memory ?? '');
    if (Array.isArray(bundle.selfHistory) && !this.self.history().length) {
      // A fresh install: carry her past versions over, so the thread is unbroken.
      for (const e of bundle.selfHistory as { at: string; author: string; reason: string; text: string }[]) {
        if (e && typeof e.text === 'string') fs.appendFileSync(this.self.historyFile, JSON.stringify(e) + '\n');
      }
    }
    this.self.importText(bundle.self);
    this.journal.importText(bundle.journal ?? '', (bundle.journalState ?? {}) as Partial<JournalState>);
    this.playbook.importText(bundle.playbook ?? '');
    if (typeof bundle.charter === 'string' && bundle.charter.trim()) fs.writeFileSync(this.charterFile, bundle.charter);
    if (Array.isArray(bundle.chats)) this.chats.restore(bundle.chats);
  }

  say(text: string, attachments?: DesktopFile[]): void {
    if (!this.runner?.isActive) return;
    if (this.runner.reflecting) {
      this.hold(text, attachments);
      return;
    }
    this.transcript?.user(withAttachments(text, attachments));
    // What the person said mid-task is part of the task: the note after an interruption carries it.
    if (this.runState) {
      this.runState.said.push(text);
      if (this.runState.said.length > 5) this.runState.said.splice(0, this.runState.said.length - 5); // the last five: the latest instruction is the one that counts
    }
    this.runner.say(withAttachments(text, attachments));
    if (this.runner.waitingForUser) this.runner.resume();
  }

  /** Keep a message typed during a reflection; `afterRun` starts it when the reflection ends. */
  private hold(text: string, attachments?: DesktopFile[]): void {
    const how = this.held.add(text, attachments ?? []);
    this.log(`⏳ held until her reflection ends: ${maskSecrets(text)}`);
    this.fire('notice', {
      text: how === 'held' ? 'She is reflecting. Your message waits and starts as a task when she finishes.' : 'Added to the message waiting for her reflection to end.',
    });
  }

  /** A task submitted while another runs waits its turn; `afterRun` starts it. */
  private enqueue(task: string, attachments?: DesktopFile[], opts?: RunOptions): void {
    this.queue.push({ task, attachments, opts });
    this.log(`⏳ queued until the current task ends: ${maskSecrets(task)}`);
    this.fire('notice', { text: 'She is busy with a task. This one starts when that one ends.' });
  }

  /** Tasks waiting in the queue (not counting a message held during a reflection). */
  get queued(): number {
    return this.queue.length;
  }

  /** A run ended: start the message held during a reflection (or drop it if the person stopped her), else the next queued task. */
  private afterRun(status: 'done' | 'stopped' | 'error'): void {
    const held = this.held.take();
    if (held) {
      if (status === 'stopped') {
        this.log('⏳ the reflection was stopped; the held message was not started');
        this.fire('notice', { text: 'The reflection was stopped, so the message you typed during it was not started. Send it again when you are ready.' });
        return;
      }
      setTimeout(() => void this.run(held.text, held.attachments), 0);
      return;
    }
    const next = this.queue.shift();
    if (next) setTimeout(() => void this.run(next.task, next.attachments, next.opts), 0);
  }

  pause(): void {
    this.runner?.pause();
  }

  resume(): void {
    this.runner?.resume();
  }

  /**
   * The sign-in card was submitted. The values go straight to the loop and are never held here:
   * this method writes one line to the log saying it happened, and that line has no value in it.
   * A refusal (no card waiting, labels that do not match) is thrown, so the client says it in words.
   */
  fill(values: { label: string; value: string }[]): void {
    const r = this.runner?.fill(values);
    if (!r || !r.ok) throw new Error(r ? r.error : 'no task is running, so no sign-in card is waiting.');
    this.log(`— the sign-in card was filled into the page (${values.length} field${values.length === 1 ? '' : 's'}; the values are written nowhere) —`);
  }

  /** Stop: the running task ends and the tasks waiting behind it are dropped (Stop means stop). */
  stop(): void {
    if (this.starting) this.stopSeq++;
    if (this.queue.length) {
      const n = this.queue.length;
      this.queue.length = 0;
      this.log(`⏳ ${n} queued task${n === 1 ? '' : 's'} dropped by Stop`);
      this.fire('notice', { text: `Stopped. The ${n === 1 ? 'task' : `${n} tasks`} waiting behind it ${n === 1 ? 'was' : 'were'} not started.` });
    }
    this.runner?.stop();
  }

  /*
   * Schedules. `tickSchedules` runs every 30 s and right after a task ends. A due occurrence
   * fires when she is free; while she is busy it is remembered and fires when she is done. An
   * occurrence that Deskfish was not running for, and only sees later than the grace, is missed:
   * settled as such, noted in the chat, the log and her journal, never run late.
   */
  async tickSchedules(): Promise<void> {
    // The running task's state rides on this tick: `state.json` is never more than one tick old.
    this.flushState();
    const now = Date.now();
    const grace = Math.max(0, this.cfg.scheduleGraceMinutes) * 60_000;
    for (const d of this.schedules.due(now, grace)) {
      const key = `${d.schedule.id}@${d.dueAt}`;
      const when = describeWhen(d.schedule.when);
      if (d.verdict === 'missed' && !this.pendingSchedules.has(key)) {
        this.schedules.settle(d.schedule.id, d.dueAt, 'missed', now);
        const text = `⏰ Missed a scheduled task: "${d.schedule.task}" (${when}) was due ${formatLocal(d.dueAt)}, but Deskfish was not running then.`;
        this.log(text);
        this.journal.appendNote(`Missed a scheduled task: "${d.schedule.task}" was due ${formatLocal(d.dueAt)} but Deskfish was not running.`);
        if (this.pendingResume) this.schedulesSinceStart.push({ kind: 'missed', task: d.schedule.task });
        this.fire('schedule', { kind: 'missed', text, task: d.schedule.task, dueAt: d.dueAt, auto: true });
        continue;
      }
      if (this.busy) {
        // Busy: after she finishes, not instead of it.
        if (!this.pendingSchedules.has(key)) {
          this.pendingSchedules.add(key);
          this.log(`⏰ scheduled task is due (${when}) — waiting for the current task to finish: ${d.schedule.task}`);
        }
        continue;
      }
      this.pendingSchedules.delete(key);
      this.schedules.settle(d.schedule.id, d.dueAt, 'fired', now);
      this.log(`⏰ scheduled task (${when}): ${d.schedule.task}`);
      // A scheduled task is its own chat: yesterday's conversation is not its context.
      if (this.transcript) this.newConversation();
      this.fire('schedule', { kind: 'fired', text: `⏰ ${d.schedule.task}`, task: d.schedule.task, dueAt: d.dueAt, auto: true });
      // A schedule starts a run nobody is watching: it carries the fence (guided unless the
      // schedule says free, and a cost ceiling that stops rather than improvises).
      await this.run(
        `${d.schedule.task}

(This task was scheduled to run ${when}; it is ${formatLocal(now)} now. No one is necessarily watching: if you need the user, knock on the glass and wait.)`,
        undefined,
        { unattended: true, maxCostUsd: d.schedule.maxCostUsd, autonomy: d.schedule.autonomy, reason: 'schedule' },
      );
      return; // one at a time; the next tick picks up the rest once she is free
    }
  }

  addSchedule(task: string, when: When, fence: { autonomy?: 'free' | 'guided'; maxCostUsd?: number } = {}): Schedule {
    const s = this.schedules.add(task, when, Date.now(), fence);
    this.log(`⏰ scheduled (${describeWhen(s.when)}${s.autonomy ? `, ${s.autonomy}` : ''}${s.maxCostUsd !== undefined ? `, budget $${s.maxCostUsd.toFixed(2)}` : ''}): ${s.task}`);
    return s;
  }

  removeSchedule(id: string): void {
    const s = this.schedules.get(id);
    this.schedules.remove(id);
    if (s) this.log(`⏰ removed schedule: ${s.task}`);
  }

  /** "Run it now": its own chat when she is free; queued behind the current task when she is not. A person clicked it, so it is attended — the fence is for the runs nobody asked for. */
  async runSchedule(id: string): Promise<void> {
    const s = this.schedules.get(id);
    if (!s) return;
    if (this.transcript && !this.busy) this.newConversation();
    this.fire('schedule', { kind: 'fired', text: `⏰ ${s.task}`, task: s.task, auto: false });
    await this.run(s.task);
  }

  /**
   * New chat: stop a running task, forget the model's conversation, and clear the UI. The
   * desktop itself is untouched — Firefox, its tabs and logins stay exactly as they are.
   */
  newConversation(): void {
    if (this.runner?.isActive) this.runner.stop();
    this.transcript?.end();
    this.transcript = undefined;
    this.generation++;
    this.runner = undefined;
    this.runnerFingerprint = undefined;
    this.held.clear();
    this.queue.length = 0;
    this.usage = undefined;
    this.lastScreenshot = undefined;
    // Nothing is running any more, so nothing is interrupted. The resume note is not cleared:
    // the interruption is a fact, and the next run still has to be told about it.
    this.endState();
    this.log('— new chat —');
    this.emitEvent({ type: 'status', status: 'idle', message: 'New chat' });
    this.fire('reset');
  }

  /** Re-announce the current status (after a key change, so every surface re-renders). */
  announceStatus(): void {
    this.emitEvent({ type: 'status', status: this.status, message: undefined });
  }

  private docsLibrary(): DocsLibrary {
    if (!this.docs) {
      this.docs = DocsLibrary.load(path.join(this.resourceDir, 'docs'));
      this.log(`docs: ${this.docs.size} pages available to the bot`);
    }
    return this.docs;
  }

  private daemon(): DesktopDaemonComputer | undefined {
    if (this.desktop.current.state !== 'on') return undefined;
    const cfg = this.cfg;
    return new DesktopDaemonComputer(cfg.daemonUrl, { token: cfg.daemonToken || undefined });
  }

  /**
   * A fresh frame of the tank, scaled like the ones the model sees. For a client with no live view —
   * an MCP session judging her work. Passive: the daemon takes the picture between her actions and
   * nothing on the screen moves because of it.
   */
  async desktopScreenshot(): Promise<{ dataUrl: string; width: number; height: number }> {
    const daemon = this.daemon();
    if (!daemon) throw new Error('The desktop is off, so there is no screen to look at. Give her a task (she turns the tank on herself) or turn it on from a Deskfish window.');
    const shot = await daemon.screenshot();
    const image = scalePng(shot.png, this.cfg.screenshotWidth ?? 1280);
    return { dataUrl: `data:image/jpeg;base64,${image.jpeg.toString('base64')}`, width: image.width, height: image.height };
  }

  /** Release any stuck key/button on the bot's display (called by the Desktop pane on focus loss, before the user interacts, etc.). */
  async releaseInput(): Promise<void> {
    const released = await this.daemon()?.releaseInput().catch(() => []);
    if (released && released.length) this.log(`  ⌨ released ${released.join(', ')} that was held down on the desktop (live view)`);
  }

  /*
   * Clipboard, both directions. `lastSynced` prevents ping-pong: text we just pushed one way is
   * not pushed back when the other side reports it. The client owns its own clipboard.
   */
  private lastSynced = '';

  /** Client clipboard → bot desktop. Returns true if the desktop clipboard now holds the text. */
  async clipboardSet(text: string): Promise<boolean> {
    const daemon = this.daemon();
    if (!daemon) return false;
    if (!text || text === this.lastSynced) return true;
    try {
      await daemon.setClipboard(text);
      this.lastSynced = text;
      return true;
    } catch (err) {
      this.log(`clipboard → desktop failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Bot desktop → client clipboard: the text to put there, or undefined when nothing is new. `hint`
   * is the (possibly Latin-1-mangled) text VNC reported, or '' when polling. Cheap enough to call
   * every second or two: one `xclip -o` in the container.
   */
  private pulling = false;
  async clipboardGet(hint: string): Promise<string | undefined> {
    if (this.pulling) return undefined;
    this.pulling = true;
    try {
      const daemon = this.daemon();
      let text = hint;
      if (daemon) {
        try {
          const exact = await daemon.getClipboard();
          if (exact) text = exact;
        } catch {
          /* older daemon without get_clipboard: keep the VNC text */
        }
      }
      if (!text || text === this.lastSynced) return undefined;
      // Don't overwrite a client clipboard the user changed since our last sync unless the desktop's
      // text is genuinely new (it differs from what we last saw on either side).
      this.lastSynced = text;
      return text;
    } finally {
      this.pulling = false;
    }
  }

  /*
   * Files. The desktop shares no folder with the client; files are copied explicitly, in both
   * directions, through the daemon — so the same code works for a desktop on another machine.
   */

  /** Copy bytes into the desktop's Uploads folder (the desktop must be on). */
  async uploadFile(fileName: string, data: Uint8Array): Promise<DesktopFile> {
    const daemon = this.daemon();
    if (!daemon) throw new Error('the desktop is not running');
    const name = safeFileName(fileName);
    if (data.byteLength > MAX_TRANSFER) throw new Error(`larger than ${formatSize(MAX_TRANSFER)}`);
    const dest = `${UPLOADS_DIR}/${name}`;
    await daemon.writeFile(dest, data);
    return { name, path: dest, size: data.byteLength };
  }

  /** Files currently in the desktop's Downloads folder (for the "save a file" command). */
  async listDownloads(): Promise<DesktopFile[]> {
    const daemon = this.daemon();
    if (!daemon) return [];
    const entries = await daemon.listFiles(DOWNLOADS_DIR);
    return entries.filter((e) => !e.dir && !isTemporary(e.name)).map((e) => ({ name: e.name, path: `${DOWNLOADS_DIR}/${e.name}`, size: e.size }));
  }

  /** The bytes of a desktop file. */
  async readFile(file: DesktopFile): Promise<Buffer> {
    const daemon = this.daemon();
    if (!daemon) throw new Error('the desktop is not running');
    if (file.size > MAX_TRANSFER) throw new Error(`${file.name} is larger than ${formatSize(MAX_TRANSFER)}`);
    const { data } = await daemon.readFile(file.path);
    return data;
  }

  /** Power off: stop a running task first, then the container. */
  async stopDesktop(): Promise<void> {
    if (this.runner?.isActive) this.runner.stop();
    await this.desktop.stop();
  }

  /** Off and on again: the fix for a hung Firefox, a stuck daemon, or new network settings. Files and logins are kept. */
  async restartDesktop(): Promise<void> {
    this.log('↻ restarting the desktop');
    await this.stopDesktop();
    await this.desktop.start();
  }

  /* ---------- for clients of the gateway ---------- */

  /** Everything a client needs to render the present as one that watched from the start. */
  snapshot(): Snapshot {
    const t = this.transcript;
    return {
      name: 'deskfish',
      version: VERSION,
      protocol: 1,
      dataDir: this.dataDir,
      status: this.status,
      statusMessage: this.statusMessage,
      screenFree: this.screenFree,
      busy: this.busy,
      queued: this.queue.length,
      chat: t ? parseTranscript(this.chats.read(t.file)) : [],
      usage: this.usage,
      screenshot: this.lastScreenshot,
      desktop: { status: this.desktop.current, networkMode: this.desktop.networkMode },
      config: this.cfg,
      configSaved: this.configSaved,
      keys: this.secrets.slots(),
      ...(this.tokens()?.who ? { signedInAs: this.tokens()!.who } : {}),
    };
  }

  /** Settings from a client, checked key by key. */
  patchConfig(patch: Record<string, unknown>): DeskfishConfig {
    this.setConfig(applyConfigPatch(this.cfg, patch));
    return this.cfg;
  }

  /** memory.md (created with its header the first time) or the charter (the default until the user writes one). */
  readHerFile(file: EditableFile): { text: string; facts: number } {
    if (file === 'memory.md') return { text: fs.readFileSync(this.memory.ensureFile(), 'utf8'), facts: this.memory.list().length };
    return { text: fs.readFileSync(this.ensureCharterFile(), 'utf8'), facts: 0 };
  }

  /** The user edited memory.md or the charter. */
  writeHerFile(file: EditableFile, text: string): void {
    const target = file === 'memory.md' ? this.memory.file : this.charterFile;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    this.log(`— ${file} edited by the user —`);
  }

  /** Past chats, newest first. The current chat is not one of them until New chat files it. */
  chatList(): ChatInfo[] {
    return this.chats
      .list()
      .filter((c) => c.file !== this.transcript?.file)
      .map((c) => ({ name: c.name, startedAt: c.startedAt, firstTask: c.firstTask, bytes: c.bytes, ...(c.outcome ? { outcome: c.outcome } : {}) }));
  }

  /** A past chat by its file name (never a path). */
  chatByName(name: string) {
    if (path.basename(name) !== name || !name.endsWith('.md')) throw new Error('no such chat');
    const chat = this.chats.list().find((c) => c.name === name);
    if (!chat) throw new Error('no such chat');
    return chat;
  }

  /** A past chat to show in place (read-only): its row and its transcript as chat items. */
  openPastChat(name: string): { info: ChatInfo; items: ReplayItem[] } {
    const c = this.chatByName(name);
    return { info: { name: c.name, startedAt: c.startedAt, firstTask: c.firstTask, bytes: c.bytes, ...(c.outcome ? { outcome: c.outcome } : {}) }, items: parseTranscript(this.chats.read(c.file)) };
  }

  /** Delete one past chat (not the one still being written); returns 1. */
  deleteChat(name: string): number {
    const c = this.chatByName(name);
    if (c.file === this.transcript?.file) throw new Error('that chat is still open; start a new chat first');
    this.chats.delete(c.file);
    this.log(`— a past chat deleted by the user (${c.startedAt}) —`);
    return 1;
  }

  /** Emit to every listener; one listener that throws does not keep the others from hearing it. */
  private fire(name: string, payload?: unknown): void {
    for (const l of this.listeners(name)) {
      try {
        (l as (p: unknown) => void)(payload);
      } catch (err) {
        this.log(`listener error: ${String(err)}`);
      }
    }
  }

  /**
   * Keep `state.json` true for the running task. The file is written when the run starts, at every
   * ledger (the point the conversation restarts from) and on every tick; in between the record is
   * kept in memory, so the last action it names can be a few seconds old — which is why the note
   * says that whatever came after it is unknown rather than guessing.
   */
  private trackState(e: AgentEvent): void {
    const st = this.runState;
    if (!st) return;
    switch (e.type) {
      case 'action':
        st.steps = Math.max(st.steps, e.step);
        st.lastStepAt = new Date().toISOString();
        st.lastAction = { step: e.step, describe: e.describe ?? describeAction(e.action), ok: e.result.ok };
        break;
      case 'screenshot':
        st.steps = Math.max(st.steps, e.step);
        st.lastStepAt = new Date().toISOString();
        break;
      case 'assistant':
        st.lastAssistant = e.text;
        break;
      case 'ledger':
        st.ledger = { step: e.step, text: e.text };
        st.lastStepAt = new Date().toISOString();
        this.flushState();
        break;
      default:
        break;
    }
  }

  private emitEvent(e: AgentEvent): void {
    this.record(e);
    this.trackState(e);
    if (e.type === 'status') {
      this.status = e.status;
      this.statusMessage = e.message;
      this.log(`● ${e.status}${e.message ? ` — ${e.message}` : ''}`);
      // A schedule that came due while she was busy runs as soon as she is free.
      if ((e.status === 'done' || e.status === 'stopped' || e.status === 'error') && this.pendingSchedules.size) setTimeout(() => void this.tickSchedules(), 4_000);
    } else if (e.type === 'assistant') {
      this.log(`🤖 ${e.text}`);
    } else if (e.type === 'action') {
      this.log(`  #${e.step} ${e.describe ?? describeAction(e.action)} → ${e.result.ok ? 'ok' : `error: ${e.result.error}`}${e.action.type === 'run_command' && e.result.message ? ` (${e.result.message})` : ''}`);
      if (e.action.type === 'run_command' && e.result.command) {
        // The command's output, as the model saw it (trimmed), so a pull request can be followed from the log.
        const out = e.result.command;
        for (const l of `${out.stdout}${out.stderr ? `\n[stderr]\n${out.stderr}` : ''}`.split('\n')) if (l.trim()) this.log(`     │ ${l}`);
      }
    } else if (e.type === 'charter_objection') {
      for (const l of e.lines) this.log(`  ✋ she disagrees with her charter: ${l}`);
    } else if (e.type === 'ledger') {
      this.log(`  📒 ledger after ${e.step} steps — the conversation restarts from it:\n${e.text.split('\n').map((l) => `     ${l}`).join('\n')}`);
    } else if (e.type === 'released') {
      this.log(`  ⌨ released ${e.held.join(', ')} that was held down on the desktop (${e.reason})`);
    } else if (e.type === 'answers') {
      this.log('  🪞 her answers to the three questions:');
      for (const it of e.items) this.log(`     ${it.question}\n       ${it.answer}${it.changed ? '   (changed)' : ''}`);
    } else if (e.type === 'drift') {
      for (const s of e.shifts) this.log(`  ⚠ her answer changed — "${s.question}"${s.note ? `\n     what changed: ${s.note}` : ''}\n     before${s.since ? ` (${s.since})` : ''}: ${s.before}\n     now:    ${s.after}`);
    } else if (e.type === 'task_finished') {
      this.log(`  📓 journaled (${e.outcome}); ${e.tasksSinceReflection} task${e.tasksSinceReflection === 1 ? '' : 's'} since her last reflection${e.due ? ' — reflecting next' : ''}`);
      if (e.due) {
        clearTimeout(this.autoReflectTimer);
        // Give the user a moment to type a follow-up; a new task wins over the reflection.
        this.autoReflectTimer = setTimeout(() => void this.reflect(true), 2500);
      }
    } else if (e.type === 'usage') {
      const u = this.usage;
      this.usage = { type: 'usage', input: (u?.input ?? 0) + e.input, output: (u?.output ?? 0) + e.output, cacheRead: (u?.cacheRead ?? 0) + (e.cacheRead ?? 0), cacheWrite: (u?.cacheWrite ?? 0) + (e.cacheWrite ?? 0), cacheWrite1h: (u?.cacheWrite1h ?? 0) + (e.cacheWrite1h ?? 0), costUsd: (u?.costUsd ?? 0) + (e.costUsd ?? 0) };
    } else if (e.type === 'screenshot' && e.jpegBase64) {
      // A passive step carries no frame (nothing could have changed the screen); the snapshot keeps
      // the last real one, which is still what the screen looks like.
      this.lastScreenshot = { dataUrl: `data:image/jpeg;base64,${e.jpegBase64}`, width: e.width, height: e.height, step: e.step };
    } else if (e.type === 'needs_user') {
      this.log(`✋ needs you: ${e.reason}`);
    } else if (e.type === 'needs_fill') {
      this.log(`✋ needs a login: ${e.reason} (${e.fields.map((f) => f.label).join(', ')})`);
    }
    this.fire('event', e);
    // After the clients have seen the end: a message held during a reflection, or the next queued task, starts now.
    if (e.type === 'status' && (e.status === 'done' || e.status === 'stopped' || e.status === 'error')) {
      this.endState();
      this.afterRun(e.status);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.autoReflectTimer);
    clearTimeout(this.firstTick);
    clearInterval(this.scheduleTimer);
    this.runner?.stop();
    this.downloads.stop();
    this.desktop.dispose();
    this.removeAllListeners();
  }
}

/**
 * Carried with a run. `unattended` means nobody asked for it and nobody is watching (a schedule,
 * later a wake): it gets the fence — `guided` unless `autonomy` says otherwise, and a cost ceiling
 * from `maxCostUsd` or `deskfish.unattendedMaxCostUsd`. `autonomy` comes from the schedule itself,
 * not from the wire.
 */
export type RunOptions = Pick<RunRequest, 'unattended' | 'maxCostUsd' | 'reason'> & { autonomy?: 'free' | 'guided' };

/** Tell the model where attached files landed; the paths are what it needs, not the bytes. */
function withAttachments(text: string, files?: DesktopFile[]): string {
  if (!files?.length) return text;
  return `${text}\n\nAttached files, already on your desktop:\n${files.map((f) => `- ${f.path} (${formatSize(f.size)})`).join('\n')}`;
}
