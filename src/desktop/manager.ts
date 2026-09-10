import * as vscode from 'vscode';
import { readConfig } from '../config';
import { DesktopEngine } from './engine';
import { detectRuntime, terminalCommand, type RuntimeStatus } from './runtime';

/**
 * VS Code-side owner of the desktop: keeps a state machine the UI can render (off / starting / on /
 * stopping / error), runs the engine with a progress notification, and polls the daemon so the
 * state stays truthful even if the container was started or stopped outside VS Code.
 */

export type DesktopState = 'unknown' | 'off' | 'starting' | 'on' | 'stopping' | 'error';

export interface DesktopStatus {
  state: DesktopState;
  message?: string;
  /** Which container engine is available; `none` carries an install plan for the UI. */
  runtime?: RuntimeStatus;
}

export class DesktopManager implements vscode.Disposable {
  private status: DesktopStatus = { state: 'unknown' };
  private readonly emitter = new vscode.EventEmitter<DesktopStatus>();
  readonly onDidChange = this.emitter.event;
  private busy?: Promise<void>;
  private poll?: NodeJS.Timeout;
  private runtime?: RuntimeStatus;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  get current(): DesktopStatus {
    return this.status;
  }

  private engine(): DesktopEngine {
    const cfg = readConfig();
    return new DesktopEngine(
      {
        buildContext: vscode.Uri.joinPath(this.ctx.extensionUri, 'docker', 'desktop').fsPath,
        cli: cfg.containerCli,
        daemonUrl: cfg.daemonUrl,
        daemonToken: cfg.daemonToken,
        vncPassword: cfg.vncPassword,
        screen: cfg.screen,
      },
      {
        info: (line) => this.output.appendLine(line),
        progress: (message) => this.set({ state: 'starting', message }),
      },
    );
  }

  /** Probe the daemon. If it answers we are "on", however it was started. */
  async refresh(): Promise<DesktopStatus> {
    if (this.busy) return this.status;
    const healthy = await this.engine().isHealthy();
    if (healthy) {
      this.set({ state: 'on' });
      this.lookupNetworkMode();
      return this.status;
    }
    await this.detectRuntime();
    if (this.status.state !== 'error') this.set({ state: 'off' });
    return this.status;
  }

  get runtimeMissing(): boolean {
    return this.runtime?.cli === 'none';
  }

  /** podman/docker present? Cheap (`--version` calls); emits a status change when the answer changes. */
  async detectRuntime(): Promise<RuntimeStatus> {
    this.runtime = await detectRuntime(readConfig().containerCli);
    this.set({ ...this.status });
    return this.runtime;
  }

  /**
   * Open a terminal with this system's install command (visible, password prompt and all), and
   * re-detect when the terminal closes. Never installs anything silently.
   */
  private warnedHostNetwork = false;

  /** How the running tank is networked: known after a start in this session, or looked up once for a tank that was already running. */
  private lastNetworkMode?: 'isolated' | 'host';
  private lookingUpNetworkMode = false;

  get networkMode(): 'isolated' | 'host' | undefined {
    return this.lastNetworkMode;
  }

  private lookupNetworkMode(): void {
    if (this.lastNetworkMode !== undefined || this.lookingUpNetworkMode) return;
    this.lookingUpNetworkMode = true;
    void this.engine()
      .inspectNetworkMode()
      .then((mode) => {
        if (mode) {
          this.lastNetworkMode = mode;
          if (mode === 'host') this.warnHostNetwork();
        }
      })
      .finally(() => (this.lookingUpNetworkMode = false));
  }

  /**
   * The tank is sharing the machine's network namespace (rootless Podman without passt): it sees
   * the host's interfaces and can reach the LAN and the host's own localhost. Say so once per
   * session, with the one-package fix.
   */
  private warnHostNetwork(): void {
    if (this.warnedHostNetwork) return;
    this.warnedHostNetwork = true;
    this.output.appendLine('⚠ the tank is on the host network (passt is not installed): it can see your interfaces and reach devices on your LAN');
    void vscode.window
      .showWarningMessage(
        'Deskfish: the tank is sharing your machine\'s network because the "passt" package is not installed. It can see your network interfaces and reach devices on your LAN. Install passt to give it its own network.',
        'Install passt',
        'Learn more',
      )
      .then(async (choice) => {
        if (choice === 'Learn more') {
          void vscode.commands.executeCommand('deskfish.openDocs');
          return;
        }
        if (choice !== 'Install passt') return;
        const command = await passtInstallCommand();
        if (!command) {
          void vscode.window.showInformationMessage('Deskfish: install the "passt" package with your distribution\'s package manager, then turn the desktop off and on.');
          return;
        }
        const terminal = vscode.window.createTerminal({ name: 'Install passt' });
        terminal.show();
        terminal.sendText(command, true);
        this.output.appendLine(`▶ install passt: ${command}`);
        const sub = vscode.window.onDidCloseTerminal((t) => {
          if (t !== terminal) return;
          sub.dispose();
          this.warnedHostNetwork = false;
          void vscode.window.showInformationMessage('Deskfish: turn the desktop off and on to give the tank its own network.');
        });
      });
  }

