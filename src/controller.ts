import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { formatLocal } from './agent/schedule';
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
import { DEFAULT_PORT, type EditableFile, type Snapshot } from './gateway/protocol';
import type { RemoteStatus } from './gateway/uplink';
import { register } from './remote/channel';
import { MAX_TRANSFER, type MemoryBundle } from './gateway/service';
import { applyAutostart, autostartNeedsWrite, autostartPlan, hasDesktopSession, removeAutostart, type AutostartPlan } from './gateway/autostart';
import { ensureLocalGateway } from './gateway/spawn';
import { dataDir, ensureToken, migrateData } from './gateway/storage';
import { VERSION } from './gateway/version';
import { HerFilesProvider } from './ui/herFiles';
import type { DesktopFile, UiConfig } from './webview/protocol';

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Secret-storage key of the per-install HMAC secret that signed the self file before the gateway (it moved to the data dir). */
const SELF_KEY_SECRET = 'deskfish.selfKey';
/** globalState key of the last config VS Code and the gateway agreed on (with the gateway's address). */
const SYNCED_CONFIG = 'deskfish.syncedConfig';
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
    // The last config VS Code and this gateway agreed on: a settings.json edit made while VS Code was closed is pushed on the next connect.
    const synced = ctx.globalState.get<{ url: string; config: DeskfishConfig }>(SYNCED_CONFIG);
    this.sync = new ConfigSync(
      {
        readSettings: () => readConfig('user'),
        push: (patch) => this.client.call('config.set', { patch }),
        write: (w) => this.writeSetting(w.setting, w.key, w.value),
        pushKey: (cfg) => this.pushKey(cfg),
        log: (line) => this.output.appendLine(line),
        saveBase: (config) => void ctx.globalState.update(SYNCED_CONFIG, { url, config }),
      },
      synced?.url === url ? { ...DEFAULT_CONFIG, ...synced.config } : undefined,
    );
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
    // One line naming the placement and the address, so a remote setup that never connects is
    // diagnosable from the log alone (it used to say nothing until the first event arrived).
    this.output.appendLine(`— Deskfish ${VERSION}: ${this.placement === 'remote' ? 'a gateway on another machine' : 'the gateway on this computer'} at ${this.client.url} —`);
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

  /* ---------- reaching her from anywhere (13-relay-plan.md) ---------- */

  /**
   * "Deskfish: Remote Access…" — the one entry for reaching her from a browser anywhere. It shows
   * where she stands and offers the one thing that is missing: enrol, then a password, then the
   * address to open. Nothing here opens a port on this computer; the gateway dials *out* to the
   * relay, which is why this exists at all (05-user, 2026-09-20).
   *
   * The password is turned into an OPAQUE record **in this process**, where it was typed. What
   * travels to the gateway — over loopback at home, over the person's own tunnel for a gateway on
   * another machine — is a record nobody can read a password back out of.
   */
  async remoteAccess(): Promise<void> {
    let state: RemoteStatus;
    try {
      state = await this.client.call('remote.status');
    } catch (err) {
      void vscode.window.showErrorMessage(`Deskfish: ${msg(err)}`);
      return;
    }
    const ready = state.relay && state.enrolled && state.hasPassword;
    const where = ready ? `${state.username} at ${state.relay} — ${state.state}${state.state === 'connected' ? ` (${state.clients} browser${state.clients === 1 ? '' : 's'})` : ''}` : 'not set up yet';
    const items: (vscode.QuickPickItem & { id: string })[] = [];
    if (!state.relay || !state.enrolled) items.push({ id: 'enroll', label: '$(key) Connect her to a relay…', detail: 'The relay address, a name for her, and the one-time code from whoever runs it' });
    if (state.relay) items.push({ id: 'password', label: state.hasPassword ? '$(lock) Change the password' : '$(lock) Set the password…', detail: 'What the sign-in page asks for, together with her name. It never leaves this computer.' });
    if (ready) items.push({ id: 'copy', label: '$(link) Copy her sign-in name', detail: `Open the page and sign in as ${state.username}` });
    // The relay is never told her name; this is what its operator mints a code for, and the one
    // thing on this list nobody could work out from the settings.
    if (state.handle) items.push({ id: 'handle', label: '$(eye) Copy the name the relay knows', detail: `known to the relay as: ${state.handle} — tell whoever runs it that, never "${state.username}"` });
    if (state.relay) items.push({ id: 'off', label: '$(circle-slash) Turn remote access off', detail: 'She stops dialling out. The keys stay until you say to forget them.' });
    const picked = await vscode.window.showQuickPick(items, { title: `Deskfish remote access — ${where}`, ignoreFocusOut: true, placeHolder: state.lastError ? `Last: ${state.lastError}` : 'Her computer opens no port either way' });
    if (!picked) return;
    try {
      if (picked.id === 'enroll') return await this.remoteEnroll();
      if (picked.id === 'password') return await this.remotePassword(state);
      if (picked.id === 'copy') {
        await vscode.env.clipboard.writeText(state.username);
        void vscode.window.showInformationMessage(`Copied "${state.username}". Open the remote page in any browser and sign in with it and the password.`);
        return;
      }
      if (picked.id === 'handle') {
        await vscode.env.clipboard.writeText(state.handle);
        void vscode.window.showInformationMessage(`Copied "${state.handle}". That is all the relay is ever told; her name stays on this computer.`);
        return;
      }
      const forget = await vscode.window.showWarningMessage('Turn remote access off?', { modal: true, detail: 'She stops dialling out at once. Forgetting the keys as well means enrolling again later with a new code.' }, 'Turn it off', 'Turn it off and forget the keys');
      if (!forget) return;
      const after = await this.client.call('remote.off', { forget: forget.includes('forget') });
      this.output.appendLine(`▶ remote access off${after.enrolled ? '' : ' (keys forgotten)'}`);
      void vscode.window.showInformationMessage('Remote access is off.');
    } catch (err) {
      void vscode.window.showErrorMessage(`Deskfish: ${msg(err)}`);
    }
  }

  private async remoteEnroll(): Promise<void> {
    const relay = (
      await vscode.window.showInputBox({
        title: 'Deskfish remote access (1 of 3)',
        prompt: 'The relay she should dial out to, e.g. wss://relay.example.com. It forwards sealed frames and cannot read them.',
        placeHolder: 'wss://relay.example.com',
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!relay) return;
    const username = (
      await vscode.window.showInputBox({
        title: 'Deskfish remote access (2 of 3)',
        prompt: 'A name for her on that relay — what you type on the sign-in page. Lowercase letters, digits and dashes.',
        ignoreFocusOut: true,
        validateInput: (v) => (/^[a-z0-9][a-z0-9-]{2,31}$/.test(v.trim().toLowerCase()) ? undefined : '3 to 32 characters: lowercase letters, digits and dashes, starting with a letter or a digit'),
      })
    )?.trim();
    if (!username) return;
    const code = (
      await vscode.window.showInputBox({
        title: 'Deskfish remote access (3 of 3)',
        prompt: 'The one-time enrolment code from whoever runs the relay (your own relay mints one with its admin key).',
        password: true,
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!code) return;
    const state = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Enrolling at ${relay}…` }, () => this.client.call('remote.enroll', { relay, username, code }));
    this.output.appendLine(`▶ remote access enrolled as ${state.username} at ${state.relay}`);
    if (!state.hasPassword) return this.remotePassword(state);
    void vscode.window.showInformationMessage(`She is enrolled as ${state.username} (the relay knows her only as ${state.handle}). Sign in from any browser with that name and her password.`);
  }

  private async remotePassword(state: RemoteStatus): Promise<void> {
    const username = state.username;
    const first = await vscode.window.showInputBox({
      title: 'Deskfish remote access — the password',
      prompt: `What the sign-in page asks for, together with "${username}". It is turned into a record here and never sent anywhere.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.length >= 8 ? undefined : 'Eight characters or more.'),
    });
    if (!first) return;
    const again = await vscode.window.showInputBox({ title: 'Deskfish remote access — the password', prompt: 'Once more, to be sure.', password: true, ignoreFocusOut: true });
    if (again === undefined) return;
    if (again !== first) {
      void vscode.window.showErrorMessage('Deskfish: those two are not the same. Nothing was changed.');
      return;
    }
    const made = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Setting her remote password…' }, () => register(username, first));
    await this.client.call('remote.password', { serverSetup: made.serverSetup, record: made.record });
    this.output.appendLine('▶ remote access password set');
    void vscode.window.showInformationMessage(`Done. From any browser, sign in as "${username}" with that password — her computer still opens no port.`);
  }

  /** "Deskfish: Set Gateway Token" — for a gateway on another machine. */
  async askGatewayToken(prompt = 'The token of the Deskfish gateway on another machine (the gateway.token file in its data folder).'): Promise<void> {
    const value = await vscode.window.showInputBox({ title: 'Deskfish gateway token', prompt, password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    const token = value.trim();
    if (token) await this.ctx.secrets.store(GATEWAY_TOKEN_SECRET, token);
    else await this.ctx.secrets.delete(GATEWAY_TOKEN_SECRET);
    if (this.placement !== 'remote') {
      // A gateway on this computer reads its own token from its data folder; this one is not used.
      void vscode.window.showInformationMessage('Deskfish runs on this computer and uses the token in its own data folder, so this one is not needed. Set deskfish.gateway.placement to "remote" for a gateway on another machine.');
      return;
    }
    // Typing the token is the whole step: the client takes it and connects again at once. A wrong
    // one comes back here through `unauthorized`, which is why the once-guard is lifted.
    this.askedToken = false;
    this.output.appendLine(`— gateway token saved; connecting to ${this.client.url} —`);
    this.client.setToken(token);
  }

  /** The config she runs on: the gateway's (last event or snapshot); VS Code's settings only before the first connect. */
  gatewayConfig(): DeskfishConfig {
    return this.sync.last ?? this.client.snapshot?.config ?? readConfig();
  }

  /**
   * The key for a config's provider, when VS Code holds one. A slot empty here may hold a key set
   * elsewhere; clearing is setApiKey's. Always the *API key* slot: sign-in tokens live in the
   * gateway's secrets file alone and never in VS Code's keychain.
   */
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

  /** "Edit in VS Code" on the Her files panel: memory or charter in a real editor (saving sends it to the gateway). */
  async openFile(file: EditableFile): Promise<void> {
    await (file === 'charter.md' ? this.editCharter() : this.editMemory());
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
    const slot = keySlotFor(cfg.provider, cfg.baseUrl, cfg.auth);
    const preset = presetFor(cfg.provider, cfg.baseUrl, cfg.auth);
    return {
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      daemonUrl: cfg.daemonUrl,
      vncUrl: cfg.vncUrl,
      // A signed-in endpoint has no key to find in the keychain: the slot is the whole story.
      hasApiKey: (!!slot && this.client.keys.includes(slot)) || (!cfg.auth && !!(await this.apiKey(cfg))),
      ...(preset?.auth ? { signIn: preset.auth } : {}),
      ...(this.client.signedInAs ? { signedInAs: this.client.signedInAs } : {}),
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
      // It stays a popup under the two-reflection rule (decision 119) because a shift now means a
      // commitment that is still gone a reflection later, not a sentence rewritten once — which is
      // exactly the alarm worth interrupting for. Q2 is also the answer whose *form* moves most
      // (half her sets write it as a bare list, half as "I will not…"), so it is the one that most
      // needed the confirmation before it knocked.
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
    if (presetFor(cfg.provider, cfg.baseUrl, cfg.auth)?.auth) return this.grokSignIn();
    const slot = keySlotFor(cfg.provider, cfg.baseUrl, cfg.auth);
    if (!slot) {
      void vscode.window.showInformationMessage('Deskfish: the demo model needs no key.');
      return;
    }
    const where = presetFor(cfg.provider, cfg.baseUrl, cfg.auth)?.label ?? cfg.baseUrl ?? cfg.provider;
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

  /**
   * "Sign in with Grok" (and "Sign out"). The gateway runs xAI's device flow and keeps the tokens;
   * this shows the code, opens xAI's page in the person's browser, and polls until it is answered.
   * The progress notification's Cancel stops the watching, not the sign-in at xAI.
   */
  async grokSignIn(): Promise<void> {
    const cfg = this.gatewayConfig();
    const slot = keySlotFor(cfg.provider, cfg.baseUrl, cfg.auth);
    if (slot && this.client.keys.includes(slot)) {
      const yes = await vscode.window.showWarningMessage('Sign out of Grok? Her next task needs a sign-in again, or an xAI API key.', { modal: true }, 'Sign out');
      if (yes !== 'Sign out') return;
      if ((await this.attempt('sign out of Grok', this.client.call('auth.signOut'))) === undefined) return;
      void vscode.window.showInformationMessage('Deskfish: signed out of Grok.');
      return;
    }
    const step = await this.attempt('start the Grok sign-in', this.client.call('auth.start'));
    if (!step) return;
    // The code is the thing the person must carry to the browser, so it is the message, and it
    // stays on screen (modal) until they have it. "Grok Build" is what xAI's own consent screen
    // is titled — said here so an unfamiliar name on a sign-in page is not a surprise.
    const go = await vscode.window.showInformationMessage(
      `Deskfish: your Grok sign-in code is ${step.userCode}`,
      {
        modal: true,
        detail: `Open ${step.verificationUri}, enter the code and approve it.\n\nxAI's consent screen names this "Grok Build" — that is xAI's shared sign-in for outside apps, not an app you need.`,
      },
      'Open the page',
      'I have the code',
    );
    if (!go) return;
    if (go === 'Open the page') await vscode.env.openExternal(vscode.Uri.parse(step.verificationUri));
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Waiting for you to approve the code ${step.userCode} at xAI…`, cancellable: true }, async (_p, token) => {
      while (!token.isCancellationRequested) {
        await new Promise((r) => setTimeout(r, 3000));
        if (token.isCancellationRequested) return;
        const r = await this.client.call('auth.poll').catch((err: unknown) => ({ state: 'denied' as const, detail: msg(err) }));
        if (r.state === 'pending') continue;
        if (r.state === 'done') void vscode.window.showInformationMessage(r.who ? `Deskfish: signed in with Grok as ${r.who}.` : 'Deskfish: signed in with Grok.');
        else if (r.state === 'expired') void vscode.window.showWarningMessage('Deskfish: that sign-in expired before it was approved. Try again.');
        else void vscode.window.showWarningMessage(`Deskfish: ${r.detail ?? 'the sign-in was refused at xAI.'}`);
        return;
      }
    });
  }

  /** The "Change" button: pick where the model comes from, then the model, then the key if one is missing. */
  async changeModel(): Promise<void> {
    const cfg = this.gatewayConfig();
    const current = presetFor(cfg.provider, cfg.baseUrl, cfg.auth);
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
    // Straight to the gateway, as one change; the mirror writes the settings.
    const auth = preset.auth ?? '';
    const next = await this.attempt('change the model', this.client.call('model.set', { provider: preset.provider, model, baseUrl, auth }));
    if (!next) return;
    this.output.appendLine(`— model: ${model} via ${preset.label}${baseUrl ? ` (${baseUrl})` : ''} —`);
    const slot = keySlotFor(next.provider, next.baseUrl, auth);
    if (auth) {
      if (!this.client.keys.includes(slot ?? '')) await this.grokSignIn();
      else void vscode.window.showInformationMessage(`Deskfish: using ${model} via ${preset.label}.`);
    } else if (preset.needsKey && !isLocalEndpoint(baseUrl) && !(await this.apiKey(next)) && !this.client.keys.includes(slot ?? '')) {
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
