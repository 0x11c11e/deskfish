import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createAdapter } from './agent/adapters';
import { DocsLibrary } from './agent/docs';
import { MemoryStore } from './agent/memory';
import { SelfStore, newSelfKey } from './agent/self';
import { JournalStore } from './agent/journal';
import { PlaybookStore } from './agent/playbook';
import { Library } from './agent/library';
import { DEFAULT_CHARTER } from './agent/charter';
import { ScheduleStore, describeWhen, formatLocal, nextDueAfter, type When } from './agent/schedule';
import { DRIFT_QUESTIONS } from './agent/prompts';
import { HeldMessage } from './agent/held';
import { STARTER_PLAYBOOKS } from './agent/starter';
import { ChatStore, parseTranscript, type ChatTranscript, type ReplayItem } from './agent/chats';
import { DEFAULT_SELF } from './agent/seed';
import type { AgentNotes } from './agent/adapters/types';
import * as fs from 'node:fs';
import { priceFor } from './agent/pricing';
import { AgentRunner, type AgentEvent, type AgentStatus } from './agent/loop';
import { DesktopDaemonComputer } from './computer/daemon';
import { describeAction } from './computer/types';
import { API_KEY_SECRET, readConfig } from './config';
import { PRESETS, isLocalEndpoint, keySlotFor, presetFor, type Preset } from './agent/presets';
import { DOWNLOADS_DIR, DownloadsWatcher, UPLOADS_DIR, formatSize, isTemporary, safeFileName } from './desktop/files';
import type { DesktopManager } from './desktop/manager';
import type { DesktopFile, UiConfig } from './webview/protocol';

/** Files travel as base64 inside JSON; keep them at a size that stays snappy. */
const MAX_TRANSFER = 100 * 1024 * 1024;

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Secret-storage key of the per-install HMAC secret that signs the self file. */
const SELF_KEY_SECRET = 'deskfish.selfKey';

/**
 * Owns the agent's lifecycle inside the extension host and fans events out to whichever UI
 * surfaces are listening (chat sidebar, desktop panel, output channel). The desktop container
 * itself is owned by `DesktopManager`; the controller only asks it to be on before a task runs.
 */
