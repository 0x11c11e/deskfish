import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserWindow, Menu, Notification, app, dialog, session, shell, type Session, type WebContents } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { AgentEvent } from '../src/agent/loop';
import type { DesktopStatus } from '../src/desktop/supervisor';
import { GatewayClient } from '../src/gateway/client';
import { DEFAULT_PORT } from '../src/gateway/protocol';
import { probeGateway, settleLocalGateway } from '../src/gateway/spawn';
import { startGateway, type StartedGateway } from '../src/gateway/start';
import { LogFile, dataDir, ensureToken } from '../src/gateway/storage';
import { VERSION } from '../src/gateway/version';
import { LoginItem } from './autostart';
import { terminalLaunches } from './terminal';
import { AppTray } from './tray';

/**
 * Deskfish as a program: Electron's main process is the gateway (the same `startGateway` as
 * `deskfish serve`: one writer, one data dir, one token), or attaches to a gateway already answering
 * on this computer (the extension may have started it), as `decide.ts` says. The window is the page
 * the gateway serves and nothing more: no preload, no Node, no Electron API in it. Closing the window
 * hides it to the tray; Quit stops the gateway this app started (the tank keeps running).
 *
 * `--hidden` starts in the tray (the login entry). `--port N` or `DESKFISH_PORT`, and `DESKFISH_HOME`,
 * point it elsewhere for a scratch check.
 */

const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const PORT = Number(argValue('--port') ?? process.env.DESKFISH_PORT ?? DEFAULT_PORT);
const URL_BASE = `http://127.0.0.1:${PORT}`;
/** The Deskfish folder: the packaged resources, or the checkout when run with `npm run app`. */
const RESOURCES = app.isPackaged ? path.join(process.resourcesPath, 'deskfish') : path.resolve(__dirname, '..', '..');
const ICONS = app.isPackaged ? path.join(__dirname, 'icons') : path.join(RESOURCES, 'app', 'icons');

const DIR = dataDir();
const appLog = new LogFile(path.join(DIR, 'logs', 'app.log'));
const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  appLog.append(stamped);
  if (!app.isPackaged) process.stdout.write(stamped);
};

let gateway: StartedGateway | undefined;
let client: GatewayClient | undefined;
let win: BrowserWindow | undefined;
let tray: AppTray | undefined;
let quitting = false;
let knocking = false;
/** The knock is followed by "running — Pausing…" and then "paused"; it is over when she runs again after the pause, or the task ends. */
let knockPaused = false;
/** The window says "needs you" (the page's own title updates are held back meanwhile) until it is focused or the knock ends. */
let knockTitle = false;
function setKnockTitle(on: boolean): void {
  knockTitle = on;
  win?.setTitle(on ? '✋ Deskfish needs you' : 'Deskfish');
  win?.flashFrame(on);
}
let loginItem: LoginItem;

/* ---------- the gateway: find, or start in this process ---------- */

/** Open the install command in the OS terminal (the gateway calls this for "Install Podman"). */
async function openTerminal(command: string): Promise<void> {
  for (const t of terminalLaunches(process.platform, command)) {
    if (process.platform === 'linux' && !(await onPathQuietly(t.file))) continue;
    const child = spawn(t.file, t.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: t.verbatim });
    child.on('error', (err) => log(`terminal ${t.file}: ${err.message}`));
    child.unref();
    log(`— opened ${t.file} with the install command —`);
    return;
  }
  throw new Error('no terminal program was found (tried x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, xterm)');
}

/** `command -v`, not `<bin> --version` (the desktop's `onPath`): a terminal asked for its version might open a window. */
function onPathQuietly(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn('sh', ['-c', `command -v ${JSON.stringify(bin)} >/dev/null`], { stdio: 'ignore' });
    c.on('close', (code) => resolve(code === 0));
    c.on('error', () => resolve(false));
  });
}