  async installRuntime(): Promise<void> {
    const rt = this.runtime?.cli === 'none' ? this.runtime : await this.detectRuntime();
    if (rt.cli !== 'none') {
      void vscode.window.showInformationMessage(`Deskfish: ${rt.cli} is already installed.`);
      return;
    }
    const command = terminalCommand(rt.install);
    if (!command) {
      void vscode.env.openExternal(vscode.Uri.parse(rt.install.docsUrl));
      return;
    }
    const terminal = vscode.window.createTerminal({ name: 'Install Podman' });
    terminal.show();
    terminal.sendText(command, true);
    this.output.appendLine(`▶ install runtime: ${command}`);
    const sub = vscode.window.onDidCloseTerminal((t) => {
      if (t !== terminal) return;
      sub.dispose();
      void this.refresh();
    });
  }

  startPolling(intervalMs = 15_000): void {
    this.stopPolling();
    this.poll = setInterval(() => void this.refresh(), intervalMs);
  }

  stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  /** Turn on if needed. Resolves true when the desktop is usable. */
  async ensureOn(): Promise<boolean> {
    if ((await this.refresh()).state === 'on') return true;
    return this.start();
  }

  async start(): Promise<boolean> {
    if (this.busy) {
      await this.busy;
      return this.status.state === 'on';
    }
    this.busy = this.doStart();
    try {
      await this.busy;
    } finally {
      this.busy = undefined;
    }
    return this.status.state === 'on';
  }

  private async doStart(): Promise<void> {
    const engine = this.engine();
    if ((await this.detectRuntime()).cli === 'none') {
      // The sidebar shows the install card; no error notification needed on top.
      this.output.appendLine('✖ no container engine (podman/docker) found');
      this.set({ state: 'off', message: 'Podman (or Docker) is not installed yet' });
      return;
    }
    this.set({ state: 'starting', message: 'Turning on the desktop…' });
    this.output.appendLine('▶ turning on the desktop');
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Deskfish desktop', cancellable: false },
        async (progress) => {
          const sub = this.onDidChange((s) => {
            if (s.state === 'starting' && s.message) progress.report({ message: s.message });
          });
          try {
            await engine.start();
          } finally {
            sub.dispose();
          }
        },
      );
      this.set({ state: 'on' });
      this.output.appendLine('● desktop is on');
      this.lastNetworkMode = engine.networkMode;
      if (engine.networkMode === 'host') this.warnHostNetwork();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`✖ desktop start failed: ${message}`);
      this.set({ state: 'error', message: message.split('\n')[0] });
      void vscode.window.showErrorMessage(`Deskfish: could not turn on the desktop — ${message.split('\n')[0]}`, 'Show log').then((c) => {
        if (c) this.output.show();
      });
    }
  }

  async stop(): Promise<void> {
    if (this.busy) await this.busy;
    this.lastNetworkMode = undefined;
    this.set({ state: 'stopping', message: 'Turning off the desktop…' });
    this.output.appendLine('■ turning off the desktop');
    try {
      await this.engine().stop();
      this.set({ state: 'off' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.set({ state: 'error', message });
      void vscode.window.showErrorMessage(`Deskfish: could not stop the desktop — ${message}`);
    }
  }

  async toggle(): Promise<void> {
    const s = (await this.refresh()).state;
    if (s === 'on') await this.stop();
    else if (s === 'off' || s === 'error' || s === 'unknown') await this.start();
  }

  /** Emits only on real changes — listeners reconnect/re-render on events, so no noise. */
  private set(status: DesktopStatus): void {
    const next: DesktopStatus = { ...status, runtime: this.runtime };
    if (this.status.state === next.state && this.status.message === next.message && this.status.runtime?.cli === next.runtime?.cli) return;
    this.status = next;
    this.emitter.fire(next);
  }

  dispose(): void {
    this.stopPolling();
    this.emitter.dispose();
  }
}

/** The one-line install for the passt package on the common Linux families; undefined when unknown. */
async function passtInstallCommand(): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  const text = await import('node:fs/promises').then((fs) => fs.readFile('/etc/os-release', 'utf8')).catch(() => '');
  const ids = text
    .split('\n')
    .filter((l) => /^(ID|ID_LIKE)=/.test(l))
    .map((l) => l.replace(/^[^=]+=/, '').replace(/"/g, '').toLowerCase())
    .join(' ')
    .split(/\s+/);
  if (ids.some((i) => ['debian', 'ubuntu'].includes(i))) return 'sudo apt-get install -y passt';
  if (ids.some((i) => ['fedora', 'rhel', 'centos'].includes(i))) return 'sudo dnf install -y passt';
  if (ids.some((i) => ['arch'].includes(i))) return 'sudo pacman -S --needed --noconfirm passt';
  if (ids.some((i) => ['suse', 'opensuse'].includes(i))) return 'sudo zypper install -y passt';
  if (ids.some((i) => ['alpine'].includes(i))) return 'sudo apk add passt';
  return undefined;
}
