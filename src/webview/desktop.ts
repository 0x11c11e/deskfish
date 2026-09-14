import RFB from '@novnc/novnc';
import type { AgentStatus } from '../agent/loop';
import type { ComputerAction } from '../computer/types';
import type { DesktopStatus } from '../desktop/manager';
import type { FromDesktop, ToDesktop } from './protocol';

/**
 * The live desktop pane. noVNC renders the VM's screen into #screen over a WebSocket; this is the
 * human's channel to the desktop and is entirely separate from the agent's channel (the daemon's
 * REST API).
 *
 * Input rules: while the agent is *running* the canvas is view-only and "Take over" pauses the
 * agent. Whenever the agent is paused — because you took over, or because it called ask_user —
 * input is unlocked and "Hand back to agent" resumes it (the agent then re-reads the screen).
 * When no task is active you can use the desktop freely.
 */

const vscode = acquireVsCodeApi();
const post = (m: FromDesktop) => vscode.postMessage(m);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const screen = $<HTMLDivElement>('screen');
const statusEl = $<HTMLSpanElement>('status');
const agentEl = $<HTMLSpanElement>('agent');
const takeoverBtn = $<HTMLButtonElement>('takeover');
const reconnectBtn = $<HTMLButtonElement>('reconnect');
const fallback = $<HTMLDivElement>('fallback');
const fallbackImg = $<HTMLImageElement>('fallbackImg');
const fallbackTitle = $<HTMLDivElement>('fallbackTitle');
const fallbackHint = $<HTMLDivElement>('fallbackHint');
const turnOnBtn = $<HTMLButtonElement>('turnOn');

let rfb: RFB | undefined;
let connected = false;
let connectedUrl = '';
let agentStatus: AgentStatus = 'idle';
let agentMessage = '';
/** The run never touches the screen (a reflection): no lock, no take-over button. */
let screenFree = false;
let desktop: DesktopStatus = { state: 'unknown' };
let conn: { url: string; password?: string } | undefined;
/* Automatic reconnect: a socket that drops while the desktop stays on (suspend/resume, a
 * websockify hiccup) is retried with backoff instead of waiting for the Reconnect button. */
let connecting = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 1000;
const RETRY_MAX = 30_000;

function cancelRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
}

function scheduleReconnect(): void {
  if (retryTimer || !conn || desktop.state !== 'on') return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (!connected && !connecting && desktop.state === 'on') connect(true);
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
}

/** Try right now (tab shown again, window focused, network back, user clicked Reconnect). */
function reconnectNow(): void {
  retryDelay = 1000;
  cancelRetry();
  if (conn && !connected && !connecting && desktop.state === 'on') connect(true);
}

function setStatusText(text: string, cls = ''): void {
  statusEl.textContent = text;
  statusEl.className = cls;
}

function applyInputMode(): void {
  const viewOnly = agentStatus === 'running' && !screenFree;
  if (rfb) rfb.viewOnly = viewOnly;
  screen.classList.toggle('viewonly', viewOnly);

  if (agentStatus === 'running' && screenFree) {
    takeoverBtn.style.display = 'none';
  } else if (agentStatus === 'running') {
    takeoverBtn.style.display = '';
    takeoverBtn.textContent = 'Take over';
    takeoverBtn.className = 'takeover';
  } else if (agentStatus === 'paused') {
    takeoverBtn.style.display = '';
    takeoverBtn.textContent = 'Hand back to agent';
    takeoverBtn.className = '';
  } else {
    takeoverBtn.style.display = 'none';
  }
  agentEl.textContent =
    agentStatus === 'running' && screenFree
      ? 'agent: reflecting — the desktop is yours'
      : agentStatus === 'paused' && agentMessage
        ? `agent: paused — ${agentMessage}`
        : `agent: ${agentStatus}`;
  agentEl.className = agentStatus;
}

