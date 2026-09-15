import * as vscode from 'vscode';
import { readConfig } from '../config';
import type { AgentController } from '../controller';
import type { FromChat, ToChat } from '../webview/protocol';
import { nonce } from './html';

/** The chat sidebar: desktop/model/key status rows, conversation + action feed, composer. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'deskfish.chat';
  private view?: vscode.WebviewView;
  private autoStarted = false;

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
      view.webview.onDidReceiveMessage((m: FromChat) => void this.onMessage(m)),
      this.controller.onEvent((event) => this.send({ type: 'event', event })),
      this.controller.onDidReset(() => this.send({ type: 'newChat' })),
      this.controller.onDidReplay((r) => this.send({ type: 'replay', ...r })),
      this.controller.onDidSchedule((s) => this.send(s.kind === 'fired' ? { type: 'user', text: s.text } : { type: 'notice', text: s.text })),
      this.controller.onDidPost((p) => this.send(p.kind === 'user' ? { type: 'user', text: p.text } : { type: 'notice', text: p.text })),
      this.controller.onDidDownload((file) => this.send({ type: 'download', file })),
      desktop.onDidChange((status) => this.send({ type: 'desktop', status })),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('deskfish')) void this.sendConfig();
      }),
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
    });
  }

  private async onMessage(m: FromChat): Promise<void> {
    const desktop = this.controller.desktop;
    switch (m.type) {
      case 'ready':
        await this.sendConfig();
        await desktop.refresh();
        if (readConfig().autoStart && !this.autoStarted && desktop.current.state === 'off' && !desktop.runtimeMissing) {
          this.autoStarted = true;
          void desktop.start();
        }
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
  <header id="header">
    <div class="row" id="rowDesktop">
      <span class="rowlabel">Desktop</span>
      <span class="rowvalue"><span class="dot" id="desktopDot"></span><span id="desktopText">…</span></span>
      <span class="rowactions">
        <button class="mini" id="openDesktop" title="Open the live view of the bot's desktop in an editor tab" hidden>Open</button>
        <button class="mini" id="showLog" title="Show the Deskfish log" hidden>Show log</button>
        <button class="mini" id="powerBtn">Turn on</button>
      </span>
    </div>
    <div class="row">
      <span class="rowlabel">Model</span>
      <span class="rowvalue text" id="modelText">…</span>
      <span class="rowactions"><button class="mini" id="changeModel" title="Choose where the model comes from and which model">Change</button></span>
    </div>
    <div class="row" id="rowKey">
      <span class="rowlabel">API key</span>
      <span class="rowvalue text" id="keyText">…</span>
      <span class="rowactions"><button class="mini" id="keyBtn" title="Enter the API key. It is stored in your OS keychain, never in a settings file.">Set API key</button></span>
    </div>
  </header>

  <main id="log">
    <div id="empty">
      <div class="mascot">${ICON.fish}</div>
      <div class="title">Give Deskfish a task</div>
      <div class="sub">It works in its own tank — the Desktop tab — and knocks on the glass when it needs a login, a code or a CAPTCHA.</div>
      <div class="examples">
        <button class="example">Open example.com and summarize the page</button>
        <button class="example">Search the web for today's weather in Madrid</button>
        <button class="example">Open a terminal and show the disk usage</button>
      </div>
      <button class="textlink" id="docs" title="Open the documentation in your browser">How Deskfish works</button>
    </div>
  </main>

  <footer id="composer">
    <div id="statusrow">
      <span id="spinner" hidden></span>
      <span id="statusline">Ready</span>
      <span id="usage"></span>
    </div>
    <div id="inputrow">
      <div id="attachments" hidden></div>
      <textarea id="task" rows="3" placeholder="Tell the bot what to do…  (Enter to send, Shift+Enter for a new line)"></textarea>
      <div id="buttons">
        <button id="attach" class="icon" title="Attach a file — it is copied to the bot's desktop">${ICON.clip}</button>
        <button id="run" class="primary" title="Run (Enter)">${ICON.send}<span>Run</span></button>
        <button id="pause" class="icon" title="Pause the bot and take the desktop" hidden>${ICON.pause}</button>
        <button id="resume" class="icon" title="Hand the desktop back and resume" hidden>${ICON.play}</button>
        <button id="stop" class="icon danger" title="Stop the task" disabled>${ICON.stop}</button>
      </div>
    </div>
  </footer>
  <script type="module" nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }
}

/** Inline SVG icons (stroke = currentColor) so the webview needs no icon font. */
const ICON = {
  sparkle:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M15 8l2 2M18 5l2 2"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5.5" y="5.5" width="13" height="13" rx="2"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14M13 6l6 6-6 6"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.6 17.3a1.6 1.6 0 0 1-2.3-2.3l7.6-7.6"/></svg>',
  fish: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12c1.9-2.6 4.4-3.7 6.6-3.3 2.3.4 3.9 1.9 4.6 3.3-.7 1.4-2.3 2.9-4.6 3.3-2.2.4-4.7-.7-6.6-3.3z"/><path d="M15.7 12l3.8-2.5v5z"/><circle cx="7.4" cy="11.4" r="1" fill="currentColor" stroke="none"/><circle cx="17.5" cy="6" r="1"/><circle cx="19.8" cy="3.6" r=".7"/></svg>',
};
