import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { describeWhen, formatLocal, nextDueAfter, type When } from './agent/schedule';
import { DRIFT_QUESTIONS } from './agent/prompts';
import type { ReplayItem } from './agent/chats';
import type { AgentEvent, AgentStatus } from './agent/loop';
import { API_KEY_SECRET, readConfig, type DeskfishConfig } from './config';
import { PRESETS, isLocalEndpoint, keySlotFor, presetFor, type Preset } from './agent/presets';
import { formatSize, safeFileName, type NewDownload } from './desktop/files';
import { DesktopManager } from './desktop/manager';
import { GatewayClient } from './gateway/client';
import { ConfigSync } from './gateway/configSync';
import { DEFAULT_CONFIG } from './gateway/config';
import { DEFAULT_PORT, type Snapshot } from './gateway/protocol';
import { MAX_TRANSFER, type MemoryBundle } from './gateway/service';
import { applyAutostart, autostartNeedsWrite, autostartPlan, hasDesktopSession, removeAutostart, type AutostartPlan } from './gateway/autostart';
import { ensureLocalGateway } from './gateway/spawn';
import { dataDir, ensureToken, migrateData } from './gateway/storage';
import { parseBudget } from './agent/scheduleForm';
import { VERSION } from './gateway/version';
import { HerFilesProvider } from './ui/herFiles';
import type { DesktopFile, UiConfig } from './webview/protocol';

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Secret-storage key of the per-install HMAC secret that signed the self file before the gateway (it moved to the data dir). */
const SELF_KEY_SECRET = 'deskfish.selfKey';
/** Secret-storage key of a remote gateway's token. */
export const GATEWAY_TOKEN_SECRET = 'deskfish.gateway.token';

export type Placement = 'local' | 'remote';

export function readGatewaySettings(): { placement: Placement; url: string; keepRunning: boolean } {
  const c = vscode.workspace.getConfiguration('deskfish.gateway');
  return { placement: c.get<Placement>('placement', 'local') === 'remote' ? 'remote' : 'local', url: c.get<string>('url', '').trim().replace(/\/+$/, ''), keepRunning: c.get<boolean>('keepRunning', false) };
}

/**
 * The VS Code side of Deskfish: commands, notifications, the output channel, file pickers and save
 * dialogs, the clipboard, the model picker and SecretStorage. Everything else — the stores, the
 * runner and its queue, transcripts, schedules, the Downloads watcher, the desktop — belongs to the
 * gateway, a process of its own (started in the background on this computer, or on another
 * machine), reached through a `GatewayClient`. Its `config.json` is the one truth for settings:
 * VS Code seeds it once, pushes what the person changes in VS Code, and mirrors every change made
 * anywhere into the user settings (`ConfigSync`). Keys are pushed on connect and change; its events
 * come back out to the chat sidebar and the Desktop tab.
 */
export class AgentController implements vscode.Disposable {
  readonly client: GatewayClient;
  readonly desktop: DesktopManager;
  private openDesktop?: (opts?: { preserveFocus?: boolean }) => void;
  private lastSaveDir?: string;
  private readonly subs: vscode.Disposable[] = [];
  private startError?: string;
  private tailShown = false;
  private askedToken = false;
  /** The gateway's config, mirrored into the user settings. */
  private readonly sync: ConfigSync;
  private readonly configEmitter = new vscode.EventEmitter<DeskfishConfig>();
  /** The gateway's config (or its key slots) changed: the header re-renders from `gatewayConfig()`. */
  readonly onDidConfig = this.configEmitter.event;

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
  /** Connected (again) to the gateway: the views re-render from the snapshot. */
  readonly onDidConnect: vscode.Event<Snapshot>;

