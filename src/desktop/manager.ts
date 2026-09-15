import * as vscode from 'vscode';
import type { DesktopStatus, DesktopSupervisor } from './supervisor';
import { terminalCommand, type RuntimeStatus } from './runtime';

export type { DesktopState, DesktopStatus } from './supervisor';

/**
 * VS Code-side face of the desktop: the state machine, the health poll and the engine live in the
 * vscode-free `DesktopSupervisor` (owned by the service); this adds what only VS Code can show — the
 * progress notification while it turns on, error popups, the passt warning and the visible install
 * terminal.
 */
export class DesktopManager implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<DesktopStatus>();
  readonly onDidChange = this.emitter.event;
  /** Resolves the progress notification opened when the desktop entered `starting`. */
  private endProgress?: () => void;
  private readonly off: (() => void)[] = [];

  constructor(
    private readonly supervisor: DesktopSupervisor,
    private readonly output: vscode.OutputChannel,
  ) {
    const on = (name: string, fn: (...args: any[]) => void) => {
      supervisor.on(name, fn);
      this.off.push(() => supervisor.off(name, fn));
    };
    on('change', (s: DesktopStatus) => {
      this.progress(s);
      this.emitter.fire(s);
    });
    on('hostNetwork', () => this.warnHostNetwork());
    on('startFailed', (message: string) => {
      void vscode.window.showErrorMessage(`Deskfish: could not turn on the desktop — ${message}`, 'Show log').then((c) => {
        if (c) this.output.show();
      });
    });
    on('stopFailed', (message: string) => {
      void vscode.window.showErrorMessage(`Deskfish: could not stop the desktop — ${message}`);
    });
  }

  get current(): DesktopStatus {
    return this.supervisor.current;
  }

  /** A notification with the start's progress lines, open while the desktop is `starting`. */
  private progress(s: DesktopStatus): void {
    if (s.state === 'starting') {
      if (this.endProgress) return;
      let report: ((message: string) => void) | undefined;
      const done = new Promise<void>((resolve) => (this.endProgress = resolve));
      const sub = this.emitter.event((next) => {
        if (next.state === 'starting' && next.message) report?.(next.message);
      });
      void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Deskfish desktop', cancellable: false }, async (p) => {
        report = (message) => p.report({ message });
        await done;
        sub.dispose();
      });
      return;
    }
    this.endProgress?.();
    this.endProgress = undefined;
  }

  refresh(): Promise<DesktopStatus> {
    return this.supervisor.refresh();
  }

  get runtimeMissing(): boolean {
    return this.supervisor.runtimeMissing;
  }

  detectRuntime(): Promise<RuntimeStatus> {
    return this.supervisor.detectRuntime();
  }

  /**
   * Open a terminal with this system's install command (visible, password prompt and all), and
   * re-detect when the terminal closes. Never installs anything silently.
   */
  private warnedHostNetwork = false;

  get networkMode(): 'isolated' | 'host' | undefined {
    return this.supervisor.networkMode;
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
    const rt = this.supervisor.runtime?.cli === 'none' ? this.supervisor.runtime : await this.detectRuntime();
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
    this.supervisor.startPolling(intervalMs);
  }

  stopPolling(): void {
    this.supervisor.stopPolling();
  }

  /** Turn on if needed. Resolves true when the desktop is usable. */
  ensureOn(): Promise<boolean> {
    return this.supervisor.ensureOn();
  }

  start(): Promise<boolean> {
    return this.supervisor.start();
  }

  stop(): Promise<void> {
    return this.supervisor.stop();
  }

  toggle(): Promise<void> {
    return this.supervisor.toggle();
  }

  dispose(): void {
    this.stopPolling();
    this.off.forEach((f) => f());
    this.endProgress?.();
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