function connect(force = false): void {
  if (!conn) return;
  // Already live on this URL? Then a repeated connect request is noise — reconnecting would black
  // out the screen and briefly show x11vnc's stale frame.
  if (!force && connected && rfb && connectedUrl === conn.url) return;
  disconnect();
  connectedUrl = conn.url;
  if (desktop.state !== 'on' && desktop.state !== 'unknown') {
    // Nothing to connect to yet; the fallback explains and offers to turn it on.
    setStatusText(desktop.state === 'starting' ? 'desktop starting…' : 'desktop off');
    showFallback(true);
    return;
  }
  setStatusText(`connecting to ${conn.url}…`);
  cancelRetry();
  try {
    rfb = new RFB(screen, conn.url, conn.password ? { credentials: { password: conn.password } } : undefined);
  } catch (err) {
    setStatusText(`VNC error: ${String(err)}`, 'error');
    post({ type: 'log', level: 'error', message: `RFB constructor failed: ${String(err)}` });
    showFallback(true);
    scheduleReconnect();
    return;
  }
  connecting = true;
  const thisRfb = rfb;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.background = '#111';
  rfb.qualityLevel = 7;
  rfb.addEventListener('connect', () => {
    if (thisRfb !== rfb) return; // a stale attempt
    connected = true;
    connecting = false;
    retryDelay = 1000;
    cancelRetry();
    setStatusText('connected', 'connected');
    showFallback(false);
    applyInputMode();
  });
  rfb.addEventListener('disconnect', (ev: Event) => {
    if (thisRfb !== rfb) return; // we replaced it on purpose (connect(true) / disconnect())
    connected = false;
    connecting = false;
    const clean = (ev as CustomEvent<{ clean: boolean }>).detail?.clean;
    setStatusText(clean ? 'disconnected — reconnecting…' : 'connection lost — reconnecting…', 'error');
    showFallback(true);
    scheduleReconnect();
  });
  rfb.addEventListener('credentialsrequired', () => {
    setStatusText('VNC password required — set deskfish.desktop.vncPassword', 'error');
  });
  rfb.addEventListener('securityfailure', (ev: Event) => {
    const d = (ev as CustomEvent<{ reason?: string }>).detail;
    setStatusText(`VNC security failure: ${d?.reason ?? ''}`, 'error');
  });
  // Bot → host: the desktop's selection changed (someone copied inside the bot's apps).
  rfb.addEventListener('clipboard', (ev: Event) => {
    const text = (ev as CustomEvent<{ text?: string }>).detail?.text ?? '';
    post({ type: 'clipboardChanged', text });
  });
  applyInputMode();
}

/* ---------- clipboard: host → bot ---------- */

// noVNC keysyms
const XK_Control_L = 0xffe3;
const XK_v = 0x76;
let pendingPaste = false;

function syncClipboard(paste: boolean): void {
  if (!connected) return;
  if (paste) pendingPaste = true;
  post({ type: 'clipboardSync', paste });
}

function sendCtrlV(): void {
  if (!rfb) return;
  rfb.sendKey(XK_Control_L, 'ControlLeft', true);
  rfb.sendKey(XK_v, 'KeyV', true);
  rfb.sendKey(XK_v, 'KeyV', false);
  rfb.sendKey(XK_Control_L, 'ControlLeft', false);
}

// Keep the desktop's clipboard fresh whenever the user comes back to the pane…
window.addEventListener('focus', () => syncClipboard(false));
screen.addEventListener('mousedown', () => syncClipboard(false));
// …and make Ctrl+V / Shift+Insert paste *today's* host clipboard: hold the keystroke until synced.
screen.addEventListener(
  'keydown',
  (ev) => {
    const isPaste = (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.code === 'KeyV') || (ev.shiftKey && ev.code === 'Insert');
    if (!isPaste || rfb?.viewOnly) return;
    ev.preventDefault();
    ev.stopPropagation();
    syncClipboard(true);
  },
  true,
);

function disconnect(): void {
  if (rfb) {
    const old = rfb;
    rfb = undefined; // listeners on `old` see thisRfb !== rfb and ignore its disconnect event
    try {
      old.disconnect();
    } catch {
      /* ignore */
    }
  }
  connected = false;
  connecting = false;
}

function showFallback(show: boolean): void {
  fallback.classList.toggle('visible', show);
  if (!show) return;
  const busy = desktop.state === 'starting' || desktop.state === 'stopping';
  turnOnBtn.hidden = busy || desktop.state === 'on';
  switch (desktop.state) {
    case 'starting':
      fallbackTitle.textContent = 'Turning on the desktop…';
      fallbackHint.textContent = desktop.message ?? 'This takes a few minutes the very first time (the image is built), a couple of seconds after that.';
      break;
    case 'stopping':
      fallbackTitle.textContent = 'Turning off the desktop…';
      fallbackHint.textContent = '';
      break;
    case 'error':
      fallbackTitle.textContent = 'The desktop could not start';
      fallbackHint.textContent = desktop.message ?? 'See the Deskfish output channel for details.';
      break;
    case 'on':
      fallbackTitle.textContent = 'Connecting…';
      fallbackHint.textContent = conn ? `No VNC connection to ${conn.url} yet. Retrying automatically; click Reconnect to try right now.` : '';
      break;
    default:
      fallbackTitle.textContent = 'The desktop is off';
      fallbackHint.textContent = 'The bot works on its own sandboxed desktop. Turn it on to watch and take over when needed.';
  }
}

