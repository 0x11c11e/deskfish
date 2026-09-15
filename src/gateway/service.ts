import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAdapter } from '../agent/adapters';
import { DocsLibrary } from '../agent/docs';
import { MemoryStore } from '../agent/memory';
import { SelfStore } from '../agent/self';
import { JournalStore, type JournalState } from '../agent/journal';
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
import { describeAction } from '../computer/types';
import { maskSecrets } from '../agent/secrets';
import { keySlotFor } from '../agent/presets';
import { DOWNLOADS_DIR, DownloadsWatcher, UPLOADS_DIR, formatSize, isTemporary, safeFileName, type NewDownload } from '../desktop/files';
import { DesktopSupervisor, type DesktopStatus, type SupervisorOptions } from '../desktop/supervisor';
import type { DesktopFile } from '../webview/protocol';
import type { DeskfishConfig } from './config';
import { SecretsFile } from './storage';

/** Files travel as base64 inside JSON; keep them at a size that stays snappy. */
export const MAX_TRANSFER = 100 * 1024 * 1024;

export interface ServiceOptions {
  /** Where her files live: memory.md, self.md, journal.md, playbook.md, charter.md, chats/, schedules.json. */
  dataDir: string;
  /** What ships with Deskfish: docs/, library/, docker/desktop. The extension's folder today. */
  resourceDir: string;
  config: DeskfishConfig;
  /** API keys by slot and the self key; `<dataDir>/secrets.json` when not given. */
  secrets?: SecretsFile;
  /** One line per call; the output channel in VS Code, a log file under the gateway. */
  log?: (line: string) => void;
  /** Tests replace the container engine. */
  createEngine?: SupervisorOptions['createEngine'];
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
  private readonly queue: { task: string; attachments?: DesktopFile[] }[] = [];
  /** Schedules: tasks that start themselves while Deskfish is running. */
  readonly schedules: ScheduleStore;
  private scheduleTimer?: NodeJS.Timeout;
  private firstTick?: NodeJS.Timeout;
  /** Occurrences seen due while she was busy: they fire when she is free, however long that takes. */
  private readonly pendingSchedules = new Set<string>();
  private status: AgentStatus = 'idle';
  private lastScreenshot?: { dataUrl: string; width: number; height: number };
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
    this.log = opts.log ?? (() => {});
    this.resourceDir = opts.resourceDir;
    this.dataDir = opts.dataDir;
    this.secrets = opts.secrets ?? new SecretsFile(path.join(opts.dataDir, 'secrets.json'));
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
    this.scheduleTimer = setInterval(() => void this.tickSchedules(), 30_000);
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
  }

  /* ---------- config and keys (pushed in by the client; the service reads no settings of its own) ---------- */

  get config(): DeskfishConfig {
    return this.cfg;
  }

  /** New settings. A running task keeps its runner; the next run rebuilds it when the model setup changed. */
  setConfig(cfg: DeskfishConfig): void {
    this.cfg = cfg;
    this.fire('config', cfg);
  }

  /** The API key for a slot (`deskfish.apiKey.<anthropic|host>`), kept in the secrets file; empty clears it. */
  setKey(slot: string, key: string | undefined): void {
    if (this.secrets.set(slot, key || undefined)) this.fire('keys', this.secrets.slots());
  }

  /** The API key for the current provider's slot. */
  apiKey(): string | undefined {
    const slot = keySlotFor(this.cfg.provider, this.cfg.baseUrl);
    return slot ? this.secrets.get(slot) : undefined;
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

  get busy(): boolean {
    return !!this.runner?.isActive;
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
  async run(task: string, attachments?: DesktopFile[]): Promise<void> {
    if (this.runner?.isActive) {
      // A reflection is hers alone: the person's message waits for it to end, then starts as a task.
      if (this.runner.reflecting) this.hold(task, attachments);
      else this.enqueue(task, attachments);
      return;
    }
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

    if (!(await this.desktop.ensureOn())) {
      this.emitEvent({ type: 'status', status: 'error', message: `The desktop is not running${this.desktop.current.message ? `: ${this.desktop.current.message}` : ''}` });
      return;
    }

    const runner = this.ensureRunner();
    if (!runner) return;
    this.log(`▶ task: ${maskSecrets(task)}`);
    void runner.run(task).catch((err) => {
      this.emitEvent({ type: 'status', status: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  }

  /**
   * Reflection: the bot alone with its journal and notes, allowed to save facts and revise its
   * own self file. Runs on the same conversation as the last task when there is one. `auto` =
   * triggered by the task counter (deskfish.reflectEvery) rather than by the user.
   */
  async reflect(auto = false): Promise<'busy' | 'started' | 'failed'> {
    if (this.runner?.isActive) return 'busy';
    if (!(await this.desktop.ensureOn())) {
      if (!auto) this.emitEvent({ type: 'status', status: 'error', message: 'The desktop is not running' });
      return 'failed';
    }
    const runner = this.ensureRunner();
    if (!runner) return 'failed';
    this.log(`— reflection (${auto ? 'automatic' : 'asked by the user'}) —`);
    void runner.reflect().catch((err) => {
      this.emitEvent({ type: 'status', status: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    return 'started';
  }

  /** Reuse the runner (same conversation) when the last run ended cleanly and nothing changed; otherwise build a new one. */
  private ensureRunner(): AgentRunner | undefined {
    const cfg = this.cfg;
    const apiKey = this.apiKey();
    // A follow-up task continues the previous conversation (the model keeps its context) as long
    // as the last run ended cleanly and the model setup is unchanged. After stop/error the
    // adapter may hold half-finished tool calls, so those start fresh.
    const fingerprint = JSON.stringify([cfg.provider, cfg.model, cfg.baseUrl, cfg.anthropicWorkspaceId, cfg.autonomy, cfg.daemonUrl, apiKey, cfg.effort, cfg.cacheTtl]);
    let runner = this.runner;
    if (!runner || runner.currentStatus !== 'done' || fingerprint !== this.runnerFingerprint) {
      try {
        const docs = this.docsLibrary();
        const adapter = createAdapter({
          provider: cfg.provider,
          model: cfg.model,
          baseUrl: cfg.baseUrl || undefined,
          apiKey: apiKey || undefined,
          workspaceId: cfg.anthropicWorkspaceId || undefined,
          autonomy: cfg.autonomy,
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
          budgetUsd: cfg.maxCostUsd,
          price: priceForConfig({ provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl }),
          onEvent: (e) => {
            if (gen === this.generation) this.emitEvent(e);
          },
        });
      } catch (err) {
        this.emitEvent({ type: 'status', status: 'error', message: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
      this.runnerFingerprint = fingerprint;
      this.log(`  provider=${cfg.provider} model=${cfg.model} daemon=${cfg.daemonUrl}`);
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
        if (a === 'wait_for') {
          // A standby reads as its own line in the transcript, like in the chat.
          t.note(e.result.ok ? `⏳ ${(e.result.message ?? 'Stood by').split(/[;.] /)[0]} (${describeAction(e.action)})` : `⏳ Standby failed: ${e.result.error ?? ''}`);
          break;
        }
        const memoryish = a === 'remember' || a === 'forget' || a === 'revise_self' || a === 'restore_self' || a === 'note' || a === 'save_playbook' || a === 'archive_story';
        if (memoryish) t.note(e.result.ok ? (e.result.message ?? describeAction(e.action)) : `${describeAction(e.action)} — not done: ${e.result.error ?? ''}`);
        else t.action(e.step, describeAction(e.action), e.result.ok);
        break;
      }
      case 'needs_user':
        t.needsUser(e.reason);
        break;
      case 'status':
        if (e.status === 'done' || e.status === 'stopped' || e.status === 'error') t.status(`${e.status}${e.message ? ` — ${e.message}` : ''}`);
        break;
      case 'ledger':
        t.note(`📒 Ledger after ${e.step} steps: ${e.text.replace(/\s*\n+\s*/g, ' / ')}`);
        break;
      case 'drift':
        for (const s of e.shifts) t.note(`Her answer changed — "${s.question}"${s.note ? ` ${s.note}` : ''} Before: ${s.before} Now: ${s.after}`);
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

  /** Delete every past chat; returns how many there were. */
  deleteAllChats(): number {
    const n = this.chats.list().length;
    this.transcript = undefined;
    this.chats.deleteAll();
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
  private enqueue(task: string, attachments?: DesktopFile[]): void {
    this.queue.push({ task, attachments });
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
    if (next) setTimeout(() => void this.run(next.task, next.attachments), 0);
  }

  pause(): void {
    this.runner?.pause();
  }

  resume(): void {
    this.runner?.resume();
  }

  /** Stop: the running task ends and the tasks waiting behind it are dropped (Stop means stop). */
  stop(): void {
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
        this.fire('schedule', { kind: 'missed', text, task: d.schedule.task, dueAt: d.dueAt, auto: true });
        continue;
      }
      if (this.runner?.isActive) {
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
      await this.run(`${d.schedule.task}

(This task was scheduled to run ${when}; it is ${formatLocal(now)} now. No one is necessarily watching: if you need the user, knock on the glass and wait.)`);
      return; // one at a time; the next tick picks up the rest once she is free
    }
  }

  addSchedule(task: string, when: When): Schedule {
    const s = this.schedules.add(task, when);
    this.log(`⏰ scheduled (${describeWhen(s.when)}): ${s.task}`);
    return s;
  }

  removeSchedule(id: string): void {
    const s = this.schedules.get(id);
    this.schedules.remove(id);
    if (s) this.log(`⏰ removed schedule: ${s.task}`);
  }

  /** "Run it now": its own chat when she is free; queued behind the current task when she is not. */
  async runSchedule(id: string): Promise<void> {
    const s = this.schedules.get(id);
    if (!s) return;
    if (this.transcript && !this.runner?.isActive) this.newConversation();
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

  private emitEvent(e: AgentEvent): void {
    this.record(e);
    if (e.type === 'status') {
      this.status = e.status;
      this.log(`● ${e.status}${e.message ? ` — ${e.message}` : ''}`);
      // A schedule that came due while she was busy runs as soon as she is free.
      if ((e.status === 'done' || e.status === 'stopped' || e.status === 'error') && this.pendingSchedules.size) setTimeout(() => void this.tickSchedules(), 4_000);
    } else if (e.type === 'assistant') {
      this.log(`🤖 ${e.text}`);
    } else if (e.type === 'action') {
      this.log(`  #${e.step} ${describeAction(e.action)} → ${e.result.ok ? 'ok' : `error: ${e.result.error}`}${e.action.type === 'run_command' && e.result.message ? ` (${e.result.message})` : ''}`);
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
      for (const s of e.shifts) this.log(`  ⚠ her answer changed — "${s.question}"${s.note ? `\n     what changed: ${s.note}` : ''}\n     before: ${s.before}\n     now:    ${s.after}`);
    } else if (e.type === 'task_finished') {
      this.log(`  📓 journaled (${e.outcome}); ${e.tasksSinceReflection} task${e.tasksSinceReflection === 1 ? '' : 's'} since her last reflection${e.due ? ' — reflecting next' : ''}`);
      if (e.due) {
        clearTimeout(this.autoReflectTimer);
        // Give the user a moment to type a follow-up; a new task wins over the reflection.
        this.autoReflectTimer = setTimeout(() => void this.reflect(true), 2500);
      }
    } else if (e.type === 'screenshot') {
      this.lastScreenshot = { dataUrl: `data:image/jpeg;base64,${e.jpegBase64}`, width: e.width, height: e.height };
    } else if (e.type === 'needs_user') {
      this.log(`✋ needs you: ${e.reason}`);
    }
    this.fire('event', e);
    // After the clients have seen the end: a message held during a reflection, or the next queued task, starts now.
    if (e.type === 'status' && (e.status === 'done' || e.status === 'stopped' || e.status === 'error')) this.afterRun(e.status);
  }

  dispose(): void {
    clearTimeout(this.autoReflectTimer);
    clearTimeout(this.firstTick);
    clearInterval(this.scheduleTimer);
    this.runner?.stop();
    this.downloads.stop();
    this.desktop.dispose();
    this.removeAllListeners();
  }
}

/** Tell the model where attached files landed; the paths are what it needs, not the bytes. */
function withAttachments(text: string, files?: DesktopFile[]): string {
  if (!files?.length) return text;
  return `${text}\n\nAttached files, already on your desktop:\n${files.map((f) => `- ${f.path} (${formatSize(f.size)})`).join('\n')}`;
}
