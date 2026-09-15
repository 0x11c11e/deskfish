import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GatewayClient } from './client';
import { DEFAULT_PORT } from './protocol';
import { ensureToken } from './storage';

/**
 * Find a running gateway, or start one on this computer: detached (its own session, stdio to
 * `logs/gateway.log`), so closing VS Code does not end it. A gateway left running by an older build
 * is replaced when it is idle, and kept (until the next start) while it works on a task.
 * No `vscode` import.
 */

export interface GatewayStatus {
  name: 'deskfish';
  version: string;
}

/** `GET /status` (no token): a Deskfish gateway answers with its name and version. */
export async function probeGateway(url: string, timeoutMs = 1500): Promise<GatewayStatus | undefined> {
  try {
    const res = await fetch(new URL('/status', url), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Partial<GatewayStatus>;
    return body?.name === 'deskfish' && typeof body.version === 'string' ? (body as GatewayStatus) : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, stop?: () => boolean): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return true;
    if (stop?.()) return false;
    await sleep(200);
  }
  return false;
}

export interface LocalGatewayOptions {
  dataDir: string;
  port?: number;
  /** The gateway's entry: `<extension>/dist/gateway.js`. */
  entry: string;
  /** The runtime: VS Code's own (`process.execPath`, run as Node) or `node`. */
  execPath?: string;
  /** This build's version (`VERSION`); a running gateway with another one is replaced when idle. */
  version: string;
  log: (line: string) => void;
}

/** Ask an older gateway to stop if it is idle. Resolves true when it was asked to stop. */
async function replaceIfIdle(url: string, token: string, log: (line: string) => void): Promise<boolean> {
  const client = new GatewayClient({ url, token, client: 'vscode', version: 'replace-check' });
  try {
    const snap = await Promise.race([client.connect(), sleep(3000).then(() => undefined)]);
    if (!snap) return false;
    if (snap.busy) {
      log(`— the running gateway (${snap.version}) is busy with a task; it is kept, and replaced by this build at the next start —`);
      return false;
    }
    await client.call('shutdown');
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

/** The address and token of a gateway on this computer, started when none is running. */
export async function ensureLocalGateway(o: LocalGatewayOptions): Promise<{ url: string; token: string; started: boolean }> {
  const port = o.port ?? DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;
  const token = ensureToken(o.dataDir);
  const running = await probeGateway(url);
  if (running) {
    if (running.version === o.version) return { url, token, started: false };
    o.log(`— a gateway of another build is running (${running.version}; this is ${o.version}) —`);
    if (!(await replaceIfIdle(url, token, o.log))) return { url, token, started: false };
    if (!(await waitFor(async () => !(await probeGateway(url, 500)), 10_000))) throw new Error(`the old gateway on port ${port} did not stop`);
  }
  const { logFile, child } = startDetached(o, port);
  let exited: number | null | undefined;
  child.once('exit', (code) => (exited = code));
  // Two windows starting at once both spawn; the loser exits (port taken, data dir locked) and the winner answers.
  const up = (await waitFor(async () => !!(await probeGateway(url, 500)), 30_000, () => exited !== undefined)) || !!(await sleep(1000).then(() => probeGateway(url, 1000)));
  if (!up) {
    const tail = readTail(logFile, 6);
    throw new Error(`the gateway did not start${exited !== undefined ? ` (exit ${exited})` : ''}${tail ? `: ${tail}` : ''} — see ${logFile}`);
  }
  o.log(`— started the gateway on ${url} (log: ${logFile}) —`);
  return { url, token, started: true };
}

function startDetached(o: LocalGatewayOptions, port: number): { logFile: string; child: ReturnType<typeof spawn> } {
  const logs = path.join(o.dataDir, 'logs');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const logFile = path.join(logs, 'gateway.log');
  try {
    if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    /* no log yet */
  }
  const out = fs.openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(o.execPath ?? process.execPath, [o.entry, 'serve', '--port', String(port), '--data-dir', o.dataDir], {
      detached: true,
      stdio: ['ignore', out, out],
      // Inside VS Code, process.execPath is its Electron: this makes it a plain Node (no Node install needed).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: o.dataDir,
      windowsHide: true,
    });
    child.unref();
    return { logFile, child };
  } finally {
    fs.closeSync(out);
  }
}

function readTail(file: string, lines: number): string {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join(' | ');
  } catch {
    return '';
  }
}
