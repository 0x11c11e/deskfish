import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { describeAction } from '../computer/types';
import type { AgentEvent } from '../agent/loop';
import { GatewayClient } from './client';
import { DEFAULT_PORT } from './protocol';
import { probeGateway } from './spawn';
import { startGateway, type StartedGateway } from './start';
import { dataDir, readToken } from './storage';
import { VERSION } from './version';

/**
 * `deskfish serve [--data-dir DIR] [--port N] [--host H] [--allow-remote]` runs the gateway;
 * `deskfish status`, `deskfish run "task"` and `deskfish stop` talk to a running one on this
 * computer. Built twice: `dist/cli.js` (the `deskfish` command) and `dist/gateway.js` (what the
 * extension starts). No `vscode` import.
 */

const USAGE = `Usage:
  deskfish serve [--data-dir DIR] [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--allow-remote]
  deskfish status [--data-dir DIR] [--port N]
  deskfish run "task" [--data-dir DIR] [--port N]
  deskfish stop [--data-dir DIR] [--port N]      stops the gateway (the desktop keeps running)`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: { 'data-dir': { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, 'allow-remote': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    }));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  if (!cmd || values.help || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  const dir = typeof values['data-dir'] === 'string' ? path.resolve(values['data-dir']) : dataDir();
  const port = typeof values.port === 'string' ? Number(values.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`bad port: ${values.port}`);
    return 2;
  }
  switch (cmd) {
    case 'serve':
      return serve({ dir, port, host: typeof values.host === 'string' ? values.host : '127.0.0.1', allowRemote: !!values['allow-remote'] });
    case 'status':
      return status(dir, port);
    case 'run':
      if (!positionals.length) {
        console.error(`deskfish run needs a task\n\n${USAGE}`);
        return 2;
      }
      return runTask(dir, port, positionals.join(' '));
    case 'stop':
      return stopGateway(dir, port);
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

/* ---------- serve ---------- */

/** `startGateway` (the app starts the same one in its own process), plus what a command-line process needs: signals and an exit. */
async function serve(o: { dir: string; port: number; host: string; allowRemote: boolean }): Promise<number> {
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  let gateway: StartedGateway;
  try {
    gateway = await startGateway({ ...o, resourceDir: path.resolve(__dirname, '..'), onShutdown: () => process.exit(0) });
  } catch {
    return 1; // already in the log: the data dir is locked by a live gateway, or the port could not be bound
  }
  const exit = (why: string) => void gateway.stop(why).then(() => process.exit(0));
  process.on('SIGINT', () => exit('SIGINT'));
  process.on('SIGTERM', () => exit('SIGTERM'));
  process.on('SIGHUP', () => {});
  process.on('unhandledRejection', (err) => gateway.log(`unhandled rejection: ${err instanceof Error ? err.stack : String(err)}`));
  return new Promise<number>(() => {}); // runs until shutdown
}

/* ---------- the client commands ---------- */

async function connect(dir: string, port: number): Promise<GatewayClient | undefined> {
  const url = `http://127.0.0.1:${port}`;
  if (!(await probeGateway(url))) {
    console.error(`No Deskfish gateway is running on ${url}. Start one with: deskfish serve`);
    return undefined;
  }
  const token = readToken(dir);
  if (!token) {
    console.error(`No gateway token in ${dir} (is --data-dir right?)`);
    return undefined;
  }
  const client = new GatewayClient({ url, token, client: 'cli', version: VERSION });
  let refused = false;
  client.once('unauthorized', () => (refused = true));
  const snap = await Promise.race([client.connect(), new Promise<undefined>((r) => setTimeout(r, 5000))]);
  if (!snap) {
    client.close();
    console.error(refused ? `The gateway on ${url} refused the token in ${dir}.` : `The gateway on ${url} did not answer.`);
    return undefined;
  }
  return client;
}

async function status(dir: string, port: number): Promise<number> {
  const client = await connect(dir, port);
  if (!client) return 1;
  const s = client.snapshot!;
  console.log(`Deskfish gateway ${s.version} on ${client.url}`);
  console.log(`  data:    ${s.dataDir}`);
  console.log(`  model:   ${s.config.model} (${s.config.provider})${s.keys.length ? '' : ', no API key'}`);
  console.log(`  desktop: ${s.desktop.status.state}${s.desktop.status.message ? ` — ${s.desktop.status.message}` : ''}`);
  console.log(`  agent:   ${s.status}${s.statusMessage ? ` — ${s.statusMessage}` : ''}${s.queued ? `, ${s.queued} queued` : ''}`);
  console.log(`  web:     ${client.url}/ — sign in with the token in ${path.join(dir, 'gateway.token')}`);
  client.close();
  return 0;
}

async function runTask(dir: string, port: number, task: string): Promise<number> {
  const client = await connect(dir, port);
  if (!client) return 1;
  return new Promise<number>((resolve) => {
    let started = false;
    const finish = (code: number) => {
      client.close();
      resolve(code);
    };
    client.on('task', (t: { text: string }) => {
      if (t.text.includes(task)) started = true;
    });
    client.on('notice', (n: { text: string }) => console.log(`· ${n.text}`));
    client.on('event', (e: AgentEvent) => {
      if (!started) return;
      if (e.type === 'assistant') console.log(e.text);
      else if (e.type === 'action') console.log(`  #${e.step} ${describeAction(e.action)}${e.result.ok ? '' : ` — ${e.result.error ?? 'failed'}`}`);
      else if (e.type === 'needs_user') console.log(`✋ She needs you: ${e.reason} (open the Desktop tab, then resume)`);
      else if (e.type === 'status' && (e.status === 'done' || e.status === 'stopped' || e.status === 'error')) {
        console.log(`● ${e.status}${e.message ? ` — ${e.message}` : ''}`);
        finish(e.status === 'done' ? 0 : 1);
      }
    });
    client.on('disconnected', () => {
      console.error('The gateway connection closed.');
      finish(1);
    });
    process.on('SIGINT', () => {
      console.log('\nDetached. The task keeps running in the gateway; `deskfish status` shows it.');
      finish(130);
    });
    client.run(task).catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      finish(1);
    });
  });
}

async function stopGateway(dir: string, port: number): Promise<number> {
  const client = await connect(dir, port);
  if (!client) return 1;
  await client.call('shutdown').catch(() => null);
  client.close();
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50 && (await probeGateway(url, 300)); i++) await new Promise((r) => setTimeout(r, 100));
  console.log('The gateway stopped. The desktop keeps running; turn it off from a client when you want it gone.');
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  },
);
