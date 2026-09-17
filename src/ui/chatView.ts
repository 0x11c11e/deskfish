import * as vscode from 'vscode';
import type { AgentController } from '../controller';
import type { Snapshot } from '../gateway/protocol';
import { answerAsk, snapshotChat } from '../webview/bridge';
import type { FromChat, PanelName, ToChat } from '../webview/protocol';
import { chatBody } from './bodies';
import { nonce } from './html';

/** The chat sidebar: desktop/model/key status rows, conversation + action feed, composer. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'deskfish.chat';
  private view?: vscode.WebviewView;
  private autoStarted = false;
  /** The view's script has said `ready` (messages posted before that are lost). */
  private viewReady = false;
  /** A panel a command asked for before the view was ready. */
  private pendingPanel?: PanelName;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly controller: AgentController,
    private readonly openDesktop: () => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    const desktop = this.controller.desktop;
    const subs: vscode.Disposable[] = [
      view.webview.onDidReceiveMessage((m: FromChat) =>
        this.onMessage(m).catch((err) => void vscode.window.showErrorMessage(`Deskfish: ${err instanceof Error ? err.message : String(err)}`)),
      ),
      // Connected again (the gateway restarted, or the link dropped): rebuild the chat from the gateway's present.
      this.controller.onDidConnect((snap) => {
        this.render(snap);
        void this.sendConfig();
        void this.autoStart();
      }),
      this.controller.onEvent((event) => this.send({ type: 'event', event })),
      this.controller.onDidReset(() => this.send({ type: 'newChat' })),
      this.controller.onDidReplay((r) => this.send({ type: 'replay', ...r })),
      this.controller.onDidSchedule((s) => this.send(s.kind === 'fired' ? { type: 'user', text: s.text } : { type: 'notice', text: s.text })),
      this.controller.onDidPost((p) => this.send(p.kind === 'user' ? { type: 'user', text: p.text } : { type: 'notice', text: p.text })),
      this.controller.onDidDownload((file) => this.send({ type: 'download', file })),
      desktop.onDidChange((status) => this.send({ type: 'desktop', status })),
      // The header shows the gateway's config: re-rendered when it (or the key slots) change, from any client.
      this.controller.onDidConfig(() => void this.sendConfig()),
      this.ctx.secrets.onDidChange((e) => {
        if (e.key.startsWith('deskfish.')) void this.sendConfig();
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          desktop.startPolling();
          void this.sendConfig();
        } else {
          desktop.stopPolling();
        }
      }),
    ];
    desktop.startPolling();
    view.onDidDispose(() => {
      desktop.stopPolling();
      subs.forEach((s) => s.dispose());
      this.view = undefined;
      this.viewReady = false;
    });
  }

  /** A command asked for a panel: show the sidebar, then the panel inside the chat view. */
  async openPanel(panel: PanelName): Promise<void> {
    this.pendingPanel = panel;
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    this.flushPanel();
  }

  private flushPanel(): void {
    if (!this.view || !this.viewReady || !this.pendingPanel) return;
    this.send({ type: 'open', panel: this.pendingPanel });
    this.pendingPanel = undefined;
  }

  private async onMessage(m: FromChat): Promise<void> {
    const desktop = this.controller.desktop;
    switch (m.type) {
      case 'ready':
        this.viewReady = true;
        await this.sendConfig();
        // A window opened mid-task shows the task as a window that watched it from the start.
        await this.controller.client.refreshSnapshot((snap) => this.render(snap)).catch(() => undefined);
        this.flushPanel();
        await this.autoStart();
        break;
      case 'ask':
        // The panels' gateway commands; only those `VIEW_COMMANDS` names reach it. A snapshot is answered
        // inside the frame that carried it, so it lands before the events after it.
        await answerAsk(
          m,
          (cmd, args, respond) =>
            cmd === 'snapshot'
              ? this.controller.client.refreshSnapshot((snap) => respond({ type: 'answer', id: m.id, ok: true, result: snap }))
              : this.controller.client.call(cmd, args as never),
          (a) => this.send(a),
        );
        break;
      case 'openFile':
        await this.controller.openFile(m.file === 'charter.md' ? 'charter.md' : 'memory.md');
        break;
      case 'refresh':
        await desktop.refresh();
        await this.sendConfig();
        break;
      case 'run':
        await this.controller.run(m.task, m.attachments);
        break;
      case 'say':
        this.controller.say(m.text, m.attachments);
        break;
      case 'attach': {
        const files = await this.controller.attachFiles();
        if (files.length) this.send({ type: 'attached', files });
        break;
      }
      case 'saveFile':
        try {
          const hostPath = await this.controller.saveFile(m.file);
          if (hostPath) this.send({ type: 'saved', path: m.file.path, hostPath });
          else this.send({ type: 'saveFailed', path: m.file.path, error: '' });
        } catch (err) {
          this.send({ type: 'saveFailed', path: m.file.path, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      case 'revealFile':
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.hostPath));
        break;
      case 'stop':
        this.controller.stop();
        break;
      case 'pause':
        this.controller.pause();
        break;
      case 'resume':
        this.controller.resume();
        break;
      case 'openDesktop':
        this.openDesktop();
        break;
      case 'setApiKey':
        await this.controller.setApiKey();
        break;
      case 'openSettings':
        await this.controller.changeModel();
        break;
      case 'startDesktop':
        void desktop.start();
        break;
      case 'stopDesktop':
        void this.controller.stopDesktop();
        break;
      case 'restartDesktop':
        void this.controller.restartDesktop();
        break;
      case 'showLog':
        await vscode.commands.executeCommand('deskfish.showLog');
        break;
      case 'openDocs':
        await vscode.commands.executeCommand('deskfish.openDocs');
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        break;
      case 'installRuntime':
        await desktop.installRuntime();
        break;
    }
  }

  /** Turn the desktop on once per window when the setting asks for it (after the gateway answers). */
  private async autoStart(): Promise<void> {
    const desktop = this.controller.desktop;
    if (!this.controller.gatewayConfig().autoStart || this.autoStarted || !this.controller.client.connected) return;
    await desktop.refresh().catch(() => undefined);
    if (desktop.current.state === 'off' && !desktop.runtimeMissing) {
      this.autoStarted = true;
      void desktop.start().catch(() => undefined);
    }
  }

  /** The current chat, its usage and step, and the running status, from a gateway snapshot. */
  private render(s: Snapshot): void {
    for (const m of snapshotChat(s)) this.send(m);
  }

  private async sendConfig(): Promise<void> {
    this.send({ type: 'config', config: await this.controller.uiConfig() });
  }

  private send(m: ToChat): void {
    void this.view?.webview.postMessage(m);
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'chat.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview', 'chat.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Deskfish</title>
</head>
<body>
${chatBody()}  <script type="module" nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }
}
