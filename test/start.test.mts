// Gateway step 7, decision 1: `startGateway` is the one code path for `deskfish serve` and the app.
//
// Started on port 0 in a temp data dir (a mock daemon that answers as a running tank, so no container
// engine is ever asked to start anything; a fake model whose reply is held): the lock names this
// process and the real port, a second start on the same dir is refused and leaves the lock alone, a
// stale lock is taken, a GatewayClient talks to it, Stop while a task is in flight removes the lock
// and keeps `state.json` for the next start, and stop is idempotent. A client's `shutdown` stops it
// and calls `onShutdown` (the process is never exited). `desktop.install` opens a terminal only where
// the host gave one and a runtime is missing. `settleLocalGateway` against the real thing: the same
// build is used; an idle older one is asked to stop and is gone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { WebSocket, WebSocketServer } from 'ws';
import { detectRuntime } from '../src/desktop/runtime';
import { GatewayClient } from '../src/gateway/client';
import type { DeskfishConfig } from '../src/gateway/config';
import { probeGateway, settleLocalGateway } from '../src/gateway/spawn';
import { startGateway } from '../src/gateway/start';
import { readState } from '../src/gateway/state';
import { VERSION } from '../src/gateway/version';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(25);
  }
}

// A daemon that answers as a running tank.
const png = PNG.sync.write(new PNG({ width: 320, height: 200 })).toString('base64');
const daemon = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200); res.end('mock daemon'); return; }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const reply = (r: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); };
    if (body.action === 'screenshot') return reply({ success: true, data: { image: png } });
    if (body.action === 'cursor_position') return reply({ success: true, data: { x: 1, y: 1 } });
    if (body.action === 'list_files') return reply({ success: true, data: { entries: [] } });
    return reply({ success: true, data: {} });
  });
});
await new Promise<void>((r) => daemon.listen(0, '127.0.0.1', r));
const daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;

// A websockify that echoes: the live view's pipe through the gateway.
const vncHttp = http.createServer();
const vncWss = new WebSocketServer({ server: vncHttp, path: '/websockify', handleProtocols: (p) => (p.has('binary') ? 'binary' : false) });
vncWss.on('connection', (ws) => ws.on('message', (d) => ws.send(d)));
await new Promise<void>((r) => vncHttp.listen(0, '127.0.0.1', r));
const vncUrl = `ws://127.0.0.1:${(vncHttp.address() as AddressInfo).port}/websockify`;

// A model that never answers until released.
let asked = 0;
let release = () => {};
const held = new Promise<void>((r) => (release = r));
const model = http.createServer((req, res) => {
  req.resume();
  req.on('end', async () => {
    asked++;
    await held;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'All done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;

const config: Partial<DeskfishConfig> = {
  provider: 'openai-compatible', model: 'model-a', baseUrl, daemonUrl, vncUrl, autoStart: false, settleMs: 0, screenshotWidth: 320,
  // docker, not auto: nothing here may ask the user's podman about her tank.
  containerCli: 'docker', reflectEvery: 0,
};
const newDir = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `deskfish-start-${tag}-`));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify(config));
  return d;
};
const pid = (dir: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'gateway.pid'), 'utf8')); } catch { return undefined; } };
const dirs: string[] = [];
const lines: string[] = [];

