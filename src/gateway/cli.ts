import * as path from 'node:path';
import * as readline from 'node:readline';
import { parseArgs } from 'node:util';
import { describeAction } from '../computer/types';
import type { AgentEvent } from '../agent/loop';
import { register } from '../remote/channel';
import { GatewayClient } from './client';
import { DEFAULT_PORT, type ClientKind } from './protocol';
import type { RemoteStatus } from './uplink';
import { probeGateway } from './spawn';
import { startGateway, type StartedGateway } from './start';
import { dataDir, readToken } from './storage';
import { VERSION } from './version';

/**
 * `deskfish serve [--data-dir DIR] [--port N] [--host H] [--allow-remote]` runs the gateway;
 * `deskfish status`, `deskfish run "task"`, `deskfish stop` and `deskfish mcp` talk to a running
 * one. Built twice: `dist/cli.js` (the `deskfish` command) and `dist/gateway.js` (what the
 * extension starts). No `vscode` import.
 */

const USAGE = `Usage:
  deskfish serve [--data-dir DIR] [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--allow-remote]
  deskfish status [--data-dir DIR] [--port N]
  deskfish run "task" [--data-dir DIR] [--port N]
  deskfish stop [--data-dir DIR] [--port N]      stops the gateway (the desktop keeps running)
  deskfish mcp [--data-dir DIR] [--port N] [--url http://host:port]
                                                 an MCP server on stdio for a coding agent
                                                 (--url takes the token from DESKFISH_GATEWAY_TOKEN)

  deskfish remote enroll --relay wss://relay.example.com --username NAME --code CODE
  deskfish remote password                       set the password the sign-in page asks for
  deskfish remote status                         is she reachable, and from where
  deskfish remote off [--forget]                 stop dialling out (--forget drops the keys too)
                                                 reaching her from any browser through a relay;
                                                 your computer still opens no port`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: {
        'data-dir': { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        'allow-remote': { type: 'boolean' },
        url: { type: 'string' },
        relay: { type: 'string' },
        username: { type: 'string' },
        code: { type: 'string' },
        forget: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
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
    case 'mcp':
      return mcp(dir, port, typeof values.url === 'string' ? values.url : undefined);
    case 'remote':
      return remote(dir, port, positionals[0] ?? 'status', {
        relay: typeof values.relay === 'string' ? values.relay : undefined,
        username: typeof values.username === 'string' ? values.username : undefined,
        code: typeof values.code === 'string' ? values.code : undefined,
        forget: !!values.forget,
      });
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

async function connect(dir: string, port: number, o: { kind?: ClientKind; url?: string; token?: string; timeoutMs?: number } = {}): Promise<GatewayClient | undefined> {
  const url = o.url ?? `http://127.0.0.1:${port}`;
  if (!(await probeGateway(url, o.timeoutMs))) {
    console.error(`No Deskfish gateway is running on ${url}. Start one with: deskfish serve`);
    return undefined;
  }
  const token = o.token ?? readToken(dir);
  if (!token) {
    console.error(`No gateway token in ${dir} (is --data-dir right?)`);
    return undefined;
  }
  const client = new GatewayClient({ url, token, client: o.kind ?? 'cli', version: VERSION });
  let refused = false;
  client.once('unauthorized', () => (refused = true));
  const snap = await Promise.race([client.connect(), new Promise<undefined>((r) => setTimeout(r, o.timeoutMs ?? 5000))]);
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
      else if (e.type === 'action') console.log(`  #${e.step} ${e.describe ?? describeAction(e.action)}${e.result.ok ? '' : ` — ${e.result.error ?? 'failed'}`}`);
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

/**
 * `deskfish mcp`: the MCP door on stdio (see `mcp.ts`). It finds a gateway the way `status` does, or
 * takes `--url` plus `DESKFISH_GATEWAY_TOKEN` for one on another machine. It never starts a gateway —
 * the app, the extension and `serve` do that — and it says so and exits within two seconds when none
 * answers, because an MCP client hangs on a server that neither speaks nor exits. Nothing but the
 * protocol may reach stdout.
 */
async function mcp(dir: string, port: number, url?: string): Promise<number> {
  const token = url ? (process.env.DESKFISH_GATEWAY_TOKEN ?? '').trim() : undefined;
  if (url && !token) {
    console.error('deskfish mcp --url needs the gateway token in DESKFISH_GATEWAY_TOKEN');
    return 1;
  }
  const client = await connect(dir, port, { kind: 'mcp', url, token, timeoutMs: 1500 });
  if (!client) {
    console.error('Start Deskfish first: open it in VS Code or the app, or run `deskfish serve`.');
    return 1;
  }
  const { serveMcp } = await import('./mcp');
  console.error(`deskfish mcp: connected to ${client.url} (${client.snapshot?.version ?? '?'})`);
  await serveMcp(client);
  client.close();
  return 0;
}

/* ---------- remote access (13-relay-plan.md) ---------- */

/** Ask for something nobody should see typed. Falls back to a visible prompt where there is no TTY. */
function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const muted = { on: false };
    // `_writeToOutput` is readline's own hook for exactly this; the prompt is written once, the answer never.
    (rl as unknown as { _writeToOutput(s: string): void })._writeToOutput = function (text: string) {
      if (!muted.on || text.includes(question)) process.stdout.write(text);
    };
    rl.question(question, (answer) => {
      muted.on = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    muted.on = true;
  });
}

/** One line a person can act on: where she is reachable, or what is still missing. */
function printRemote(r: RemoteStatus, dir: string): void {
  if (!r.relay) {
    console.log('Remote access is off. Turn it on with: deskfish remote enroll --relay wss://… --username NAME --code CODE');
    if (r.enrolled || r.hasPassword) console.log(`  (the keys are still in ${path.join(dir, 'secrets.json')}; "deskfish remote off --forget" drops them)`);
    return;
  }
  console.log(`Remote access: ${r.username} at ${r.relay}`);
  console.log(`  enrolled: ${r.enrolled ? 'yes' : 'no — run deskfish remote enroll'}`);
  console.log(`  password: ${r.hasPassword ? 'set' : 'not set — run deskfish remote password'}`);
  const since = r.since ? ` since ${new Date(r.since).toLocaleString()}` : '';
  console.log(`  uplink:   ${r.state}${r.state === 'connected' ? ` (${r.clients} browser${r.clients === 1 ? '' : 's'})` : ''}${since}`);
  if (r.lastError) console.log(`  last:     ${r.lastError}`);
}

/**
 * `deskfish remote …` runs against the gateway that owns this data folder, the way `status`, `run`
 * and `stop` do — one process writes `config.json` and `secrets.json`, which is her requirement 1.
 * The password is the exception that proves the rule: it is turned into an OPAQUE record *here*,
 * where it was typed, and only the record crosses even this loopback socket.
 */
async function remote(dir: string, port: number, what: string, o: { relay?: string; username?: string; code?: string; forget: boolean }): Promise<number> {
  if (!['enroll', 'password', 'status', 'off'].includes(what)) {
    console.error(`unknown: deskfish remote ${what}\n\n${USAGE}`);
    return 2;
  }
  if (what === 'enroll' && (!o.relay || !o.username || !o.code)) {
    console.error('deskfish remote enroll needs --relay, --username and --code (the person who runs the relay mints the code)');
    return 2;
  }
  const client = await connect(dir, port);
  if (!client) return 1;
  try {
    if (what === 'status') {
      printRemote(await client.call('remote.status'), dir);
      return 0;
    }
    if (what === 'off') {
      printRemote(await client.call('remote.off', { forget: o.forget }), dir);
      return 0;
    }
    if (what === 'enroll') {
      const r = await client.call('remote.enroll', { relay: o.relay!, username: o.username!, code: o.code! });
      printRemote(r, dir);
      if (!r.hasPassword) console.log('\nNow set the password the sign-in page will ask for: deskfish remote password');
      return 0;
    }
    const username = (await client.call('remote.status')).username;
    if (!username) {
      console.error('Enrol first: deskfish remote enroll --relay wss://… --username NAME --code CODE');
      return 1;
    }
    const password = await askSecret(`A password for reaching ${username} from a browser: `);
    if (password.length < 8) {
      console.error('That is shorter than eight characters. Nothing was changed.');
      return 1;
    }
    if ((await askSecret('And again: ')) !== password) {
      console.error('Those two are not the same. Nothing was changed.');
      return 1;
    }
    // Both OPAQUE roles, here, in this process: what leaves is a record nobody can read backwards.
    const made = await register(username, password);
    printRemote(await client.call('remote.password', { serverSetup: made.serverSetup, record: made.record }), dir);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    client.close();
  }
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