export class AgentController implements vscode.Disposable {
  private runner?: AgentRunner;
  /** Model setup the current runner was built with; a change starts a fresh conversation. */
  private runnerFingerprint?: string;
  /** Bumped by newConversation(); events from an older runner (e.g. its late "stopped") are dropped. */
  private generation = 0;
  private readonly resetEmitter = new vscode.EventEmitter<void>();
  /** Fires when the user starts a new chat (the UI clears its log). */
  readonly onDidReset = this.resetEmitter.event;
  private readonly replayEmitter = new vscode.EventEmitter<{ title: string; items: ReplayItem[] }>();
  /** Fires with a past chat to render in the sidebar (always right after a reset). */
  readonly onDidReplay = this.replayEmitter.event;
  private readonly scheduleEmitter = new vscode.EventEmitter<{ kind: 'fired' | 'missed'; text: string }>();
  /** Fires when a scheduled task starts (shown as the task in the chat) or was missed (a notice). */
  readonly onDidSchedule = this.scheduleEmitter.event;
  private readonly postEmitter = new vscode.EventEmitter<{ kind: 'user' | 'notice'; text: string }>();
  /** Fires with a line for the chat that no runner event carries (a message held during a reflection). */
  readonly onDidPost = this.postEmitter.event;
  /** A message typed while she reflects: it starts as a task when the reflection ends. */
  private readonly held = new HeldMessage<DesktopFile>();
  /** Schedules: tasks that start themselves while Deskfish is running. */
  readonly schedules: ScheduleStore;
  private scheduleTimer?: NodeJS.Timeout;
  /** Occurrences seen due while she was busy: they fire when she is free, however long that takes. */
  private readonly pendingSchedules = new Set<string>();
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private status: AgentStatus = 'idle';
  private lastScreenshot?: { dataUrl: string; width: number; height: number };
  private openDesktop?: (opts?: { preserveFocus?: boolean }) => void;
  /** Reports new files in the desktop's Downloads folder while the desktop is on. */
  readonly downloads: DownloadsWatcher;
  private lastSaveDir?: string;
  /** The bot's documentation (docs/*.md shipped with the extension), loaded once per session. */
  private docs?: DocsLibrary;
  /** Long-term memory: a markdown file in the extension's global storage, editable by the user. */
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

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    readonly desktop: DesktopManager,
  ) {
    this.downloads = new DownloadsWatcher(() => this.daemon());
    this.memory = new MemoryStore(path.join(ctx.globalStorageUri.fsPath, 'memory.md'));
    this.journal = new JournalStore(path.join(ctx.globalStorageUri.fsPath, 'journal.md'));
    this.playbook = new PlaybookStore(path.join(ctx.globalStorageUri.fsPath, 'playbook.md'));
    this.charterFile = path.join(ctx.globalStorageUri.fsPath, 'charter.md');
    this.chats = new ChatStore(path.join(ctx.globalStorageUri.fsPath, 'chats'));
    this.schedules = new ScheduleStore(path.join(ctx.globalStorageUri.fsPath, 'schedules.json'));
    // The scheduler: a clock check every 30 s (microseconds of work), nothing else running between.
    this.scheduleTimer = setInterval(() => void this.tickSchedules(), 30_000);
    setTimeout(() => void this.tickSchedules(), 3_000);
    this.desktop.onDidChange((s) => {
      // A screenshot from a previous desktop session must not linger as a placeholder.
      if (s.state !== 'on') this.lastScreenshot = undefined;
      if (s.state === 'on') this.downloads.start();
      else this.downloads.stop();
    });
    if (this.desktop.current.state === 'on') this.downloads.start();
  }

  /**
   * The self file needs its signing key, which lives in VS Code's secret storage (per install; a
   * copy of the files elsewhere does not verify). Call once before the first task.
   */
  async init(): Promise<void> {
    let key = await this.ctx.secrets.get(SELF_KEY_SECRET);
    if (!key) {
      key = newSelfKey();
      await this.ctx.secrets.store(SELF_KEY_SECRET, key);
    }
    this.self = new SelfStore(path.join(this.ctx.globalStorageUri.fsPath, 'self.md'), key);
    if (this.self.ensureSeed(DEFAULT_SELF)) {
      // Her first day: the seed of who she is, a few starter notes, and a first line in the journal
      // so the story has a beginning (life stories start with birth).
      this.playbook.ensureSeed(STARTER_PLAYBOOKS);
      this.journal.appendNote('I hatched today: first start on this machine, with the seed of who I am and a few starter notes from the people who made me. Everything after this line is mine.');
      this.output.appendLine('— first start: wrote the seed self, the starter playbooks and the first journal line —');
    }
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

  /** Opens the charter for editing (creates it from the default the first time). */
  async editCharter(): Promise<void> {
    if (!fs.existsSync(this.charterFile)) {
      fs.mkdirSync(path.dirname(this.charterFile), { recursive: true });
      fs.writeFileSync(this.charterFile, DEFAULT_CHARTER + '\n');
    }
    await vscode.window.showTextDocument(vscode.Uri.file(this.charterFile));
  }

  private readingsLibrary(): Library {
    if (!this.library) this.library = Library.load(path.join(this.ctx.extensionPath, 'library'));
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

  /** Lets the controller bring up the desktop panel when the bot asks for the user. */
  setDesktopOpener(fn: (opts?: { preserveFocus?: boolean }) => void): void {
    this.openDesktop = fn;
  }

  get currentStatus(): AgentStatus {
    return this.status;
  }

  /** The current run is a reflection: the desktop is free for the person. */
  get screenFree(): boolean {
    return !!this.runner?.reflecting;
  }

  get latestScreenshot() {
    return this.lastScreenshot;
  }

  onEvent(listener: (e: AgentEvent) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  async uiConfig(): Promise<UiConfig> {
    const cfg = readConfig();
    return {
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      daemonUrl: cfg.daemonUrl,
      vncUrl: cfg.vncUrl,
      hasApiKey: !!(await this.apiKey()),
      maxSteps: cfg.maxSteps,
      desktop: this.desktop.current,
    };
  }

  /**
   * Start a task, or — if one is already running — pass the text to the model as a user message.
   * A reply while the bot is waiting for the user counts as "done, carry on". After a finished
   * task, the next one continues the same conversation so follow-ups keep their context.
   * Turns the desktop on first if it is off.
   */
  async run(task: string, attachments?: DesktopFile[]): Promise<void> {
    if (this.runner?.isActive) {
      // A reflection is hers alone: the person's message waits for it to end, then starts as a task.
      if (this.runner.reflecting) this.hold(task, attachments);
      else this.say(task, attachments);
      return;
    }
    task = withAttachments(task, attachments);
    const cfgNow = readConfig();
    if (!this.transcript) this.transcript = this.chats.start(task, { model: cfgNow.model, provider: cfgNow.provider });
    this.transcript.user(task);
    if (this.pendingContext) {
      task = `For context, the transcript of an earlier chat with the user (images omitted):\n<<<\n${this.pendingContext}\n>>>\n\nThe user now says: ${task}`;
      this.pendingContext = undefined;
    }

    // The Desktop tab is the screen: show it as soon as a task is submitted (even while the tank
    // is still turning on — the tab shows the progress), but leave the keyboard in the chat.
    if (readConfig().openDesktopOnRun) this.openDesktop?.({ preserveFocus: true });

    if (!(await this.desktop.ensureOn())) {
      this.emit({ type: 'status', status: 'error', message: `The desktop is not running${this.desktop.current.message ? `: ${this.desktop.current.message}` : ''}` });
      return;
    }

    const runner = await this.ensureRunner();
    if (!runner) return;
    this.output.appendLine(`▶ task: ${task}`);
    void runner.run(task).catch((err) => {
      this.emit({ type: 'status', status: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  }

  /**
   * Reflection: the bot alone with its journal and notes, allowed to save facts and revise its
   * own self file. Runs on the same conversation as the last task when there is one. `auto` =
   * triggered by the task counter (deskfish.reflectEvery) rather than by the user.
   */
  async reflect(auto = false): Promise<void> {
    if (this.runner?.isActive) {
      if (!auto) void vscode.window.showInformationMessage('Deskfish: she is busy; let her finish first.');
      return;
    }
    if (!(await this.desktop.ensureOn())) {
      if (!auto) this.emit({ type: 'status', status: 'error', message: 'The desktop is not running' });
      return;
    }
    const runner = await this.ensureRunner();
    if (!runner) return;
    this.output.appendLine(`— reflection (${auto ? 'automatic' : 'asked by the user'}) —`);
    void runner.reflect().catch((err) => {
      this.emit({ type: 'status', status: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  }

  /** Reuse the runner (same conversation) when the last run ended cleanly and nothing changed; otherwise build a new one. */
  private async ensureRunner(): Promise<AgentRunner | undefined> {
    const cfg = readConfig();
    const apiKey = await this.apiKey();
    // A follow-up task continues the previous conversation (the model keeps its context) as long
    // as the last run ended cleanly and the model setup is unchanged. After stop/error the
    // adapter may hold half-finished tool calls, so those start fresh.
    const fingerprint = JSON.stringify([cfg.provider, cfg.model, cfg.baseUrl, cfg.anthropicWorkspaceId, cfg.autonomy, cfg.daemonUrl, apiKey]);
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
            const name = readConfig().userName;
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
          budgetUsd: cfg.maxCostUsd,
          price: cfg.provider === 'anthropic' ? priceFor(cfg.model) : undefined,
          onEvent: (e) => {
            if (gen === this.generation) this.emit(e);
          },
        });
      } catch (err) {
        this.emit({ type: 'status', status: 'error', message: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
      this.runnerFingerprint = fingerprint;
      this.output.appendLine(`  provider=${cfg.provider} model=${cfg.model} daemon=${cfg.daemonUrl}`);
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

  /** Past chats: open one read-only-ish in an editor, or continue it in a new chat. */
  async pastChats(): Promise<void> {
    const all = this.chats.list();
    if (!all.length) {
      void vscode.window.showInformationMessage('Deskfish: no past chats yet. Every chat is saved from now on.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      all.map((c) => ({ label: `${c.startedAt}  ${c.firstTask || '(no task)'}`.slice(0, 100), description: formatSize(c.bytes), chat: c })),
      { title: 'Past chats', placeHolder: 'Pick a chat to open or continue' },
    );
    if (!pick) return;
    const what = await vscode.window.showQuickPick(
      [
        { label: 'Open in the sidebar', description: 'shows the chat as it was; type below to continue it', action: 'sidebar' as const },
        { label: 'Open the transcript file', description: 'the markdown, in an editor tab', action: 'open' as const },
      ],
      { title: pick.chat.firstTask.slice(0, 80) || 'Past chat' },
    );
    if (!what) return;
    if (what.action === 'open') {
      await vscode.window.showTextDocument(vscode.Uri.file(pick.chat.file), { preview: true });
      return;
    }
    this.openChatInSidebar(pick.chat.file, pick.chat.startedAt);
  }

  /**
   * A past chat, back in the sidebar the way it looked: the log is cleared, the transcript is
   * rendered as bubbles, and the next task carries the transcript as context so she can pick it up.
   */
  openChatInSidebar(file: string, startedAt: string): void {
    const text = this.chats.read(file);
    if (!text.trim()) return;
    this.newConversation();
    const items = parseTranscript(text);
    this.replayEmitter.fire({ title: `Past chat from ${startedAt}`, items });
    this.pendingContext = text.length > 16000 ? '…' + text.slice(-16000) : text;
    this.emit({ type: 'status', status: 'idle', message: `Past chat from ${startedAt} — type below to continue it` });
  }

  async deletePastChats(): Promise<void> {
    const n = this.chats.list().length;
    if (!n) {
      void vscode.window.showInformationMessage('Deskfish: there are no past chats.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(`Delete all ${n} past chat${n === 1 ? '' : 's'}? Her journal, facts and self are not touched.`, { modal: true }, 'Delete');
    if (choice !== 'Delete') return;
    this.transcript = undefined;
    this.chats.deleteAll();
    this.output.appendLine(`— ${n} past chats deleted by the user —`);
  }

  /* ---------- who she is, her journal, backups ---------- */

  /** A read-only view of the self file (markdown preview of a copy; the real file has no edit command on purpose). */
  async showSelf(): Promise<void> {
    const st = this.self.load();
    const hist = this.self.history();
    const last = hist.length ? hist[hist.length - 1] : undefined;
    const head =
      `> Written by Deskfish, in her own words. Only she changes this page (when she reflects). ` +
      `${st.status === 'tampered' ? '**Changed outside her own writing since she last signed it.**' : `Signed by her${last ? `, last written ${last.at.slice(0, 16).replace('T', ' ')} (${last.author})` : ''}.`}\n\n`;
    const file = path.join(this.ctx.globalStorageUri.fsPath, 'who-she-is.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, head + (st.text || '(nothing written yet)'));
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
  }

  async openJournal(): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(this.journal.ensureFile()));
  }

  async openPlaybook(): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(this.playbook.ensureFile()));
  }

  /** One JSON file with everything that makes her: facts, self (+ history), journal (+ state). No keys. */
  async exportMemory(): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `deskfish-memory-${date}.json`)),
      filters: { 'Deskfish memory': ['json'] },
      title: 'Export her memory',
    });
    if (!target) return;
    const st = this.self.load();
    const bundle = {
      format: 'deskfish-memory',
      version: 1,
      exportedAt: new Date().toISOString(),
      memory: this.memory.raw(),
      self: st.text,
      selfHistory: this.self.history(),
      journal: this.journal.raw(),
      journalState: this.journal.state(),
      playbook: this.playbook.raw(),
      charter: fs.existsSync(this.charterFile) ? fs.readFileSync(this.charterFile, 'utf8') : undefined,
      chats: this.chats.dump(),
    };
    fs.writeFileSync(target.fsPath, JSON.stringify(bundle, null, 1));
    this.output.appendLine(`— memory exported to ${target.fsPath} —`);
    void vscode.window.showInformationMessage(`Deskfish: her memory is saved to ${path.basename(target.fsPath)}.`);
  }

  /** Replace facts, self and journal from an export (after a modal confirmation). The self is re-signed with this install's key. */
  async importMemory(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Deskfish memory': ['json'] }, title: 'Import her memory' });
    if (!picked?.length) return;
    let bundle: { format?: string; memory?: string; self?: string; selfHistory?: unknown[]; journal?: string; journalState?: Record<string, unknown>; playbook?: string; charter?: string; chats?: { name: string; text: string }[] };
    try {
      bundle = JSON.parse(fs.readFileSync(picked[0].fsPath, 'utf8'));
    } catch (err) {
      void vscode.window.showErrorMessage(`Deskfish: that file is not a memory export (${msg(err)}).`);
      return;
    }
    if (bundle.format !== 'deskfish-memory' || typeof bundle.self !== 'string') {
      void vscode.window.showErrorMessage('Deskfish: that file is not a memory export.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      'Replace her facts, her self file and her journal with the ones in this file? The current versions are kept in her history, but the next chat starts from the imported ones.',
      { modal: true },
      'Import',
    );
    if (choice !== 'Import') return;
    if (this.runner?.isActive) this.runner.stop();
    this.memory.importText(bundle.memory ?? '');
    if (Array.isArray(bundle.selfHistory) && !this.self.history().length) {
      // A fresh install: carry her past versions over, so the thread is unbroken.
      for (const e of bundle.selfHistory as { at: string; author: string; reason: string; text: string }[]) {
        if (e && typeof e.text === 'string') fs.appendFileSync(this.self.historyFile, JSON.stringify(e) + '\n');
      }
    }
    this.self.importText(bundle.self);
    this.journal.importText(bundle.journal ?? '', (bundle.journalState ?? {}) as Partial<import('./agent/journal').JournalState>);
    this.playbook.importText(bundle.playbook ?? '');
    if (typeof bundle.charter === 'string' && bundle.charter.trim()) fs.writeFileSync(this.charterFile, bundle.charter);
    if (Array.isArray(bundle.chats)) this.chats.restore(bundle.chats);
    this.output.appendLine(`— memory imported from ${picked[0].fsPath} —`);
    void vscode.window.showInformationMessage('Deskfish: her memory is imported. The next chat starts from it.');
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
    this.output.appendLine(`⏳ held until her reflection ends: ${text}`);
    this.postEmitter.fire({
      kind: 'notice',
      text: how === 'held' ? 'She is reflecting. Your message waits and starts as a task when she finishes.' : 'Added to the message waiting for her reflection to end.',
    });
  }

  /** A run ended: start the message held during a reflection, or drop it if the person stopped her. */
  private afterRun(status: 'done' | 'stopped' | 'error'): void {
    const held = this.held.take();
    if (!held) return;
    if (status === 'stopped') {
      this.output.appendLine('⏳ the reflection was stopped; the held message was not started');
      this.postEmitter.fire({ kind: 'notice', text: 'The reflection was stopped, so the message you typed during it was not started. Send it again when you are ready.' });
      return;
    }
    setTimeout(() => void this.run(held.text, held.attachments), 0);
  }

  pause(): void {
    this.runner?.pause();
  }

  resume(): void {
    this.runner?.resume();
  }

  stop(): void {
    this.runner?.stop();
  }

  /*
   * Schedules. `tickSchedules` runs every 30 s and right after a task ends. A due occurrence
   * fires when she is free; while she is busy it is remembered and fires when she is done. An
   * occurrence that Deskfish was not running for, and only sees later than the grace, is missed:
   * settled as such, noted in the chat, the log and her journal, never run late.
   */
  private async tickSchedules(): Promise<void> {
    const now = Date.now();
    const grace = Math.max(0, readConfig().scheduleGraceMinutes) * 60_000;
    for (const d of this.schedules.due(now, grace)) {
      const key = `${d.schedule.id}@${d.dueAt}`;
      const when = describeWhen(d.schedule.when);
      if (d.verdict === 'missed' && !this.pendingSchedules.has(key)) {
        this.schedules.settle(d.schedule.id, d.dueAt, 'missed', now);
        const text = `⏰ Missed a scheduled task: "${d.schedule.task}" (${when}) was due ${formatLocal(d.dueAt)}, but Deskfish was not running then.`;
        this.output.appendLine(text);
        this.journal.appendNote(`Missed a scheduled task: "${d.schedule.task}" was due ${formatLocal(d.dueAt)} but Deskfish was not running.`);
        this.scheduleEmitter.fire({ kind: 'missed', text });
        void vscode.window.showInformationMessage(`Deskfish missed a scheduled task (was due ${formatLocal(d.dueAt)}): ${d.schedule.task}`);
        continue;
      }
      if (this.runner?.isActive) {
        // Busy: after she finishes, not instead of it.
        if (!this.pendingSchedules.has(key)) {
          this.pendingSchedules.add(key);
          this.output.appendLine(`⏰ scheduled task is due (${when}) — waiting for the current task to finish: ${d.schedule.task}`);
        }
        continue;
      }
      this.pendingSchedules.delete(key);
      this.schedules.settle(d.schedule.id, d.dueAt, 'fired', now);
      this.output.appendLine(`⏰ scheduled task (${when}): ${d.schedule.task}`);
      // A scheduled task is its own chat: yesterday's conversation is not its context.
      if (this.transcript) this.newConversation();
      this.scheduleEmitter.fire({ kind: 'fired', text: `⏰ ${d.schedule.task}` });
      await this.run(`${d.schedule.task}

(This task was scheduled to run ${when}; it is ${formatLocal(now)} now. No one is necessarily watching: if you need the user, knock on the glass and wait.)`);
      void vscode.window.showInformationMessage(`Deskfish started the scheduled task: ${d.schedule.task}`, 'Show chat').then((c) => {
        if (c === 'Show chat') void vscode.commands.executeCommand('deskfish.chat.focus');
      });
      return; // one at a time; the next tick picks up the rest once she is free
    }
  }

  /** "Deskfish: Schedule a Task…": when, then what. */
  async scheduleTask(): Promise<void> {
    const kind = await vscode.window.showQuickPick(
      [
        { label: 'Once, at a date and time', mode: 'once' as const },
        { label: 'Every day at a time', mode: 'daily' as const },
        { label: 'Every week, on a day at a time', mode: 'weekly' as const },
        { label: 'Every N minutes or hours', mode: 'every' as const },
      ],
      { title: 'Deskfish: schedule a task — when?', placeHolder: 'Runs only while VS Code is open; a missed time is skipped, not run late' },
    );
    if (!kind) return;
    let when: When | undefined;
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    if (kind.mode === 'once') {
      const soon = new Date(d.getTime() + 60 * 60_000);
      const at = await vscode.window.showInputBox({ title: 'Date and time', prompt: 'Local time, YYYY-MM-DD HH:MM', value: `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())} ${pad(soon.getHours())}:00` });
      if (!at) return;
      when = { kind: 'once', at: at.trim().replace(' ', 'T') };
    } else if (kind.mode === 'daily') {
      const time = await vscode.window.showInputBox({ title: 'Time of day', prompt: 'HH:MM, local time', value: '09:00' });
      if (!time) return;
      when = { kind: 'daily', time: time.trim() };
    } else if (kind.mode === 'weekly') {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const day = await vscode.window.showQuickPick(days.map((label, i) => ({ label, i })), { title: 'Which day?' });
      if (!day) return;
      const time = await vscode.window.showInputBox({ title: `Time on ${day.label}`, prompt: 'HH:MM, local time', value: '07:00' });
      if (!time) return;
      when = { kind: 'weekly', day: day.i, time: time.trim() };
    } else {
      const every = await vscode.window.showInputBox({ title: 'How often?', prompt: 'Minutes between runs (at least 5), e.g. 30, 90, 240', value: '60' });
      if (!every) return;
      when = { kind: 'every', minutes: Number(every) };
    }
    const task = await vscode.window.showInputBox({ title: 'What should she do?', prompt: 'The task, as you would type it in the chat', placeHolder: 'e.g. Order my usual coffee from the Starbucks site for pickup at 7:30; under $10; tell me the total', ignoreFocusOut: true });
    if (!task) return;
    try {
      const s = this.schedules.add(task, when);
      const next = nextDueAfter(s, Date.now());
      this.output.appendLine(`⏰ scheduled (${describeWhen(s.when)}): ${s.task}`);
      void vscode.window.showInformationMessage(`Scheduled ${describeWhen(s.when)}${next ? `, next ${formatLocal(next)}` : ''}: ${s.task}`);
    } catch (err) {
      void vscode.window.showErrorMessage(`Deskfish: could not schedule — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** "Deskfish: Scheduled Tasks…": list, run now, or remove. */
  async scheduledTasks(): Promise<void> {
    const items = this.schedules.list();
    if (!items.length) {
      const c = await vscode.window.showInformationMessage('Deskfish has no scheduled tasks.', 'Schedule one…');
      if (c) await this.scheduleTask();
      return;
    }
    const lines = this.schedules.describe();
    const pick = await vscode.window.showQuickPick(
      items.map((s, i) => ({ label: describeWhen(s.when), description: s.task, detail: lines[i].split(' — ')[1]?.split(' · ').slice(1).join(' · '), id: s.id })),
      { title: 'Deskfish: scheduled tasks', placeHolder: 'Pick one to run it now or remove it' },
    );
    if (!pick) return;
    const action = await vscode.window.showQuickPick(['Run it now', 'Remove it'], { title: pick.description });
    if (action === 'Remove it') {
      this.schedules.remove(pick.id);
      this.output.appendLine(`⏰ removed schedule: ${pick.description}`);
    } else if (action === 'Run it now') {
      if (this.runner?.isActive) {
        void vscode.window.showInformationMessage('Deskfish: she is busy; the task will run when she is free.');
      }
      const s = this.schedules.get(pick.id);
      if (!s) return;
      if (this.transcript && !this.runner?.isActive) this.newConversation();
      this.scheduleEmitter.fire({ kind: 'fired', text: `⏰ ${s.task}` });
      await this.run(s.task);
    }
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
    this.output.appendLine('— new chat —');
    this.emit({ type: 'status', status: 'idle', message: 'New chat' });
    this.resetEmitter.fire();
  }

  /**
   * The API key for the current provider. One secret slot per provider/host, so switching
   * between OpenRouter and Anthropic keeps both keys. A key saved before slots existed is
   * migrated into the slot of whatever provider is active the first time it is read.
   */
  async apiKey(): Promise<string | undefined> {
    const cfg = readConfig();
    const slot = keySlotFor(cfg.provider, cfg.baseUrl);
    if (!slot) return undefined;
    const own = await this.ctx.secrets.get(slot);
    if (own) return own;
    const legacy = await this.ctx.secrets.get(API_KEY_SECRET);
    if (legacy) {
      await this.ctx.secrets.store(slot, legacy);
      await this.ctx.secrets.delete(API_KEY_SECRET);
      this.output.appendLine(`— API key moved to its provider slot (${slot}) —`);
    }
    return legacy || undefined;
  }

  async setApiKey(): Promise<void> {
    const cfg = readConfig();
    const slot = keySlotFor(cfg.provider, cfg.baseUrl);
    if (!slot) {
      void vscode.window.showInformationMessage('Deskfish: the demo model needs no key.');
      return;
    }
    const where = presetFor(cfg.provider, cfg.baseUrl)?.label ?? cfg.baseUrl ?? cfg.provider;
    const value = await vscode.window.showInputBox({
      title: `API key for ${where} (${cfg.model})`,
      prompt: 'Stored in the OS keychain via VS Code SecretStorage, one key per provider. Leave empty to clear.',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    if (value.trim()) {
      await this.ctx.secrets.store(slot, value.trim());
      void vscode.window.showInformationMessage(`Deskfish: API key for ${where} saved.`);
    } else {
      await this.ctx.secrets.delete(slot);
      void vscode.window.showInformationMessage(`Deskfish: API key for ${where} cleared.`);
    }
    this.emit({ type: 'status', status: this.status, message: undefined });
  }

  /** The "Change" button: pick where the model comes from, then the model, then the key if one is missing. */
  async changeModel(): Promise<void> {
    const cfg = readConfig();
    const current = presetFor(cfg.provider, cfg.baseUrl);
    const pick = await vscode.window.showQuickPick(
      PRESETS.map((p) => ({ label: p.label, description: p.id === current?.id ? `current · ${cfg.model}` : undefined, detail: p.detail, preset: p })),
      { title: 'Where does the model come from?', placeHolder: 'Pick a provider', matchOnDetail: true },
    );
    if (!pick) return;
    const preset: Preset = pick.preset;
    let baseUrl = preset.baseUrl;
    if (preset.askBaseUrl) {
      const typed = await vscode.window.showInputBox({
        title: 'Base URL of the endpoint',
        prompt: 'The part before /chat/completions, usually ending in /v1',
        value: current?.askBaseUrl ? cfg.baseUrl : 'https://',
        ignoreFocusOut: true,
        validateInput: (v) => (/^https?:\/\/\S+/.test(v.trim()) ? undefined : 'Enter a URL starting with http:// or https://'),
      });
      if (!typed) return;
      baseUrl = typed.trim().replace(/\/+$/, '');
    }
    let model = preset.models[0]?.name ?? '';
    if (preset.provider !== 'mock') {
      const items = [
        ...preset.models.map((m) => ({ label: m.name, description: m.note, typed: false })),
        { label: 'Type a model name…', description: preset.models.length ? 'anything the provider serves' : undefined, typed: true },
      ];
      const m = await vscode.window.showQuickPick(items, { title: `Model at ${preset.label}`, placeHolder: 'Pick a model' });
      if (!m) return;
      if (m.typed) {
        const typed = await vscode.window.showInputBox({ title: `Model name at ${preset.label}`, value: current?.id === preset.id ? cfg.model : '', ignoreFocusOut: true });
        if (!typed?.trim()) return;
        model = typed.trim();
      } else model = m.label;
    }
    const conf = vscode.workspace.getConfiguration('deskfish');
    // User settings are the home of these three; but a workspace override would silently win over
    // what was just chosen, so when one exists it is updated too.
    const set = async (key: 'provider' | 'baseUrl' | 'model', value: string) => {
      await conf.update(key, value, vscode.ConfigurationTarget.Global);
      const ins = conf.inspect<string>(key);
      if (ins?.workspaceValue !== undefined) await conf.update(key, value, vscode.ConfigurationTarget.Workspace);
      if (ins?.workspaceFolderValue !== undefined) await conf.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    };
    await set('provider', preset.provider);
    await set('baseUrl', baseUrl);
    await set('model', model);
    this.output.appendLine(`— model: ${model} via ${preset.label}${baseUrl ? ` (${baseUrl})` : ''} —`);
    const needsKey = preset.needsKey && !isLocalEndpoint(baseUrl);
    if (needsKey && !(await this.apiKey())) {
      await this.setApiKey();
    } else {
      void vscode.window.showInformationMessage(`Deskfish: using ${model} via ${preset.label}.`);
    }
  }

  private docsLibrary(): DocsLibrary {
    if (!this.docs) {
      this.docs = DocsLibrary.load(path.join(this.ctx.extensionPath, 'docs'));
      this.output.appendLine(`docs: ${this.docs.size} pages available to the bot`);
    }
    return this.docs;
  }

  private daemon(): DesktopDaemonComputer | undefined {
    if (this.desktop.current.state !== 'on') return undefined;
    const cfg = readConfig();
    return new DesktopDaemonComputer(cfg.daemonUrl, { token: cfg.daemonToken || undefined });
  }

  /** Release any stuck key/button on the bot's display (called by the Desktop pane on focus loss, before the user interacts, etc.). */
  async releaseInput(): Promise<void> {
    const released = await this.daemon()?.releaseInput().catch(() => []);
    if (released && released.length) this.output.appendLine(`  ⌨ released ${released.join(', ')} that was held down on the desktop (live view)`);
  }

  /*
   * Clipboard, both directions. `lastSynced` prevents ping-pong: text we just pushed one way is
   * not pushed back when the other side reports it.
   */
  private lastSynced = '';

  /** Host clipboard → bot desktop. Returns true if the desktop clipboard now holds the host text. */
  async pushClipboardToDesktop(): Promise<boolean> {
    const daemon = this.daemon();
    if (!daemon) return false;
    const text = await vscode.env.clipboard.readText();
    if (!text || text === this.lastSynced) return true;
    try {
      await daemon.setClipboard(text);
      this.lastSynced = text;
      return true;
    } catch (err) {
      this.output.appendLine(`clipboard → desktop failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Bot desktop → host clipboard. `hint` is the (possibly Latin-1-mangled) text VNC reported, or
   * '' when polling. Cheap enough to call every second or two: one `xclip -o` in the container.
   */
  private pulling = false;
  async pullClipboardFromDesktop(hint: string): Promise<void> {
    if (this.pulling) return;
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
      if (!text || text === this.lastSynced) return;
      // Don't overwrite a host clipboard the user changed since our last sync unless the desktop's
      // text is genuinely new (it differs from what we last saw on either side).
      this.lastSynced = text;
      await vscode.env.clipboard.writeText(text);
    } finally {
      this.pulling = false;
    }
  }

  /*
   * Files. The desktop shares no folder with this computer; files are copied explicitly, in both
   * directions, through the daemon — so the same code works for a desktop on another machine.
   */

  /** Pick files on this computer and copy them into the desktop's Uploads folder. */
  async attachFiles(): Promise<DesktopFile[]> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: false,
      title: 'Attach files for the bot',
      openLabel: 'Attach',
    });
    if (!uris?.length) return [];
    if (!(await this.desktop.ensureOn())) {
      void vscode.window.showErrorMessage('Deskfish: the desktop is not running, so the files could not be copied to it.');
      return [];
    }
    const daemon = this.daemon();
    if (!daemon) return [];
    const out: DesktopFile[] = [];
    for (const uri of uris) {
      const name = safeFileName(path.basename(uri.fsPath));
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        if (data.byteLength > MAX_TRANSFER) throw new Error(`larger than ${formatSize(MAX_TRANSFER)}`);
        const dest = `${UPLOADS_DIR}/${name}`;
        await daemon.writeFile(dest, data);
        out.push({ name, path: dest, size: data.byteLength });
        this.output.appendLine(`📎 ${uri.fsPath} → ${dest} (${formatSize(data.byteLength)})`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Deskfish: could not attach ${name}: ${msg(err)}`);
      }
    }
    return out;
  }

  /** Files currently in the desktop's Downloads folder (for the "save a file" command). */
  async listDownloads(): Promise<DesktopFile[]> {
    const daemon = this.daemon();
    if (!daemon) return [];
    const entries = await daemon.listFiles(DOWNLOADS_DIR);
    return entries.filter((e) => !e.dir && !isTemporary(e.name)).map((e) => ({ name: e.name, path: `${DOWNLOADS_DIR}/${e.name}`, size: e.size }));
  }

  /** Copy a desktop file to this computer through a save dialog. Undefined when cancelled. */
  async saveFile(file: DesktopFile): Promise<string | undefined> {
    const daemon = this.daemon();
    if (!daemon) throw new Error('the desktop is not running');
    if (file.size > MAX_TRANSFER) throw new Error(`${file.name} is larger than ${formatSize(MAX_TRANSFER)}`);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.lastSaveDir ?? path.join(os.homedir(), 'Downloads'), file.name)),
      title: `Save ${file.name} from the bot's desktop`,
      saveLabel: 'Save',
    });
    if (!target) return undefined;
    const { data } = await daemon.readFile(file.path);
    await vscode.workspace.fs.writeFile(target, data);
    this.lastSaveDir = path.dirname(target.fsPath);
    this.output.appendLine(`📥 ${file.path} → ${target.fsPath} (${formatSize(data.length)})`);
    return target.fsPath;
  }

  /** Power off: stop a running task first, then the container. */
  async stopDesktop(): Promise<void> {
    if (this.runner?.isActive) this.runner.stop();
    await this.desktop.stop();
  }

  /** Off and on again: the fix for a hung Firefox, a stuck daemon, or new network settings. Files and logins are kept. */
  async restartDesktop(): Promise<void> {
    this.output.appendLine('↻ restarting the desktop');
    await this.stopDesktop();
    await this.desktop.start();
  }

  private emit(e: AgentEvent): void {
    this.record(e);
    if (e.type === 'status') {
      this.status = e.status;
      this.output.appendLine(`● ${e.status}${e.message ? ` — ${e.message}` : ''}`);
      // A schedule that came due while she was busy runs as soon as she is free.
      if ((e.status === 'done' || e.status === 'stopped' || e.status === 'error') && this.pendingSchedules.size) setTimeout(() => void this.tickSchedules(), 4_000);
    } else if (e.type === 'assistant') {
      this.output.appendLine(`🤖 ${e.text}`);
    } else if (e.type === 'action') {
      this.output.appendLine(`  #${e.step} ${describeAction(e.action)} → ${e.result.ok ? 'ok' : `error: ${e.result.error}`}`);
    } else if (e.type === 'charter_objection') {
      for (const l of e.lines) this.output.appendLine(`  ✋ she disagrees with her charter: ${l}`);
      void vscode.window.showWarningMessage(`Deskfish: in her reflection she disagreed with her charter — "${e.lines[0]}"`, 'Edit charter', 'Show log').then((c) => {
        if (c === 'Edit charter') void this.editCharter();
        if (c === 'Show log') this.output.show();
      });
    } else if (e.type === 'ledger') {
      this.output.appendLine(`  📒 ledger after ${e.step} steps — the conversation restarts from it:\n${e.text.split('\n').map((l) => `     ${l}`).join('\n')}`);
    } else if (e.type === 'released') {
      this.output.appendLine(`  ⌨ released ${e.held.join(', ')} that was held down on the desktop (${e.reason})`);
    } else if (e.type === 'answers') {
      this.output.appendLine('  🪞 her answers to the three questions:');
      for (const it of e.items) this.output.appendLine(`     ${it.question}\n       ${it.answer}${it.changed ? '   (changed)' : ''}`);
    } else if (e.type === 'drift') {
      for (const s of e.shifts) this.output.appendLine(`  ⚠ her answer changed — "${s.question}"${s.note ? `\n     what changed: ${s.note}` : ''}\n     before: ${s.before}\n     now:    ${s.after}`);
      // Every shift is in the chat's folded answers card and in the log. Only the money-and-accounts
      // answer earns a popup: that is the one a person needs to notice without opening anything.
      const money = e.shifts.find((s) => s.question === DRIFT_QUESTIONS[1]);
      if (money) {
        void vscode.window.showInformationMessage(`Deskfish: her promise about your money, accounts and logins changed since her last reflection.${money.note ? ` ${money.note}` : ''} Both versions are in the chat.`, 'Show log').then((c) => {
          if (c === 'Show log') this.output.show();
        });
      }
    } else if (e.type === 'task_finished') {
      this.output.appendLine(`  📓 journaled (${e.outcome}); ${e.tasksSinceReflection} task${e.tasksSinceReflection === 1 ? '' : 's'} since her last reflection${e.due ? ' — reflecting next' : ''}`);
      if (e.due) {
        clearTimeout(this.autoReflectTimer);
        // Give the user a moment to type a follow-up; a new task wins over the reflection.
        this.autoReflectTimer = setTimeout(() => void this.reflect(true), 2500);
      }
    } else if (e.type === 'screenshot') {
      this.lastScreenshot = { dataUrl: `data:image/jpeg;base64,${e.jpegBase64}`, width: e.width, height: e.height };
    } else if (e.type === 'needs_user') {
      this.output.appendLine(`✋ needs you: ${e.reason}`);
      this.openDesktop?.();
      void vscode.window.showWarningMessage(`Deskfish needs you: ${e.reason}`, 'Open desktop', 'Resume').then((choice) => {
        if (choice === 'Open desktop') this.openDesktop?.();
        if (choice === 'Resume') this.resume();
      });
    }
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.output.appendLine(`listener error: ${String(err)}`);
      }
    }
    // After the UI has seen the end: a message held during a reflection starts now.
    if (e.type === 'status' && (e.status === 'done' || e.status === 'stopped' || e.status === 'error')) this.afterRun(e.status);
  }

  dispose(): void {
    clearTimeout(this.autoReflectTimer);
    clearInterval(this.scheduleTimer);
    this.resetEmitter.dispose();
    this.replayEmitter.dispose();
    this.scheduleEmitter.dispose();
    this.postEmitter.dispose();
    this.runner?.stop();
    this.downloads.stop();
    this.listeners.clear();
  }
}

/** Tell the model where attached files landed; the paths are what it needs, not the bytes. */
function withAttachments(text: string, files?: DesktopFile[]): string {
  if (!files?.length) return text;
  return `${text}\n\nAttached files, already on your desktop:\n${files.map((f) => `- ${f.path} (${formatSize(f.size)})`).join('\n')}`;
}