  /** Her files move out of globalStorage into the data dir (once) before a local gateway opens them. */
  static async create(ctx: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<AgentController> {
    const gw = readGatewaySettings();
    if (gw.placement === 'remote') {
      return new AgentController(ctx, output, gw.url || `http://127.0.0.1:${DEFAULT_PORT}`, (await ctx.secrets.get(GATEWAY_TOKEN_SECRET)) ?? '', 'remote');
    }
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
    return new AgentController(ctx, output, `http://127.0.0.1:${DEFAULT_PORT}`, ensureToken(dataDir()), 'local');
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    url: string,
    token: string,
    readonly placement: Placement,
  ) {
    this.client = new GatewayClient({
      url,
      token,
      client: 'vscode',
      version: VERSION,
      log: (line) => this.output.appendLine(line),
      // A local gateway that went away (killed, crashed, the machine slept) is started again.
      beforeReconnect: placement === 'local' ? () => this.ensureLocal() : undefined,
    });
    this.desktop = new DesktopManager(this.client.desktop, output);
    this.sync = new ConfigSync({
      readSettings: () => readConfig('user'),
      push: (patch) => this.client.call('config.set', { patch }),
      write: (w) => this.writeSetting(w.setting, w.key, w.value),
      pushKey: (cfg) => this.pushKey(cfg),
      log: (line) => this.output.appendLine(line),
    });
    this.onDidReset = this.relay<void>('reset');
    this.onDidReplay = this.relay('replay');
    this.onDidSchedule = this.relay('schedule');
    this.onDidPost = (listener) => this.relay<{ text: string }>('notice')((n) => listener({ kind: 'notice', text: n.text }));
    this.onDidDownload = this.relay('download');
    this.onDidConnect = this.relay('connected');

    this.subs.push(
      vscode.workspace.registerFileSystemProvider(HerFilesProvider.scheme, new HerFilesProvider(this.client), { isCaseSensitive: true }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('deskfish.gateway')) {
          void vscode.window.showInformationMessage('Deskfish: the gateway setting changed. Reload the window to connect to it.', 'Reload').then((c) => {
            if (c) void vscode.commands.executeCommand('workbench.action.reloadWindow');
          });
        } else if (e.affectsConfiguration('deskfish') && this.client.connected) {
          // Only what this change names goes out, and only where it differs from the gateway's config.
          void this.sync.settingsChanged((setting) => e.affectsConfiguration(setting));
        }
      }),
      this.ctx.secrets.onDidChange((e) => {
        if (e.key.startsWith('deskfish.apiKey')) void this.pushKey(this.gatewayConfig());
      }),
      this.relay<Snapshot>('connected')((snap) => {
        this.startError = undefined;
        this.output.appendLine(`— connected to the Deskfish gateway ${snap.version} at ${this.client.url} (her data: ${snap.dataDir}) —`);
        void this.sync.connected(snap).then((how) => {
          if (how === 'seeded') this.output.appendLine('— the gateway had no settings yet: seeded from VS Code\'s. From now on its config.json is the truth, mirrored into your user settings —');
          this.configEmitter.fire(this.gatewayConfig());
        });
        if (!this.tailShown) {
          // What the gateway did before this window: the last lines of its log, once.
          this.tailShown = true;
          void this.client.call('log.tail', { lines: 40 }).then((lines) => {
            if (lines.length) this.output.appendLine(`— the gateway's recent log —\n${lines.join('\n')}\n— live from here —`);
          }, () => {});
        }
      }),
      this.relay<string>('log')((line) => this.output.appendLine(line)),
      this.relay<DeskfishConfig>('config')((cfg) => {
        // `last` is set before the first await, so the header below already reads the new config.
        void this.sync.config(cfg);
        this.configEmitter.fire(cfg);
      }),
      this.relay<string[]>('keys')(() => this.configEmitter.fire(this.gatewayConfig())),
      this.relay<void>('unauthorized')(() => {
        if (this.placement !== 'remote' || this.askedToken) return;
        this.askedToken = true;
        void this.askGatewayToken('The gateway refused the token. Enter the token from its data folder (gateway.token).');
      }),
      this.relay<{ text: string }>('task')(() => {
        // The Desktop tab is the screen: show it as soon as a task is submitted (even while the tank
        // is still turning on — the tab shows the progress), but leave the keyboard in the chat.
        if (this.gatewayConfig().openDesktopOnRun) this.openDesktop?.({ preserveFocus: true });
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

  /** A client event as a VS Code event. */
  private relay<T>(name: string): vscode.Event<T> {
    return (listener: (e: T) => unknown) => {
      const fn = (e: T) => listener(e);
      this.client.on(name, fn);
      return new vscode.Disposable(() => this.client.off(name, fn));
    };
  }

  /** Start the local gateway when none answers. An error is shown once, until a connect succeeds. */
  private async ensureLocal(): Promise<void> {
    try {
      await ensureLocalGateway({
        dataDir: dataDir(),
        entry: path.join(this.ctx.extensionPath, 'dist', 'gateway.js'),
        execPath: process.execPath,
        version: VERSION,
        log: (line) => this.output.appendLine(line),
      });
    } catch (err) {
      const text = msg(err);
      this.output.appendLine(`✖ ${text}`);
      if (this.startError !== text) {
        this.startError = text;
        void vscode.window.showErrorMessage(`Deskfish could not start its gateway — ${text}`, 'Show log').then((c) => {
          if (c) this.output.show();
        });
      }
      throw err;
    }
  }

  /** Connect to the gateway (starting it on this computer when needed). Waits a while for the first connection, never forever. */
  async init(): Promise<void> {
    this.syncAutostart();
    if (this.placement === 'local') await this.ensureLocal().catch(() => {});
    else if (!(await this.ctx.secrets.get(GATEWAY_TOKEN_SECRET))) await this.askGatewayToken('Deskfish runs on another machine. Enter its gateway token (the gateway.token file in its data folder).');
    void this.client.connect();
    await this.client.whenConnected(15_000).catch(() => this.output.appendLine(`… still waiting for the gateway at ${this.client.url}`));
  }

  /* ---------- keep running when VS Code is closed (gateway plan step 5, tier 2) ---------- */

  /** The login entry for this build: the same command `spawn.ts` starts the gateway with. */
  private autostart(): AutostartPlan {
    return autostartPlan({
      platform: process.platform,
      execPath: process.execPath,
      entry: path.join(this.ctx.extensionPath, 'dist', 'gateway.js'),
      dataDir: dataDir(),
      port: DEFAULT_PORT,
      home: os.homedir(),
      desktopSession: hasDesktopSession(),
    });
  }

  /**
   * The entry names this build's folder, which changes with every update, so it is compared on
   * every activation and rewritten silently when it no longer matches. Nothing to fear from the
   * entry and VS Code starting together: `deskfish serve` locks the data dir and a second one exits.
   */
  private syncAutostart(): void {
    if (!readGatewaySettings().keepRunning || this.placement !== 'local') return;
    try {
      const plan = this.autostart();
      if (!autostartNeedsWrite(plan)) return;
      applyAutostart(plan);
      this.output.appendLine(`— the start-at-login entry was updated for this build (${plan.where}) —`);
    } catch (err) {
      this.output.appendLine(`start-at-login entry: ${msg(err)}`);
    }
  }

  /** "Deskfish: Keep Running When VS Code Is Closed" — a toggle, always visible in a terminal. */
  async keepRunning(): Promise<void> {
    if (this.placement === 'remote') {
      void vscode.window.showInformationMessage('Deskfish runs on another machine, so this computer starts nothing. Set it to start at boot there (see the docs: running without VS Code).');
      return;
    }
    const on = readGatewaySettings().keepRunning;
    const plan = this.autostart();
    const terminal = vscode.window.createTerminal({ name: on ? 'Deskfish: stop starting at login' : 'Deskfish: keep running' });
    try {
      if (on) removeAutostart(plan);
      else applyAutostart(plan);
    } catch (err) {
      terminal.dispose();
      void vscode.window.showErrorMessage(`Deskfish: could not ${on ? 'remove' : 'write'} ${plan.where} — ${msg(err)}`);
      return;
    }
    terminal.show();
    terminal.sendText(on ? plan.remove : plan.install, true);
    this.output.appendLine(`▶ keep running ${on ? 'off' : 'on'}: ${plan.where}`);
    await vscode.workspace.getConfiguration('deskfish.gateway').update('keepRunning', !on, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      on
        ? 'Deskfish will no longer start by itself. It still keeps running after you close VS Code, until the computer restarts.'
        : 'Deskfish will start when you log in, so her schedules run and a task survives a restart. The terminal shows the entry.',
    );
  }

  /** "Deskfish: Set Gateway Token" — for a gateway on another machine. */
  async askGatewayToken(prompt = 'The token of the Deskfish gateway on another machine (the gateway.token file in its data folder).'): Promise<void> {
    const value = await vscode.window.showInputBox({ title: 'Deskfish gateway token', prompt, password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    if (value.trim()) await this.ctx.secrets.store(GATEWAY_TOKEN_SECRET, value.trim());
    else await this.ctx.secrets.delete(GATEWAY_TOKEN_SECRET);
    const choice = await vscode.window.showInformationMessage('Deskfish: gateway token saved. Reload the window to connect with it.', 'Reload');
    if (choice) void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  /** The config she runs on: the gateway's (last event or snapshot); VS Code's settings only before the first connect. */
  gatewayConfig(): DeskfishConfig {
    return this.sync.last ?? this.client.snapshot?.config ?? readConfig();
  }

  /** The key for a config's provider, when VS Code holds one. A slot empty here may hold a key set elsewhere; clearing is setApiKey's. */
  private async pushKey(cfg: DeskfishConfig): Promise<void> {
    const slot = keySlotFor(cfg.provider, cfg.baseUrl);
    if (!slot || !this.client.connected) return;
    const key = await this.apiKey(cfg);
    if (!key) return;
    await this.client.call('key.set', { slot, key }).catch((err) => this.output.appendLine(`key → gateway failed: ${msg(err)}`));
  }

  /** One user setting from the gateway's config (`undefined` removes it: the gateway runs on the default). */
  private async writeSetting(setting: string, key: keyof DeskfishConfig, value: unknown): Promise<void> {
    const name = setting.slice('deskfish.'.length);
    const conf = vscode.workspace.getConfiguration('deskfish');
    if (conf.inspect(name)?.globalValue === value) return;
    await conf.update(name, value, vscode.ConfigurationTarget.Global);
    this.output.appendLine(`— ${setting} follows the gateway —`);
    // A workspace value still wins inside VS Code; she runs on the gateway's either way.
    const effective = vscode.workspace.getConfiguration('deskfish').get(name);
    if (effective !== (value ?? DEFAULT_CONFIG[key])) this.output.appendLine(`— a workspace setting keeps ${setting} different in this window; the gateway's value is the one she runs on —`);
  }

  /** Run a gateway call from a button or command: an error becomes a popup instead of an unhandled rejection. */
  private attempt<T>(what: string, p: Promise<T>): Promise<T | undefined> {
    return p.catch((err) => {
      this.output.appendLine(`✖ ${what}: ${msg(err)}`);
      void vscode.window.showErrorMessage(`Deskfish: could not ${what} — ${msg(err)}`);
      return undefined;
    });
  }

  /** Opens her facts for editing (saving sends them to the gateway). */
  async editMemory(): Promise<void> {
    await vscode.window.showTextDocument(HerFilesProvider.uri('memory.md'));
  }

  async clearMemory(): Promise<void> {
    const mem = await this.attempt('read her memories', this.client.call('memory.read', { file: 'memory.md' }));
    if (!mem) return;
    const count = mem.facts;
    if (!count) {
      void vscode.window.showInformationMessage('Deskfish has no memories to forget.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Forget all ${count} ${count === 1 ? 'fact' : 'facts'} she remembers? Her self file and her journal are not touched.`,
      { modal: true },
      'Forget all',
    );
    if (choice !== 'Forget all') return;
    if ((await this.attempt('forget her memories', this.client.call('memory.clearFacts'))) === undefined) return;
    void vscode.window.showInformationMessage('Deskfish: all memories forgotten.');
  }

  /** Opens the charter for editing (the default text until the user writes their own). */
  async editCharter(): Promise<void> {
    await vscode.window.showTextDocument(HerFilesProvider.uri('charter.md'));
  }

  /** Lets the controller bring up the desktop panel when the bot asks for the user. */
  setDesktopOpener(fn: (opts?: { preserveFocus?: boolean }) => void): void {
    this.openDesktop = fn;
  }

  get currentStatus(): AgentStatus {
    return this.client.status;
  }

  /** The current run is a reflection: the desktop is free for the person. */
  get screenFree(): boolean {
    return this.client.screenFree;
  }

  get latestScreenshot() {
    return this.client.latestScreenshot;
  }

  /** The live view's address: the gateway's `/vnc`, piped to the tank's websockify. */
  vncUrl(): string {
    return this.client.vncUrl();
  }

  onEvent(listener: (e: AgentEvent) => void): vscode.Disposable {
    return this.relay<AgentEvent>('event')(listener);
  }

  async uiConfig(): Promise<UiConfig> {
    const cfg = this.gatewayConfig();
    const slot = keySlotFor(cfg.provider, cfg.baseUrl);
    return {
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      daemonUrl: cfg.daemonUrl,
      vncUrl: cfg.vncUrl,
      hasApiKey: (!!slot && this.client.keys.includes(slot)) || !!(await this.apiKey(cfg)),
      maxSteps: cfg.maxSteps,
      desktop: this.desktop.current,
    };
  }

  /** Start a task (queued behind a running one, held during a reflection). */
  async run(task: string, attachments?: DesktopFile[]): Promise<void> {
    await this.attempt('start the task', this.client.run(task, attachments));
  }

  /** Let her reflect now (the command). */
  async reflect(): Promise<void> {
    const r = await this.attempt('start a reflection', this.client.reflect());
    if (r === 'busy') void vscode.window.showInformationMessage('Deskfish: she is busy; let her finish first.');
  }

  say(text: string, attachments?: DesktopFile[]): void {
    void this.attempt('send the message', this.client.say(text, attachments));
  }

  pause(): void {
    void this.attempt('pause', this.client.pause());
  }

  resume(): void {
    void this.attempt('resume', this.client.resume());
  }

  stop(): void {
    void this.attempt('stop', this.client.stop());
  }

  newConversation(): void {
    void this.attempt('start a new chat', this.client.newConversation());
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
    const all = await this.attempt('list past chats', this.client.call('chats.list'));
    if (!all) return;
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
      await vscode.window.showTextDocument(HerFilesProvider.uri(`chats/${pick.chat.name}`), { preview: true });
      return;
    }
    await this.attempt('open the chat', this.client.call('chats.continue', { name: pick.chat.name }));
  }

  async deletePastChats(): Promise<void> {
    const all = await this.attempt('list past chats', this.client.call('chats.list'));
    if (!all) return;
    const n = all.length;
    if (!n) {
      void vscode.window.showInformationMessage('Deskfish: there are no past chats.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(`Delete all ${n} past chat${n === 1 ? '' : 's'}? Her journal, facts and self are not touched.`, { modal: true }, 'Delete');
    if (choice !== 'Delete') return;
    await this.attempt('delete past chats', this.client.call('chats.delete'));
  }

  /* ---------- who she is, her journal, backups ---------- */

  /** A read-only view of the self file (markdown preview of a local copy; the real file has no edit command on purpose). */
  async showSelf(): Promise<void> {
    const page = await this.attempt('read her self page', this.client.call('self.read'));
    if (page === undefined) return;
    const file = path.join(this.ctx.globalStorageUri.fsPath, 'who-she-is.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, page);
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
  }

  async openJournal(): Promise<void> {
    await vscode.window.showTextDocument(HerFilesProvider.uri('journal.md'));
  }

  async openPlaybook(): Promise<void> {
    await vscode.window.showTextDocument(HerFilesProvider.uri('playbook.md'));
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
    const bundle = await this.attempt('export her memory', this.client.call('export'));
    if (!bundle) return;
    fs.writeFileSync(target.fsPath, JSON.stringify(bundle, null, 1));
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
    if ((await this.attempt('import her memory', this.client.call('import', { bundle }))) === undefined) return;
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
      { title: 'Deskfish: schedule a task — when?', placeHolder: 'Runs while the Deskfish gateway runs, with or without VS Code; a missed time is skipped, not run late' },
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
    // Nobody is watching a scheduled run, so it is fenced: guided, with a cost ceiling. The web page's
    // Schedules dialog asks the same questions.
    const how = await vscode.window.showQuickPick(
      [
        { label: 'Guided (default)', detail: 'She asks before anything irreversible and uses no credentials you did not give her — the safer choice for a run nobody is watching', autonomy: 'guided' as const },
        { label: 'Free, like a task you type yourself', detail: 'The tank is the boundary: she may use any account or login in it and finishes what you asked', autonomy: 'free' as const },
      ],
      { title: 'How much should she decide on her own when this runs?' },
    );
    if (!how) return;
    const setting = this.gatewayConfig().unattendedMaxCostUsd;
    const typed = await vscode.window.showInputBox({
      title: 'Budget for each run, in US dollars (optional)',
      prompt: `Enter to use deskfish.unattendedMaxCostUsd (${setting > 0 ? `$${setting.toFixed(2)}` : 'no budget'}); 0 = no budget. It acts where the model has a known price or reports its cost.`,
      placeHolder: setting > 0 ? setting.toFixed(2) : '0',
      ignoreFocusOut: true,
      validateInput: (v) => (parseBudget(v) === 'bad' ? 'A number of dollars, 0 or more — or empty for the setting' : undefined),
    });
    if (typed === undefined) return;
    const maxCostUsd = parseBudget(typed);
    try {
      const s = await this.client.call('schedules.add', { task, when, autonomy: how.autonomy, ...(typeof maxCostUsd === 'number' ? { maxCostUsd } : {}) });
      const next = nextDueAfter(s, Date.now());
      const budget = s.maxCostUsd ?? setting;
      void vscode.window.showInformationMessage(
        `Scheduled ${describeWhen(s.when)}${next ? `, next ${formatLocal(next)}` : ''}: ${s.task} — it runs ${s.autonomy ?? 'guided'}${budget > 0 ? `, up to $${budget.toFixed(2)}` : ''}.`,
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Deskfish: could not schedule — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** "Deskfish: Scheduled Tasks…": list, run now, or remove. */
  async scheduledTasks(): Promise<void> {
    const listed = await this.attempt('list scheduled tasks', this.client.call('schedules.list'));
    if (!listed) return;
    const items = listed.schedules;
    if (!items.length) {
      const c = await vscode.window.showInformationMessage('Deskfish has no scheduled tasks.', 'Schedule one…');
      if (c) await this.scheduleTask();
      return;
    }
    const lines = listed.lines;
    const pick = await vscode.window.showQuickPick(
      items.map((s, i) => ({ label: describeWhen(s.when), description: s.task, detail: lines[i].split(' — ')[1]?.split(' · ').slice(1).join(' · '), id: s.id })),
      { title: 'Deskfish: scheduled tasks', placeHolder: 'Pick one to run it now or remove it' },
    );
    if (!pick) return;
    const action = await vscode.window.showQuickPick(['Run it now', 'Remove it'], { title: pick.description });
    if (action === 'Remove it') {
      await this.attempt('remove the schedule', this.client.call('schedules.remove', { id: pick.id }));
    } else if (action === 'Run it now') {
      if (this.client.status === 'running' || this.client.status === 'paused') {
        void vscode.window.showInformationMessage('Deskfish: she is busy; the task will run when she is free.');
      }
      await this.attempt('run the scheduled task', this.client.call('schedules.runNow', { id: pick.id }));
    }
  }

  /**
   * The API key for the current provider. One secret slot per provider/host, so switching
   * between OpenRouter and Anthropic keeps both keys. A key saved before slots existed is
   * migrated into the slot of whatever provider is active the first time it is read.
   */
  async apiKey(cfg: DeskfishConfig = this.gatewayConfig()): Promise<string | undefined> {
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
    const cfg = this.gatewayConfig();
    const slot = keySlotFor(cfg.provider, cfg.baseUrl);
    if (!slot) {
      void vscode.window.showInformationMessage('Deskfish: the demo model needs no key.');
      return;
    }
    const where = presetFor(cfg.provider, cfg.baseUrl)?.label ?? cfg.baseUrl ?? cfg.provider;
    const value = await vscode.window.showInputBox({
      title: `API key for ${where} (${cfg.model})`,
      prompt: 'Stored in the OS keychain via VS Code SecretStorage and in the Deskfish gateway\'s secrets file, one key per provider. Leave empty to clear.',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    if (value.trim()) {
      await this.ctx.secrets.store(slot, value.trim());
      if ((await this.attempt('save the key in the gateway', this.client.call('key.set', { slot, key: value.trim() }))) === undefined) return;
      void vscode.window.showInformationMessage(`Deskfish: API key for ${where} saved.`);
    } else {
      await this.ctx.secrets.delete(slot);
      if ((await this.attempt('clear the key in the gateway', this.client.call('key.set', { slot, key: '' }))) === undefined) return;
      void vscode.window.showInformationMessage(`Deskfish: API key for ${where} cleared.`);
    }
  }

  /** The "Change" button: pick where the model comes from, then the model, then the key if one is missing. */
  async changeModel(): Promise<void> {
    const cfg = this.gatewayConfig();
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
    // Straight to the gateway, as one change; the mirror writes the three settings.
    const next = await this.attempt('change the model', this.client.call('model.set', { provider: preset.provider, model, baseUrl }));
    if (!next) return;
    this.output.appendLine(`— model: ${model} via ${preset.label}${baseUrl ? ` (${baseUrl})` : ''} —`);
    const needsKey = preset.needsKey && !isLocalEndpoint(baseUrl);
    if (needsKey && !(await this.apiKey(next)) && !this.client.keys.includes(keySlotFor(next.provider, next.baseUrl) ?? '')) {
      await this.setApiKey();
    } else {
      void vscode.window.showInformationMessage(`Deskfish: using ${model} via ${preset.label}.`);
    }
  }

  /** Release any stuck key/button on the bot's display (called by the Desktop pane on focus loss, before the user interacts, etc.). */
  async releaseInput(): Promise<void> {
    await this.client.releaseInput().catch(() => null);
  }

  /** Host clipboard → bot desktop. Returns true if the desktop clipboard now holds the host text. */
  async pushClipboardToDesktop(): Promise<boolean> {
    if (this.desktop.current.state !== 'on') return false;
    return this.client.call('clipboard.set', { text: await vscode.env.clipboard.readText() }).catch(() => false);
  }

  /**
   * Bot desktop → host clipboard. `hint` is the (possibly Latin-1-mangled) text VNC reported, or
   * '' when polling.
   */
  async pullClipboardFromDesktop(hint: string): Promise<void> {
    if (!this.client.connected) return;
    const text = await this.client.call('clipboard.get', { hint }).catch(() => null);
    if (text !== null) await vscode.env.clipboard.writeText(text);
  }

  /*
   * Files. The desktop shares no folder with this computer; files are copied explicitly, in both
   * directions, through the gateway and the daemon — so the same code works for a desktop on another machine.
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
    if (!(await this.attempt('turn on the desktop', this.desktop.ensureOn()))) {
      void vscode.window.showErrorMessage('Deskfish: the desktop is not running, so the files could not be copied to it.');
      return [];
    }
    const out: DesktopFile[] = [];
    for (const uri of uris) {
      const name = safeFileName(path.basename(uri.fsPath));
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        if (data.byteLength > MAX_TRANSFER) throw new Error(`larger than ${formatSize(MAX_TRANSFER)}`);
        const file = await this.client.uploadFile(name, data);
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
    return this.client.call('files.list');
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
    const data = await this.client.readFile(file);
    await vscode.workspace.fs.writeFile(target, data);
    this.lastSaveDir = path.dirname(target.fsPath);
    this.output.appendLine(`📥 ${file.path} → ${target.fsPath} (${formatSize(data.length)})`);
    return target.fsPath;
  }

  /** Power off: stop a running task first, then the container. */
  async stopDesktop(): Promise<void> {
    await this.attempt('turn off the desktop', this.client.call('desktop.off'));
  }

  /** Off and on again: the fix for a hung Firefox, a stuck daemon, or new network settings. Files and logins are kept. */
  async restartDesktop(): Promise<void> {
    await this.attempt('restart the desktop', this.client.call('desktop.restart'));
  }

  /** The window closes; the gateway (and a running task) keeps going. */
  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.configEmitter.dispose();
    this.client.close();
  }
}