/*
 * noVNC only listens for mouseup on its canvas. If a press starts on the canvas and the release
 * happens outside it (or the window loses focus), the bot's X server keeps the button/modifier
 * held and every later click turns into a drag-select. Ask the daemon to release everything
 * whenever that can have happened.
 */
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let lastRelease = 0;
/** Only while the person has the desktop: a release mid-drag would break the agent's own actions. */
const userHasControl = () => connected && !!rfb && !rfb.viewOnly;
/*
 * A press that started on the canvas and has not been released is the person selecting or
 * dragging. The focus-driven releases must not fire then: a release lets go of *their* button as
 * much as the agent's (both inject through XTEST), which ended every text selection after one
 * character (2026-09-13: the live view sent a release right after each mousedown). Capture phase,
 * because noVNC stops mouse events at its canvas before they would bubble here.
 */
let buttonHeld = false;
screen.addEventListener('mousedown', () => { buttonHeld = true; }, true);
window.addEventListener('mouseup', () => { buttonHeld = false; }, true);
function releaseInputSoon(unlessHeld = false): void {
  if (!userHasControl()) return;
  if (unlessHeld && buttonHeld) return;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    if (unlessHeld && buttonHeld) return;
    lastRelease = Date.now();
    post({ type: 'releaseInput' });
  }, 60);
}
/** Same, but at most every few seconds: for the events that fire constantly (entering the canvas, focus). */
function releaseInputIfStale(): void {
  if (Date.now() - lastRelease > 3000) releaseInputSoon(true);
}
window.addEventListener('mouseup', (ev) => {
  if (!screen.contains(ev.target as Node)) releaseInputSoon();
});
window.addEventListener('blur', () => releaseInputSoon(true));
document.addEventListener('mouseleave', () => releaseInputSoon());
screen.addEventListener('mouseleave', (ev) => {
  if (ev.buttons) releaseInputSoon(); // left the canvas with a button still down
});
// Just before the person starts interacting: whatever was left held (by anyone) is let go, so the
// first click after a take-over is a plain click.
screen.addEventListener('mouseenter', (ev) => {
  if (!ev.buttons) releaseInputIfStale();
});
screen.addEventListener('focusin', releaseInputIfStale);

/*
 * Her pointer: a large drawn cursor that glides to each target before she clicks, pulses on the
 * click, and carries a short label. Pure drawing from the actions the extension already reports —
 * the model never sees it and it costs no tokens. Coordinates arrive in native display pixels; the
 * canvas's on-screen size gives the mapping. Shown only while she works; never when you have the
 * desktop.
 */
const pointer = document.createElement('div');
pointer.id = 'agent-pointer';
pointer.innerHTML =
  '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M5 3l14 8.5-6.2 1.6L9.6 19z" fill="#fff" stroke="#0e2a30" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="label"></span>';
screen.appendChild(pointer);
const pointerLabel = pointer.querySelector('.label') as HTMLSpanElement;
let pointerFrac = { x: 0.5, y: 0.5 };
let pointerHideTimer: ReturnType<typeof setTimeout> | undefined;
let pointerQueue: Promise<void> = Promise.resolve();

function canvasRect(): { left: number; top: number; width: number; height: number; fbW: number; fbH: number } | undefined {
  const canvas = screen.querySelector('canvas');
  if (!canvas || !canvas.width || !canvas.height) return undefined;
  const r = canvas.getBoundingClientRect();
  const s = screen.getBoundingClientRect();
  return { left: r.left - s.left, top: r.top - s.top, width: r.width, height: r.height, fbW: canvas.width, fbH: canvas.height };
}

function placePointer(): void {
  const c = canvasRect();
  if (!c) return;
  const x = c.left + pointerFrac.x * c.width;
  const y = c.top + pointerFrac.y * c.height;
  pointer.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}

/** Glide to a native-pixel point; resolves when the glide is over. */
function glideTo(nx: number, ny: number, ms: number): Promise<void> {
  const c = canvasRect();
  if (!c) return Promise.resolve();
  pointerFrac = { x: Math.max(0, Math.min(1, nx / c.fbW)), y: Math.max(0, Math.min(1, ny / c.fbH)) };
  pointer.style.transitionDuration = `${ms}ms`;
  placePointer();
  return new Promise((r) => setTimeout(r, ms));
}

function ripple(kind: 'click' | 'zoom'): void {
  const c = canvasRect();
  if (!c) return;
  const el = document.createElement('div');
  el.className = `agent-ripple ${kind}`;
  el.style.left = `${(c.left + pointerFrac.x * c.width).toFixed(1)}px`;
  el.style.top = `${(c.top + pointerFrac.y * c.height).toFixed(1)}px`;
  screen.appendChild(el);
  setTimeout(() => el.remove(), 700);
}

