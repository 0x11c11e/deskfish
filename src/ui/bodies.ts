/**
 * The HTML bodies of the two views — the chat and the Desktop tab — as one source for both hosts:
 * the VS Code webviews (`ChatViewProvider`, `DesktopPanel`) and the web page the gateway serves
 * (`src/gateway/web.ts`). Static markup only: every string that changes is set by the view's script
 * with `textContent`. No `vscode` import, so the gateway can use it.
 */

export type ViewHost = 'vscode' | 'web';

/** The chat: desktop/model/key status rows, conversation + action feed, composer. */
export function chatBody(host: ViewHost = 'vscode'): string {
  const web = host === 'web';
  const openTitle = web ? "Show the live view of the bot's desktop" : "Open the live view of the bot's desktop in an editor tab";
  const keyTitle = web ? "Enter the API key. It is kept in the gateway's secrets file, never in a settings file." : 'Enter the API key. It is stored in your OS keychain, never in a settings file.';
  const docsTitle = web ? 'Open the documentation in a new tab' : 'Open the documentation in your browser';
  return `  <header id="header">
    <div class="row" id="rowDesktop">
      <span class="rowlabel">Desktop</span>
      <span class="rowvalue"><span class="dot" id="desktopDot"></span><span id="desktopText">…</span></span>
      <span class="rowactions">
        <button class="mini" id="openDesktop" title="${openTitle}" hidden>Open</button>
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
      <span class="rowactions"><button class="mini" id="keyBtn" title="${keyTitle}">Set API key</button></span>
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
      <button class="textlink" id="docs" title="${docsTitle}">How Deskfish works</button>
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
`;
}

/**
 * The Desktop view: noVNC's screen with a fallback, the status pills and Take over / Hand back.
 * In VS Code the toolbar sits above the screen (an editor tab); on the web page, under it.
 */
export function desktopBody(host: ViewHost = 'vscode'): string {
  const toolbar = `  <div id="toolbar">
    <span id="status">disconnected</span>
    <span id="agent">agent: idle</span>
    <span class="spacer"></span>
    <button id="takeover" class="takeover" style="display:none">Take over</button>
    <button id="reconnect" class="secondary" title="Reconnect the live view">Reconnect</button>
  </div>
`;
  const stage = `  <div id="stage">
    <div id="screen"></div>
    <div id="fallback">
      <img id="fallbackImg" alt="">
      <div id="fallbackTitle" class="title"></div>
      <div id="fallbackHint" class="hint"></div>
      <button id="turnOn" class="primary" hidden>Turn on the desktop</button>
    </div>
  </div>
`;
  return host === 'web' ? stage + toolbar : toolbar + stage;
}

/** Inline SVG icons (stroke = currentColor) so the webview needs no icon font. */
export const ICON = {
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
