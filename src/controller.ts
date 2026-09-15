import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { describeWhen, formatLocal, nextDueAfter, type When } from './agent/schedule';
import { DRIFT_QUESTIONS } from './agent/prompts';
import type { ReplayItem } from './agent/chats';
import type { AgentEvent, AgentStatus } from './agent/loop';
import { API_KEY_SECRET, readConfig } from './config';
import { PRESETS, isLocalEndpoint, keySlotFor, presetFor, type Preset } from './agent/presets';
import { formatSize, safeFileName, type NewDownload } from './desktop/files';
import { DesktopManager } from './desktop/manager';
import { DeskfishService, MAX_TRANSFER, type MemoryBundle } from './gateway/service';
import { dataDir, migrateData } from './gateway/storage';
import type { DesktopFile, UiConfig } from './webview/protocol';

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Secret-storage key of the per-install HMAC secret that signs the self file. */
const SELF_KEY_SECRET = 'deskfish.selfKey';

/**
 * The VS Code side of Deskfish: commands, notifications, the output channel, file pickers and save
 * dialogs, the clipboard, the model picker and SecretStorage. Everything else — the stores, the
 * runner and its queue, transcripts, schedules, the Downloads watcher, the desktop — belongs to the
 * `DeskfishService`, which runs in-process for now. Settings and keys are pushed into it; its
 * events come back out to the chat sidebar and the Desktop tab.
 */
export class AgentController implements vscode.Disposable {
  readonly service: DeskfishService;
  readonly desktop: DesktopManager;
  private openDesktop?: (opts?: { preserveFocus?: boolean }) => void;
  private lastSaveDir?: string;
  private readonly subs: vscode.Disposable[] = [];

  /** Fires when the user starts a new chat (the UI clears its log). */
  readonly onDidReset: vscode.Event<void>;
  /** Fires with a past chat to render in the sidebar (always right after a reset). */
  readonly onDidReplay: vscode.Event<{ title: string; items: ReplayItem[] }>;
  /** Fires when a scheduled task starts (shown as the task in the chat) or was missed (a notice). */
  readonly onDidSchedule: vscode.Event<{ kind: 'fired' | 'missed'; text: string }>;
  /** Fires with a line for the chat that no runner event carries (a message held during a reflection). */
  readonly onDidPost: vscode.Event<{ kind: 'user' | 'notice'; text: string }>;
  /** A new file appeared in the desktop's Downloads folder. */
  readonly onDidDownload: vscode.Event<NewDownload>;

