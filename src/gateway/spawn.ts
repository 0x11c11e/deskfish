import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GatewayClient } from './client';
import { decideGateway, isOlderBuild } from './decide';
import { DEFAULT_PORT, type ClientKind } from './protocol';
import { ensureToken, gatewayLogFile, rotateLog } from './storage';

/**
 * Find a running gateway, or start one on this computer: detached (its own session; it writes
 * `logs/gateway.log` itself, and its stderr goes there too), so closing VS Code does not end it. A gateway left running by an older build
 * is replaced when it is idle, and kept (until the next start) while it works on a task (`decide.ts`;
 * the app makes the same decision and starts its gateway in its own process instead).
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
  /** This build's version (`VERSION`); a running gateway of an older build is replaced when idle. */
  version: string;
  log: (line: string) => void;
}

/**
 * Look at port `url` and act on the table in `decide.ts`: 'use' when a gateway answers that should be
 * kept, 'start' when none answers — including after an idle older build was asked to shut down and
 * has stopped. Shared by the extension and the app.
 */
export async function settleLocalGateway(o: { url: string; token: string; version: string; client: ClientKind; log: (line: string) => void }): Promise<'use' | 'start'> {
  const running = await probeGateway(o.url);
  let client: GatewayClient | undefined;
  let busy: boolean | undefined;
  try {
    if (running && isOlderBuild(running.version, o.version)) {
      o.log(`— a gateway of an older build is running (${running.version}; this is ${o.version}) —`);
      client = new GatewayClient({ url: o.url, token: o.token, client: o.client, version: 'replace-check' });
      const snap = await Promise.race([client.connect().catch(() => undefined), sleep(3000).then(() => undefined)]);
      busy = snap?.busy;
    }
    const action = decideGateway(o.version, running && { version: running.version, busy });
    if (action === 'use-busy') o.log(`— the running gateway (${running!.version}) is busy with a task; it is kept, and replaced by this build at the next start —`);
    if (action !== 'replace') return action === 'start' ? 'start' : 'use';
    try {
      await client!.call('shutdown');
    } catch {
      return 'use';
    }
    if (!(await waitFor(async () => !(await probeGateway(o.url, 500)), 10_000))) throw new Error(`the old gateway on ${o.url} did not stop`);
    return 'start';
  } finally {
    client?.close();
  }
}

/** The address and token of a gateway on this computer, started when none is running. */
export async function ensureLocalGateway(o: LocalGatewayOptions): Promise<{ url: string; token: string; started: boolean }> {
  const port = o.port ?? DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;
  const token = ensureToken(o.dataDir);
  if ((await settleLocalGateway({ url, token, version: o.version, client: 'vscode', log: o.log })) === 'use') return { url, token, started: false };
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

/**
 * Start `deskfish serve` detached. `serve` appends its own lines to `logs/gateway.log`, so stdout is
 * not pointed there (every line would land twice); stderr is, so a crash before its logger is up still
 * leaves a trace. `spawnFn` is for the tests.
 */
export function startDetached(o: LocalGatewayOptions, port: number, spawnFn: typeof spawn = spawn): { logFile: string; child: ReturnType<typeof spawn> } {
  const logFile = gatewayLogFile(o.dataDir);
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  rotateLog(logFile);
  const err = fs.openSync(logFile, 'a', 0o600);
  try {
    const child = spawnFn(o.execPath ?? process.execPath, [o.entry, 'serve', '--port', String(port), '--data-dir', o.dataDir], {
      detached: true,
      stdio: ['ignore', 'ignore', err],
      // Inside VS Code, process.execPath is its Electron: this makes it a plain Node (no Node install needed).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: o.dataDir,
      windowsHide: true,
    });
    child.unref();
    return { logFile, child };
  } finally {
    fs.closeSync(err);
  }
}

function readTail(file: string, lines: number): string {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join(' | ');
  } catch {
    return '';
  }
}
