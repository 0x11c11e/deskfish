import * as vscode from 'vscode';
import type { AgentController } from '../controller';
import type { DesktopState } from '../desktop/manager';
import type { FromDesktop, ToDesktop } from '../webview/protocol';
import { desktopBody } from './bodies';
import { nonce } from './html';

/**
 * Editor-area panel showing the bot's desktop live over VNC (noVNC in a webview), with
 * take-over / hand-back controls wired to the agent's pause/resume, and a "Turn on" button when
 * the desktop is off.
 */
export class DesktopPanel {
  private static current?: DesktopPanel;

  /**
   * Open (or reveal) the live view. `preserveFocus` keeps the keyboard where it is — used when a
   * task starts from the chat, so the user sees the screen without losing the composer.
   */
  static show(ctx: vscode.ExtensionContext, controller: AgentController, output: vscode.OutputChannel, opts: { preserveFocus?: boolean } = {}): void {
    if (DesktopPanel.current) {
      DesktopPanel.current.panel.reveal(undefined, true);
      return;
    }
    DesktopPanel.current = new DesktopPanel(ctx, controller, output, opts.preserveFocus ?? false);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly subs: vscode.Disposable[] = [];
  private lastDesktopState: DesktopState = 'unknown';
  /** The live view's address, token and password as last seen, so only a real change reconnects. */
  private lastVnc?: string;

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly controller: AgentController,
    private readonly output: vscode.OutputChannel,
    preserveFocus: boolean,
  ) {
    this.panel = vscode.window.createWebviewPanel('deskfish.desktop', 'Deskfish — Desktop', { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    this.lastDesktopState = controller.desktop.current.state;
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg');
    this.panel.webview.html = this.html();

    this.subs.push(
      this.panel.webview.onDidReceiveMessage((m: FromDesktop) => this.onMessage(m)),
      this.controller.onEvent((e) => {
        if (e.type === 'status') this.send({ type: 'agentStatus', status: e.status, message: e.message, screenFree: e.screenFree });
        if (e.type === 'action') this.send({ type: 'agentAction', action: e.action });
        // An empty frame means the step took no new screenshot (nothing could have changed):
        // the fallback image keeps the one it has.
        if (e.type === 'screenshot' && e.jpegBase64) {
          this.send({ type: 'screenshot', dataUrl: `data:image/jpeg;base64,${e.jpegBase64}`, width: e.width, height: e.height });
        }
      }),
      this.controller.desktop.onDidChange((status) => {
        this.send({ type: 'desktop', status });
        // Reconnect only when the desktop actually comes up, never on repeated "still on" pings.
        if (status.state === 'on' && this.lastDesktopState !== 'on') this.sendConnect();
        this.lastDesktopState = status.state;
      }),
      this.controller.onDidConfig((cfg) => {
        // The gateway reads the tank's address when the view connects: a new address, token or password is a reconnect.
        const vnc = `${cfg.vncUrl}\n${cfg.daemonToken}\n${cfg.vncPassword}`;
        if (this.lastVnc !== undefined && vnc !== this.lastVnc) this.sendConnect();
        this.lastVnc = vnc;
      }),
      // A gateway that restarted (or a dropped link): reconnect the live view and re-announce the state.
      this.controller.onDidConnect((snap) => {
        this.send({ type: 'desktop', status: snap.desktop.status });
        this.lastDesktopState = snap.desktop.status.state;
        this.sendConnect();
        this.send({ type: 'agentStatus', status: snap.status, message: snap.statusMessage, screenFree: snap.screenFree });
        if (snap.screenshot) this.send({ type: 'screenshot', dataUrl: snap.screenshot.dataUrl, width: snap.screenshot.width, height: snap.screenshot.height });
      }),
    );
    // Bot → host clipboard: x11vnc's cut-text push is unreliable, so while the pane is visible and
    // the desktop is on, poll the daemon's clipboard and mirror changes to the host clipboard.
    const clipboardPoll = setInterval(() => {
      if (this.panel.visible && this.controller.desktop.current.state === 'on') void this.controller.pullClipboardFromDesktop('');
    }, 1500);
    this.subs.push(new vscode.Disposable(() => clearInterval(clipboardPoll)));

    this.panel.onDidDispose(() => {
      this.subs.forEach((s) => s.dispose());
      DesktopPanel.current = undefined;
    });
  }

  private onMessage(m: FromDesktop): void {
    switch (m.type) {
      case 'ready':
        this.send({ type: 'desktop', status: this.controller.desktop.current });
        this.sendConnect();
        this.send({ type: 'agentStatus', status: this.controller.currentStatus, screenFree: this.controller.screenFree });
        if (this.controller.latestScreenshot) this.send({ type: 'screenshot', ...this.controller.latestScreenshot });
        break;
      case 'takeover':
        this.controller.pause();
        break;
      case 'handback':
        this.controller.resume();
        break;
      case 'startDesktop':
        void this.controller.desktop.start();
        break;
      case 'releaseInput':
        void this.controller.releaseInput();
        break;
      case 'clipboardSync':
        void this.controller.pushClipboardToDesktop().then((ok) => this.send({ type: 'clipboardSynced', ok, paste: m.paste }));
        break;
      case 'clipboardChanged':
        void this.controller.pullClipboardFromDesktop(m.text);
        break;
      case 'log':
        this.output.appendLine(`[desktop ${m.level}] ${m.message}`);
        break;
    }
  }

  /** The live view goes through the gateway's `/vnc` (one port, one token), which pipes it to the tank's websockify. */
  private sendConnect(): void {
    this.send({ type: 'connect', url: this.controller.vncUrl(), password: this.controller.gatewayConfig().vncPassword || undefined });
  }

  private send(m: ToDesktop): void {
    void this.panel.webview.postMessage(m);
  }

  private html(): string {
    const webview = this.panel.webview;
    const n = nonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'desktop.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview', 'desktop.js'));
    // The websocket origin (the gateway) must be allowed explicitly; localhost variants are allowed
    // regardless so the default setup works without touching CSP.
    let wsOrigin = '';
    try {
      const u = new URL(this.controller.vncUrl());
      wsOrigin = `${u.protocol}//${u.host}`;
    } catch {
      /* invalid URL — the webview will report it */
    }
    const connectSrc = [wsOrigin, 'ws://localhost:*', 'wss://localhost:*', 'ws://127.0.0.1:*', 'wss://127.0.0.1:*'].filter(Boolean).join(' ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; connect-src ${connectSrc}; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Deskfish — Desktop</title>
</head>
<body>
${desktopBody()}  <script type="module" nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }
}