/** Use the gateway on the port, or start this build's. Resolves when one answers. */
async function ensureGateway(token: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const next = await settleLocalGateway({ url: URL_BASE, token, version: VERSION, client: 'app', log });
    if (next === 'use') {
      log(`— using the gateway already running on ${URL_BASE} —`);
      return;
    }
    try {
      gateway = await startGateway({ dir: DIR, port: PORT, resourceDir: RESOURCES, quiet: app.isPackaged, onShutdown: onGatewayShutdown, openTerminal });
      log(`— started the gateway in the app (${VERSION}) —`);
      return;
    } catch (err) {
      // Someone else started one in the same moment (the extension, a login entry): use it next round.
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

/**
 * The gateway went away: the app's own was asked to stop by a client (a newer build replacing it, or
 * `deskfish stop`), or the one it attached to stopped (VS Code's, a `deskfish serve`). Whatever takes the
 * port next is used; if nothing answers within 15 s the app starts its own — while the app runs,
 * Deskfish runs, and Quit is how it stops.
 */
let recovering = false;
function recover(): void {
  if (quitting || recovering || gateway) return;
  recovering = true;
  void (async () => {
    try {
      for (let waited = 0; waited < 15_000; waited += 500) {
        await new Promise((r) => setTimeout(r, 500));
        if (quitting || (await probeGateway(URL_BASE, 400))) return;
      }
      if (!quitting) await ensureGateway(ensureToken(DIR));
    } catch (err) {
      log(`✖ could not start the gateway again: ${msg(err)}`);
    } finally {
      recovering = false;
    }
  })();
}

function onGatewayShutdown(): void {
  gateway = undefined;
  log('— the gateway was asked to stop by a client —');
  recover();
}

/* ---------- the window: the page, nothing more ---------- */

const sameOrigin = (url: string) => {
  try {
    const u = new URL(url);
    return u.origin === URL_BASE || (u.protocol === 'blob:' && url.startsWith(`blob:${URL_BASE}/`));
  } catch {
    return false;
  }
};

const openOutside = (url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
};

/** Every web contents (the window, a documentation window): links leave for the browser, nothing navigates away from the gateway. */
function guard(contents: WebContents, ses: Session): void {
  contents.setWindowOpenHandler(({ url }) => {
    // The documentation opens as an empty window the page then fills with a blob of the docs.
    if (url === 'about:blank' || url === '' || sameOrigin(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#181818', webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true } } };
    }
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (sameOrigin(url) || url === 'about:blank') return;
    e.preventDefault();
    openOutside(url);
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

function createWindow(token: string, show: boolean): void {
  // In memory only: the page keeps the token for this run, and on disk it stays in gateway.token alone.
  const ses = session.fromPartition('deskfish-app');
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  app.on('web-contents-created', (_e, contents) => guard(contents, ses));

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'Deskfish',
    backgroundColor: '#181818',
    icon: process.platform === 'linux' ? path.join(ICONS, 'png', '256x256.png') : undefined,
    autoHideMenuBar: true,
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  win.once('ready-to-show', () => show && win?.show());
  win.webContents.on('render-process-gone', (_e, d) => log(`— the page's renderer is gone: ${d.reason} —`));
  win.on('focus', () => knockTitle && setKnockTitle(false));
  win.on('page-title-updated', (e) => knockTitle && e.preventDefault());
  void win.loadURL(`${URL_BASE}/?token=${encodeURIComponent(token)}`);
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------- the tray's client: desktop state, the knock ---------- */

function watch(token: string): void {
  client = new GatewayClient({ url: URL_BASE, token, client: 'app', version: VERSION, log });
  const desktop = (s?: DesktopStatus) => tray?.update({ desktop: s?.state });
  client.on('connected', () => desktop(client?.desktop.current));
  client.on('disconnected', () => {
    tray?.update({ desktop: undefined });
    recover();
  });
  client.desktop.on('change', desktop);
  client.on('event', (e: AgentEvent) => {
    if (e.type === 'needs_user') {
      knocking = true;
      knockPaused = false;
      tray?.update({ knocking });
      if (win?.isVisible() && win.isFocused()) return;
      // The page titles itself only when it knows it is hidden, which a hidden Electron window does not tell it.
      setKnockTitle(true);
      if (!Notification.isSupported()) return log('— she knocked; this system has no notifications (the window title and the tray say it) —');
      const n = new Notification({ title: 'Deskfish needs you', body: e.reason, icon: path.join(ICONS, 'png', '256x256.png') });
      n.on('click', showWindow);
      n.show();
      log('— she knocked: notification shown —');
    } else if (e.type === 'status' && knocking && e.status === 'paused') {
      knockPaused = true;
    } else if (e.type === 'status' && knocking && (e.status !== 'running' || knockPaused)) {
      knocking = false;
      tray?.update({ knocking });
      if (knockTitle) setKnockTitle(false);
    }
  });
  void client.connect();
}

/* ---------- updates: the repository's GitHub Releases, asked before installing ---------- */

function checkForUpdates(): void {
  if (!app.isPackaged) return;
  // An unsigned macOS app cannot replace itself (Squirrel.Mac requires a signature): no check there until the app is signed.
  if (process.platform === 'darwin') return;
  autoUpdater.autoDownload = false;
  // One line per event: the library's own error lines carry the whole HTTP answer, three times over.
  const first = (m: unknown) => (m instanceof Error ? m.message : String(m)).split('\n')[0].slice(0, 300);
  autoUpdater.logger = { info: (m: unknown) => log(`updater: ${first(m)}`), warn: (m: unknown) => log(`updater: ${first(m)}`), error: () => {}, debug: () => {} };
  autoUpdater.on('update-available', async (info) => {
    const r = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Download and install', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      message: `Deskfish ${info.version} is available`,
      detail: `You have ${app.getVersion()}. It downloads from Deskfish's GitHub releases; you choose when to restart.`,
    });
    if (r.response === 0) void autoUpdater.downloadUpdate().catch(() => {});
  });
  autoUpdater.on('update-downloaded', async (info) => {
    const r = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'When I quit'],
      defaultId: 0,
      cancelId: 1,
      message: `Deskfish ${info.version} is ready`,
      detail: 'Restart now to finish the update. A task that is running stops, and she is told about it when the new version starts.',
    });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => log(`updater: ${first(err)}`));
  const check = () => void autoUpdater.checkForUpdates().catch(() => {}); // the error event has said it
  check();
  setInterval(check, 24 * 3600_000).unref();
}

/* ---------- the app ---------- */

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function boot(): Promise<void> {
  const token = ensureToken(DIR);
  loginItem = new LoginItem({ platform: process.platform, execPath: process.execPath, env: process.env, home: os.homedir(), api: app });
  const hidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);

  // macOS needs an application menu for copy and paste in text fields; elsewhere there is none.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);

  tray = new AppTray(path.join(ICONS, 'tray.png'), {
    open: showWindow,
    desktop: (on) => void client?.call(on ? 'desktop.on' : 'desktop.off').catch((err) => log(`desktop ${on ? 'on' : 'off'}: ${msg(err)}`)),
    loginItem: (on) => {
      try {
        log(`— start when I log in: ${on ? 'on' : 'off'} (${loginItem.set(on)}) —`);
      } catch (err) {
        log(`✖ start when I log in: ${msg(err)}`);
      }
      tray?.update({ loginItem: loginItem.isOn() });
    },
    quit: () => app.quit(),
  });
  tray.update({ loginItem: loginItem.isOn() });

  try {
    await ensureGateway(token);
  } catch (err) {
    log(`✖ ${msg(err)}`);
    dialog.showErrorBox('Deskfish could not start', `${msg(err)}\n\nThe log is in ${path.join(DIR, 'logs')}.`);
    quitting = true;
    app.quit();
    return;
  }
  createWindow(token, !hidden);
  watch(token);
  checkForUpdates();
}

if (!app.requestSingleInstanceLock()) {
  // Deskfish is already running: that one shows its window (second-instance), this one leaves.
  app.quit();
} else {
  app.setName('Deskfish');
  if (process.platform === 'win32') app.setAppUserModelId('sh.deskfish.app');
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  // The window hides instead of closing; a documentation window closing must not end the app.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (e) => {
    quitting = true;
    client?.close();
    if (!gateway) return;
    e.preventDefault();
    const g = gateway;
    gateway = undefined;
    log('— quitting: stopping the gateway (the tank keeps running) —');
    void g.stop('the app quit').finally(() => {
      // Seen with Electron 44 on Linux: a quit retried with the (hidden) window still there closed the window
      // and ended at window-all-closed instead of will-quit, and the app stayed. Without a window it quits.
      win?.destroy();
      app.quit();
    });
  });
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err instanceof Error ? err.stack : String(err)}`));
  void app.whenReady().then(boot);
}