  /** Her files move out of globalStorage into the data dir (once) before the service opens them. */
  static async create(ctx: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<AgentController> {
    const cfg = readConfig();
    const slots = new Set([...PRESETS.map((p) => keySlotFor(p.provider, p.baseUrl)), keySlotFor(cfg.provider, cfg.baseUrl)].filter((s): s is string => !!s));
    try {
      for (const k of (await ctx.secrets.keys?.()) ?? []) if (k.startsWith(`${API_KEY_SECRET}.`)) slots.add(k);
    } catch {
      /* SecretStorage.keys() needs VS Code 1.97; the presets' slots are enough */
    }
    const legacy = await ctx.secrets.get(API_KEY_SECRET);
    const current = keySlotFor(cfg.provider, cfg.baseUrl);
    try {
      await migrateData({
        from: ctx.globalStorageUri.fsPath,
        to: dataDir(),
        // A key saved before slots existed belongs to the provider that is active now.
        readSecret: async (name) => (await ctx.secrets.get(name)) ?? (name === current ? legacy : undefined),
        slots: [...slots],
        selfKeySecret: SELF_KEY_SECRET,
        log: (line) => output.appendLine(line),
      });
    } catch (err) {
      output.appendLine(`✖ moving her files to ${dataDir()} failed: ${msg(err)}`);
      void vscode.window.showErrorMessage(`Deskfish: could not move her files to ${dataDir()} — ${msg(err)}`, 'Show log').then((c) => {
        if (c) output.show();
      });
    }
    return new AgentController(ctx, output);
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.service = new DeskfishService({
      dataDir: dataDir(),
      resourceDir: ctx.extensionPath,
      config: readConfig(),
      log: (line) => this.output.appendLine(line),
    });
    this.desktop = new DesktopManager(this.service.desktop, output);
    this.onDidReset = this.relay<void>('reset');
    this.onDidReplay = this.relay('replay');
    this.onDidSchedule = this.relay('schedule');
    this.onDidPost = (listener) => this.relay<{ text: string }>('notice')((n) => listener({ kind: 'notice', text: n.text }));
    this.onDidDownload = this.relay('download');

    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('deskfish')) void this.syncSettings();
      }),
      this.ctx.secrets.onDidChange((e) => {
        if (e.key.startsWith('deskfish.')) void this.syncSettings();
      }),
      this.relay<{ text: string }>('task')(() => {
        // The Desktop tab is the screen: show it as soon as a task is submitted (even while the tank
        // is still turning on — the tab shows the progress), but leave the keyboard in the chat.
        if (readConfig().openDesktopOnRun) this.openDesktop?.({ preserveFocus: true });
      }),
      this.relay<{ kind: 'fired' | 'missed'; task: string; dueAt?: number; auto: boolean }>('schedule')((s) => {
        if (!s.auto) return;
        if (s.kind === 'missed') {
          void vscode.window.showInformationMessage(`Deskfish missed a scheduled task (was due ${formatLocal(s.dueAt ?? Date.now())}): ${s.task}`);
          return;
        }
        void vscode.window.showInformationMessage(`Deskfish started the scheduled task: ${s.task}`, 'Show chat').then((c) => {
          if (c === 'Show chat') void vscode.commands.executeCommand('deskfish.chat.focus');
        });
      }),
      this.onEvent((e) => this.notify(e)),
    );
  }

  /** A service event as a VS Code event. */
  private relay<T>(name: string): vscode.Event<T> {
    return (listener: (e: T) => unknown) => {
      const fn = (e: T) => listener(e);
      this.service.on(name, fn);
      return new vscode.Disposable(() => this.service.off(name, fn));
    };
  }

  /** Push settings and the key, then open her self (its signing key is in the data dir's secrets file). Call once before the first task. */
  async init(): Promise<void> {
    await this.syncSettings();
    this.service.init();
  }

  /** Push the current settings and the current provider's key into the service. */
  private async syncSettings(): Promise<void> {
    const cfg = readConfig();
    const slot = keySlotFor(cfg.provider, cfg.baseUrl);
    const key = await this.apiKey();
    this.service.setConfig(cfg);
    // Only a key VS Code holds is pushed: a slot empty here may hold a key set elsewhere. Clearing is setApiKey's.
    if (slot && key) this.service.setKey(slot, key);
  }

  get memory() {
    return this.service.memory;
  }

  /** Opens the charter for editing (creates it from the default the first time). */
  async editCharter(): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(this.service.ensureCharterFile()));
  }

  /** Lets the controller bring up the desktop panel when the bot asks for the user. */
  setDesktopOpener(fn: (opts?: { preserveFocus?: boolean }) => void): void {
    this.openDesktop = fn;
  }

  get currentStatus(): AgentStatus {
    return this.service.currentStatus;
  }

  /** The current run is a reflection: the desktop is free for the person. */
  get screenFree(): boolean {
    return this.service.screenFree;
  }

  get latestScreenshot() {
    return this.service.latestScreenshot;
  }

  onEvent(listener: (e: AgentEvent) => void): vscode.Disposable {
    return this.relay<AgentEvent>('event')(listener);
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

  /** Start a task (queued behind a running one, held during a reflection). */
  async run(task: string, attachments?: DesktopFile[]): Promise<void> {
    await this.syncSettings();
    await this.service.run(task, attachments);
  }

  /** Let her reflect now (the command). */
  async reflect(auto = false): Promise<void> {
    await this.syncSettings();
    const r = await this.service.reflect(auto);
    if (r === 'busy' && !auto) void vscode.window.showInformationMessage('Deskfish: she is busy; let her finish first.');
  }

  say(text: string, attachments?: DesktopFile[]): void {
    this.service.say(text, attachments);
  }

  pause(): void {
    this.service.pause();
  }

  resume(): void {
    this.service.resume();
  }

  stop(): void {
    this.service.stop();
  }

  newConversation(): void {
    this.service.newConversation();
  }

  /** What only VS Code shows for an event: popups, and the Desktop tab when she knocks. */
  private notify(e: AgentEvent): void {
    if (e.type === 'charter_objection') {
      void vscode.window.showWarningMessage(`Deskfish: in her reflection she disagreed with her charter — "${e.lines[0]}"`, 'Edit charter', 'Show log').then((c) => {
        if (c === 'Edit charter') void this.editCharter();
        if (c === 'Show log') this.output.show();
      });
    } else if (e.type === 'drift') {
      // Every shift is in the chat's folded answers card and in the log. Only the money-and-accounts
      // answer earns a popup: that is the one a person needs to notice without opening anything.
      const money = e.shifts.find((s) => s.question === DRIFT_QUESTIONS[1]);
      if (money) {
        void vscode.window.showInformationMessage(`Deskfish: her promise about your money, accounts and logins changed since her last reflection.${money.note ? ` ${money.note}` : ''} Both versions are in the chat.`, 'Show log').then((c) => {
          if (c === 'Show log') this.output.show();
        });
      }
    } else if (e.type === 'needs_user') {
      this.openDesktop?.();
      void vscode.window.showWarningMessage(`Deskfish needs you: ${e.reason}`, 'Open desktop', 'Resume').then((choice) => {
        if (choice === 'Open desktop') this.openDesktop?.();
        if (choice === 'Resume') this.resume();
      });
    }
  }

  /** Past chats: open one read-only-ish in an editor, or continue it in a new chat. */
  async pastChats(): Promise<void> {
    const all = this.service.chats.list();
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
    this.service.openChat(pick.chat.file, pick.chat.startedAt);
  }

  async deletePastChats(): Promise<void> {
    const n = this.service.chats.list().length;
    if (!n) {
      void vscode.window.showInformationMessage('Deskfish: there are no past chats.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(`Delete all ${n} past chat${n === 1 ? '' : 's'}? Her journal, facts and self are not touched.`, { modal: true }, 'Delete');
    if (choice !== 'Delete') return;
    this.service.deleteAllChats();
  }

  /* ---------- who she is, her journal, backups ---------- */

  /** A read-only view of the self file (markdown preview of a copy; the real file has no edit command on purpose). */
  async showSelf(): Promise<void> {
    const file = path.join(this.ctx.globalStorageUri.fsPath, 'who-she-is.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, this.service.whoSheIs());
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
  }

  async openJournal(): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(this.service.journal.ensureFile()));
  }

  async openPlaybook(): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(this.service.playbook.ensureFile()));
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
    fs.writeFileSync(target.fsPath, JSON.stringify(this.service.exportBundle(), null, 1));
    this.output.appendLine(`— memory exported to ${target.fsPath} —`);
    void vscode.window.showInformationMessage(`Deskfish: her memory is saved to ${path.basename(target.fsPath)}.`);
  }

  /** Replace facts, self and journal from an export (after a modal confirmation). The self is re-signed with this install's key. */
  async importMemory(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Deskfish memory': ['json'] }, title: 'Import her memory' });
    if (!picked?.length) return;
    let bundle: MemoryBundle;
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
    this.service.importBundle(bundle as MemoryBundle & { self: string });
    this.output.appendLine(`— memory imported from ${picked[0].fsPath} —`);
    void vscode.window.showInformationMessage('Deskfish: her memory is imported. The next chat starts from it.');
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
      const s = this.service.addSchedule(task, when);
      const next = nextDueAfter(s, Date.now());
      void vscode.window.showInformationMessage(`Scheduled ${describeWhen(s.when)}${next ? `, next ${formatLocal(next)}` : ''}: ${s.task}`);
    } catch (err) {
      void vscode.window.showErrorMessage(`Deskfish: could not schedule — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** "Deskfish: Scheduled Tasks…": list, run now, or remove. */
  async scheduledTasks(): Promise<void> {
    const items = this.service.schedules.list();
    if (!items.length) {
      const c = await vscode.window.showInformationMessage('Deskfish has no scheduled tasks.', 'Schedule one…');
      if (c) await this.scheduleTask();
      return;
    }
    const lines = this.service.schedules.describe();
    const pick = await vscode.window.showQuickPick(
      items.map((s, i) => ({ label: describeWhen(s.when), description: s.task, detail: lines[i].split(' — ')[1]?.split(' · ').slice(1).join(' · '), id: s.id })),
      { title: 'Deskfish: scheduled tasks', placeHolder: 'Pick one to run it now or remove it' },
    );
    if (!pick) return;
    const action = await vscode.window.showQuickPick(['Run it now', 'Remove it'], { title: pick.description });
    if (action === 'Remove it') {
      this.service.removeSchedule(pick.id);
    } else if (action === 'Run it now') {
      if (this.service.busy) {
        void vscode.window.showInformationMessage('Deskfish: she is busy; the task will run when she is free.');
      }
      await this.syncSettings();
      await this.service.runSchedule(pick.id);
    }
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
      this.service.setKey(slot, value.trim());
      void vscode.window.showInformationMessage(`Deskfish: API key for ${where} saved.`);
    } else {
      await this.ctx.secrets.delete(slot);
      this.service.setKey(slot, undefined);
      void vscode.window.showInformationMessage(`Deskfish: API key for ${where} cleared.`);
    }
    this.service.announceStatus();
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

  /** Release any stuck key/button on the bot's display (called by the Desktop pane on focus loss, before the user interacts, etc.). */
  releaseInput(): Promise<void> {
    return this.service.releaseInput();
  }

  /** Host clipboard → bot desktop. Returns true if the desktop clipboard now holds the host text. */
  async pushClipboardToDesktop(): Promise<boolean> {
    if (this.desktop.current.state !== 'on') return false;
    return this.service.clipboardSet(await vscode.env.clipboard.readText());
  }

  /**
   * Bot desktop → host clipboard. `hint` is the (possibly Latin-1-mangled) text VNC reported, or
   * '' when polling.
   */
  async pullClipboardFromDesktop(hint: string): Promise<void> {
    const text = await this.service.clipboardGet(hint);
    if (text !== undefined) await vscode.env.clipboard.writeText(text);
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
    const out: DesktopFile[] = [];
    for (const uri of uris) {
      const name = safeFileName(path.basename(uri.fsPath));
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        if (data.byteLength > MAX_TRANSFER) throw new Error(`larger than ${formatSize(MAX_TRANSFER)}`);
        const file = await this.service.uploadFile(name, data);
        out.push(file);
        this.output.appendLine(`📎 ${uri.fsPath} → ${file.path} (${formatSize(data.byteLength)})`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Deskfish: could not attach ${name}: ${msg(err)}`);
      }
    }
    return out;
  }

  /** Files currently in the desktop's Downloads folder (for the "save a file" command). */
  listDownloads(): Promise<DesktopFile[]> {
    return this.service.listDownloads();
  }

  /** Copy a desktop file to this computer through a save dialog. Undefined when cancelled. */
  async saveFile(file: DesktopFile): Promise<string | undefined> {
    if (this.desktop.current.state !== 'on') throw new Error('the desktop is not running');
    if (file.size > MAX_TRANSFER) throw new Error(`${file.name} is larger than ${formatSize(MAX_TRANSFER)}`);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.lastSaveDir ?? path.join(os.homedir(), 'Downloads'), file.name)),
      title: `Save ${file.name} from the bot's desktop`,
      saveLabel: 'Save',
    });
    if (!target) return undefined;
    const data = await this.service.readFile(file);
    await vscode.workspace.fs.writeFile(target, data);
    this.lastSaveDir = path.dirname(target.fsPath);
    this.output.appendLine(`📥 ${file.path} → ${target.fsPath} (${formatSize(data.length)})`);
    return target.fsPath;
  }

  /** Power off: stop a running task first, then the container. */
  stopDesktop(): Promise<void> {
    return this.service.stopDesktop();
  }

  /** Off and on again: the fix for a hung Firefox, a stuck daemon, or new network settings. Files and logins are kept. */
  restartDesktop(): Promise<void> {
    return this.service.restartDesktop();
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.service.dispose();
  }
}