try {
  // ---------- start, the lock, a client ----------
  const dir = newDir('a');
  dirs.push(dir);
  const g = await startGateway({ dir, port: 0, resourceDir: ROOT, quiet: true, onLog: (l) => lines.push(l) });
  ok(g.port > 0 && g.url === `http://127.0.0.1:${g.port}`, `listening on a real port (${g.url})`);
  ok(pid(dir)?.pid === process.pid && pid(dir)?.port === g.port, `the lock names this process and the real port (${JSON.stringify(pid(dir))})`);
  ok(fs.readFileSync(path.join(dir, 'gateway.token'), 'utf8').trim() === g.token && (fs.statSync(path.join(dir, 'gateway.token')).mode & 0o777) === 0o600, 'the token is gateway.token, 0600');
  ok((await probeGateway(g.url))?.version === VERSION, '/status answers with this build');
  ok(lines.some((l) => l.startsWith('● Deskfish gateway') && l.includes(dir)) && fs.readFileSync(path.join(dir, 'logs', 'gateway.log'), 'utf8').includes('● Deskfish gateway'), 'the start line is in onLog and in logs/gateway.log');

  // Another process holding the lock: this process's pid stands in for "live", on the port that answers.
  const dir2 = newDir('b');
  dirs.push(dir2);
  fs.writeFileSync(path.join(dir2, 'gateway.pid'), JSON.stringify({ pid: process.ppid, port: g.port }));
  await assert.rejects(startGateway({ dir: dir2, port: 0, resourceDir: ROOT, quiet: true }), /already runs/);
  n++;
  ok(pid(dir2)?.pid === process.ppid, 'a refused start leaves the other gateway’s lock as it was');
  ok(!fs.existsSync(path.join(dir2, 'memory.md')) && !fs.existsSync(path.join(dir2, 'self.md')), 'and touches none of her files');
  // A stale lock (no such process) is taken.
  fs.writeFileSync(path.join(dir2, 'gateway.pid'), JSON.stringify({ pid: 2 ** 22 + 12345, port: 1 }));
  const g2 = await startGateway({ dir: dir2, port: 0, resourceDir: ROOT, quiet: true });
  ok(pid(dir2)?.pid === process.pid, 'a stale lock is taken');

  const client = new GatewayClient({ url: g.url, token: g.token, client: 'app', version: 'test' });
  const snap = await client.connect();
  ok(snap.dataDir === dir && snap.config.model === 'model-a', 'a client (as the app) gets the snapshot of this data dir and its config.json');

  // desktop.install: only a host that gave a terminal opens one, and only when a runtime is missing.
  ok((await client.call('desktop.install')) === false, 'desktop.install without a terminal answers false');
  const opened: string[] = [];
  const dir3 = newDir('c');
  dirs.push(dir3);
  const g3 = await startGateway({ dir: dir3, port: 0, resourceDir: ROOT, quiet: true, openTerminal: (c) => void opened.push(c) });
  const c3 = new GatewayClient({ url: g3.url, token: g3.token, client: 'web', version: 'test' });
  await c3.connect();
  const rt = await detectRuntime('docker');
  const expected = rt.cli === 'none' && !!rt.install.command;
  const answer = await c3.call('desktop.install');
  ok(answer === expected && (expected ? opened.length === 1 && opened[0] === (rt.cli === 'none' ? rt.install.command : '') : opened.length === 0), `desktop.install opens the plan's own command when docker is missing (${expected ? 'missing here' : 'present here'}; answered ${answer})`);
  c3.close();

  // ---------- Stop with a task in flight ----------
  await client.run('Check the weather in Munich');
  await until(() => asked > 0 && !!readState(dir), 'the run reaching the model and state.json');
  // The live view open through /vnc while it stops (the app's window, VS Code's Desktop tab).
  const vnc = new WebSocket(client.vncUrl(), ['binary']);
  const echo = new Promise<Buffer>((r, j) => { vnc.on('message', (d) => r(d as Buffer)); vnc.on('error', j); });
  await new Promise((r, j) => { vnc.on('open', r); vnc.on('error', j); });
  vnc.send(Buffer.from([1, 2, 3]), { binary: true });
  ok((await echo).length === 3, 'a live view is open through /vnc');
  const vncClosed = new Promise<void>((r) => vnc.on('close', () => r()));
  const stopped = await Promise.race([g.stop('the test').then(() => 'stopped'), sleep(5000).then(() => 'hung')]);
  ok(stopped === 'stopped', `stop finishes with a live view open (${stopped}; before the fix the /vnc pipe kept it waiting forever)`);
  await vncClosed;
  n++;
  ok(!fs.existsSync(path.join(dir, 'gateway.pid')), 'stop removes the lock');
  const kept = readState(dir);
  ok(kept?.task === 'Check the weather in Munich', `state.json of the task in flight is kept for the next start (${kept?.task})`);
  ok(!(await probeGateway(g.url, 500)), 'nothing answers on the port after stop');
  await g.stop('again');
  ok(lines.filter((l) => l.startsWith('■ gateway stopping')).length === 1, 'stop is idempotent (one stopping line)');
  client.close();
  release();

  // ---------- a client's shutdown ----------
  let shutdownCalls = 0;
  const dir4 = newDir('d');
  dirs.push(dir4);
  const g4 = await startGateway({ dir: dir4, port: 0, resourceDir: ROOT, quiet: true, onShutdown: () => shutdownCalls++ });
  const c4 = new GatewayClient({ url: g4.url, token: g4.token, client: 'cli', version: 'test' });
  await c4.connect();
  await c4.call('shutdown');
  c4.close();
  await until(() => shutdownCalls === 1, 'onShutdown after a client asked');
  ok(!fs.existsSync(path.join(dir4, 'gateway.pid')) && !(await probeGateway(g4.url, 500)), 'a client’s shutdown stops the gateway and removes the lock; the process goes on');

  // ---------- settleLocalGateway against a real gateway ----------
  const dir5 = newDir('e');
  dirs.push(dir5);
  const g5 = await startGateway({ dir: dir5, port: 0, resourceDir: ROOT, quiet: true });
  const settleLog: string[] = [];
  ok((await settleLocalGateway({ url: g5.url, token: g5.token, version: VERSION, client: 'app', log: (l) => settleLog.push(l) })) === 'use', 'the same build answering → use');
  ok((await settleLocalGateway({ url: g5.url, token: g5.token, version: '0.0.0+0', client: 'app', log: () => {} })) === 'use', 'a build whose order against this one cannot be read (+dev) → use, never shut down');
  ok((await settleLocalGateway({ url: 'http://127.0.0.1:1', token: 'x', version: VERSION, client: 'app', log: () => {} })) === 'start', 'nothing answering → start');
  ok((await settleLocalGateway({ url: g5.url, token: g5.token, version: '99.0.0+zz', client: 'app', log: (l) => settleLog.push(l) })) === 'start', 'a newer build asking of an idle gateway → it is asked to stop, then start');
  ok(!(await probeGateway(g5.url, 500)) && !fs.existsSync(path.join(dir5, 'gateway.pid')) && settleLog.some((l) => l.includes('older build')), 'the older gateway is gone and its lock with it');
  await g2.stop('end');
  await g3.stop('end');
} finally {
  release();
  daemon.close();
  model.close();
  vncWss.close();
  vncHttp.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`start: ${n} checks passed`);
process.exit(0);
