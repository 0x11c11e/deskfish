import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyConfigPatch, DEFAULT_CONFIG, type DeskfishConfig } from './config';
import { DEFAULT_PORT } from './protocol';
import { GatewayServer } from './server';
import { DeskfishService } from './service';
import { probeGateway } from './spawn';
import { LogFile, ensureToken, gatewayLogFile, writePrivate } from './storage';
import { VERSION } from './version';

/**
 * Start the gateway in this process: the one code path for `deskfish serve` (which adds the signal
 * handlers and exits when it stops) and for the app (which runs it in Electron's main process and
 * awaits `stop` on Quit). It never exits the process; a data dir locked by a live gateway is an error.
 * No `vscode` import.
 */

export interface StartOptions {
  /** The data dir: her files, config.json, secrets.json, gateway.token, gateway.pid, logs/. */
  dir: string;
  port?: number;
  host?: string;
  allowRemote?: boolean;
  /**
   * The Deskfish folder: `package.json` (the settings schema), `docker/desktop` (the tank's recipe),
   * `library/`, `docs/`, and the web page's `web/`, `media/`, `dist/`. `serve` passes its own folder,
   * the app its resources.
   */
  resourceDir: string;
  /** Every log line, after it was written to `logs/gateway.log` (and stdout, unless `quiet`). */
  onLog?: (line: string) => void;
  /** Do not echo log lines to stdout (the app has no terminal). */
  quiet?: boolean;
  /** A client asked the gateway to shut down; called after it stopped. */
  onShutdown?: () => void;
  /** Gives the gateway a visible terminal for `desktop.install` (the app). */
  openTerminal?: (command: string) => void | Promise<void>;
}

export interface StartedGateway {
  port: number;
  url: string;
  token: string;
  /** Write a line to the gateway's log (the host's own lines: an unhandled rejection, the app's updater). */
  log(line: string): void;
  /** Stop the gateway (the tank keeps running; `state.json` of a task in flight stays for the next start). Idempotent. */
  stop(why: string): Promise<void>;
}

/** The saved config over the defaults; `saved` is false when there is no readable `config.json` (a client seeds it). */
export function loadConfig(file: string, log: (line: string) => void): { cfg: DeskfishConfig; saved: boolean } {
  let cfg = DEFAULT_CONFIG;
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { cfg, saved: false };
  }
  for (const [k, v] of Object.entries(saved)) {
    try {
      cfg = applyConfigPatch(cfg, { [k]: v });
    } catch {
      log(`config.json: ignored ${k}`);
    }
  }
  return { cfg, saved: true };
}

const pidFile = (dir: string) => path.join(dir, 'gateway.pid');

/** The data dir's lock: one gateway per data dir, so exactly one process writes her files. Undefined when taken. */
async function takeLock(dir: string, port: number): Promise<string | undefined> {
  try {
    const held = JSON.parse(fs.readFileSync(pidFile(dir), 'utf8')) as { pid: number; port: number };
    if (held.pid !== process.pid) {
      process.kill(held.pid, 0); // throws when no such process
      // The pid may belong to something else now; a gateway that answers is the real test.
      if (await probeGateway(`http://127.0.0.1:${held.port}`)) return `a gateway already runs on ${dir} (pid ${held.pid}, port ${held.port})`;
    }
  } catch {
    /* no lock, or a stale one */
  }
  writePrivate(pidFile(dir), JSON.stringify({ pid: process.pid, port }) + '\n');
  return undefined;
}

function releaseLock(dir: string): void {
  try {
    const held = JSON.parse(fs.readFileSync(pidFile(dir), 'utf8')) as { pid: number };
    if (held.pid === process.pid) fs.rmSync(pidFile(dir));
  } catch {
    /* gone */
  }
}

export async function startGateway(o: StartOptions): Promise<StartedGateway> {
  const host = o.host ?? '127.0.0.1';
  fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const ring: string[] = [];
  let server: GatewayServer | undefined;
  // Its own log file, whoever started it (VS Code, the login entry, a terminal, the app).
  const logFile = new LogFile(gatewayLogFile(o.dir));
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    if (!o.quiet) process.stdout.write(stamped);
    logFile.append(stamped);
    ring.push(line);
    if (ring.length > 5000) ring.splice(0, 1000);
    server?.logLine(line);
    o.onLog?.(line);
  };
  const locked = await takeLock(o.dir, o.port ?? DEFAULT_PORT);
  if (locked) {
    log(`✖ ${locked}`);
    throw new Error(locked);
  }
  const configFile = path.join(o.dir, 'config.json');
  const loaded = loadConfig(configFile, log);
  const service = new DeskfishService({ dataDir: o.dir, resourceDir: o.resourceDir, config: loaded.cfg, configSaved: loaded.saved, log });
  service.init();
  // The one source of truth for settings: every client's change lands here, and every client mirrors it.
  service.on('config', (cfg: DeskfishConfig) => writePrivate(configFile, JSON.stringify(cfg, null, 1) + '\n'));

  let stopping: Promise<void> | undefined;
  const stop = (why: string): Promise<void> =>
    (stopping ??= (async () => {
      log(`■ gateway stopping (${why})`);
      await server?.close();
      service.dispose();
      releaseLock(o.dir);
    })());

  const token = ensureToken(o.dir);
  server = new GatewayServer({
    service,
    token,
    host,
    port: o.port ?? DEFAULT_PORT,
    allowRemote: o.allowRemote,
    log,
    logTail: (n) => ring.slice(-n),
    onShutdown: () => void stop('asked by a client').then(() => o.onShutdown?.()),
    openTerminal: o.openTerminal,
    webRoot: o.resourceDir,
  });
  let port: number;
  try {
    port = await server.listen();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(`✖ ${why}`);
    service.dispose();
    releaseLock(o.dir);
    throw err;
  }
  if (port !== o.port) writePrivate(pidFile(o.dir), JSON.stringify({ pid: process.pid, port }) + '\n'); // port 0: the lock names the real one
  const shown = host.includes(':') ? `[${host}]` : host;
  log(`● Deskfish gateway ${VERSION} on http://${shown}:${port} — data: ${o.dir}`);
  return { port, url: `http://${shown}:${port}`, token, log, stop };
}