function showPointer(label: string): void {
  pointer.classList.add('on');
  pointerLabel.textContent = label;
  pointerLabel.hidden = !label;
  clearTimeout(pointerHideTimer);
  pointerHideTimer = setTimeout(hidePointer, 6000);
}

function hidePointer(): void {
  clearTimeout(pointerHideTimer);
  pointer.classList.remove('on');
}

const shortText = (t: string, max = 28) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

function showAction(a: ComputerAction): void {
  if (agentStatus !== 'running' || screenFree) return;
  pointerQueue = pointerQueue.then(async () => {
    switch (a.type) {
      case 'click': {
        const name = a.button === 'right' ? 'right-click' : a.button === 'middle' ? 'middle-click' : a.count === 2 ? 'double-click' : a.count === 3 ? 'triple-click' : 'click';
        showPointer(name);
        { const cx = a.x, cy = a.y; if (cx !== undefined && cy !== undefined) await glideTo(cx, cy, 320); }
        ripple('click');
        break;
      }
      case 'mouse_move':
        showPointer('');
        { const mx = a.x, my = a.y; if (mx !== undefined && my !== undefined) await glideTo(mx, my, 320); }
        break;
      case 'drag':
        showPointer('drag');
        await glideTo(a.from.x, a.from.y, 250);
        await glideTo(a.to.x, a.to.y, 600);
        ripple('click');
        break;
      case 'scroll':
        showPointer(`scroll ${a.direction} ×${a.amount}`);
        { const sx = a.x, sy = a.y; if (sx !== undefined && sy !== undefined) await glideTo(sx, sy, 320); }
        break;
      case 'type':
        showPointer(`type ${JSON.stringify(shortText(a.text))}`);
        break;
      case 'key':
        showPointer(`key ${a.keys.join('+')}`);
        break;
      case 'zoom':
        showPointer('zoom');
        ripple('zoom');
        break;
      case 'find':
        showPointer(`find ${JSON.stringify(shortText(a.query))}`);
        break;
      case 'read_page':
        showPointer(a.scope === 'text' ? 'reading the page text' : 'reading the page');
        break;
      case 'run_command':
        showPointer(`run ${JSON.stringify(shortText(a.command))}`);
        break;
      case 'wait_for':
        showPointer('standing by');
        break;
      case 'wait':
        showPointer(`wait ${a.seconds}s`);
        break;
      default:
        break;
    }
  });
}

window.addEventListener('resize', placePointer);

takeoverBtn.addEventListener('click', () => {
  if (agentStatus === 'running') {
    post({ type: 'takeover' });
    rfb?.focus();
  } else if (agentStatus === 'paused') {
    post({ type: 'handback' });
  }
});
reconnectBtn.addEventListener('click', () => {
  retryDelay = 1000;
  cancelRetry();
  connect(true);
});
// The usual reasons a live view is stale: the tab was hidden, the window lost focus for a long
// time (suspend), or the network went away. Try immediately when any of those ends.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reconnectNow();
});
window.addEventListener('focus', reconnectNow);
window.addEventListener('online', reconnectNow);
turnOnBtn.addEventListener('click', () => post({ type: 'startDesktop' }));

window.addEventListener('message', (ev: MessageEvent<ToDesktop>) => {
  const m = ev.data;
  switch (m.type) {
    case 'desktop':
      desktop = m.status;
      // Old screenshots are meaningless once the desktop is off or being restarted.
      if (desktop.state !== 'on') fallbackImg.removeAttribute('src');
      if (desktop.state !== 'on') cancelRetry();
      if (!connected) {
        showFallback(true);
        // The desktop is on (every 15 s health ping says so) but we are not connected: retry.
        if (desktop.state === 'on' && !connecting && !retryTimer) scheduleReconnect();
      }
      break;
    case 'connect':
      conn = { url: m.url, password: m.password || undefined };
      connect(conn.url !== connectedUrl);
      break;
    case 'screenshot':
      if (!connected) {
        fallbackImg.src = m.dataUrl;
        showFallback(true);
      }
      break;
    case 'agentAction':
      showAction(m.action);
      break;
    case 'agentStatus':
      agentStatus = m.status;
      agentMessage = m.message ?? '';
      screenFree = !!m.screenFree;
      applyInputMode();
      if (agentStatus !== 'running' || screenFree) hidePointer();
      if (agentStatus === 'paused') rfb?.focus();
      break;
    case 'clipboardSynced':
      if (m.paste && pendingPaste) {
        pendingPaste = false;
        sendCtrlV(); // paste whatever the desktop clipboard holds now (synced, or the old one if sync failed)
      }
      break;
  }
});

showFallback(true);
applyInputMode();
post({ type: 'ready' });
