// The service (src/gateway/service.ts), the owner the extension delegates to: no VS Code, a data
// dir of its own, a mock daemon and a fake OpenAI-compatible model server in-process. A task runs and
// its events arrive in order; a second run while one is busy waits in the one queue and starts after
// (never two model calls at once); a message said during a reflection is held and started after it;
// Stop drops what is queued; a due schedule seen while busy fires after the task; the Downloads
// watcher's event comes out of the service; setConfig with a new model leaves a running task's
// runner alone and the next run gets a new one; two runs submitted while the tank is still turning on
// start one after the other, and Stop in that window keeps the task from starting. Nothing here
// touches podman or the real desktop.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { DeskfishService } from '../src/gateway/service';
import type { DeskfishConfig } from '../src/gateway/config';
import { newSelfKey } from '../src/agent/self';
import type { AgentEvent } from '../src/agent/loop';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}

// ---------- mock daemon ----------
const png = PNG.sync.write(new PNG({ width: 320, height: 200 })).toString('base64');
const downloads: { name: string; size: number; mtime: number; dir: boolean }[] = [];
const daemon = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200); res.end('mock daemon'); return; }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const reply = (r: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); };
    switch (body.action) {
      case 'screenshot': return reply({ success: true, data: { image: png } });
      case 'cursor_position': return reply({ success: true, data: { x: 1, y: 1 } });
      case 'list_files': return reply({ success: true, data: { entries: downloads } });
      case 'release_input': return reply({ success: true, data: { released: [], blind: false } });
      case 'input_state': return reply({ success: true, data: { keys: [], buttons: [] } });
      default: return reply({ success: true });
    }
  });
});
await new Promise<void>((r) => daemon.listen(0, '127.0.0.1', r));
const daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;

// ---------- fake model ----------
type Req = { model: string; text: string };
const requests: Req[] = [];
let inflight = 0;
let maxInflight = 0;
let gate: Promise<void> | undefined;
let openGate = () => {};
const closeGate = () => { gate = new Promise<void>((r) => (openGate = () => { gate = undefined; r(); })); };
/** When set, the next reply is one `wait` tool call (a second model turn follows); otherwise text only (done). */
let nextWaits = 0;
const model = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const body = JSON.parse(raw);
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    requests.push({ model: body.model, text: JSON.stringify(body.messages) });
    try {
      if (gate) await gate;
      const message = nextWaits > 0
        ? (nextWaits--, { role: 'assistant', content: null, tool_calls: [{ id: `c${requests.length}`, type: 'function', function: { name: 'computer', arguments: JSON.stringify({ action: 'wait', duration: 0 }) } }] })
        : { role: 'assistant', content: 'All done.' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    } catch { /* the client hung up (Stop) */ } finally {
      inflight--;
    }
  });
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;

// ---------- the service ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-service-'));
const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-service-slow-'));
const cfg: DeskfishConfig = {
  provider: 'openai-compatible', autonomy: 'free', baseUrl, model: 'model-a', anthropicWorkspaceId: '', maxSteps: 0, maxCostUsd: 0,
  reflectEvery: 0, userName: '', ledgerEvery: 0, ledgerTokens: 0, cacheTtl: '1h', effort: '', scheduleGraceMinutes: 5, promptCaching: 'off',
  temperature: null, screenshotWidth: 320, settleMs: 0, daemonUrl, daemonToken: '', vncUrl: '', vncPassword: '', composeFile: '',
  containerCli: 'auto', screen: '320x200x24', autoStart: false, openDesktopOnRun: true,
};
const probe = async () => { try { return (await fetch(daemonUrl + '/')).ok; } catch { return false; } };
const logLines: string[] = [];
const service = new DeskfishService({
  dataDir, resourceDir: ROOT, config: cfg, log: (l) => logLines.push(l),
  createEngine: () => ({ isHealthy: probe, start: async () => {}, stop: async () => {}, inspectNetworkMode: async () => 'isolated' as const, networkMode: 'isolated' as const }),
});
service.setKey('deskfish.apiKey.127.0.0.1', 'dummy');
service.init(newSelfKey());

type Seen = { name: string; payload: any };
const seen: Seen[] = [];
for (const name of ['event', 'desktop', 'task', 'notice', 'schedule', 'reset', 'replay', 'download', 'config']) service.on(name, (payload: unknown) => seen.push({ name, payload }));
const statuses = () => seen.filter((s) => s.name === 'event' && s.payload.type === 'status').map((s) => (s.payload as Extract<AgentEvent, { type: 'status' }>).status);
const count = (status: string) => statuses().filter((s) => s === status).length;
const idx = (pred: (s: Seen) => boolean, from = 0) => seen.findIndex((s, i) => i >= from && pred(s));
const isStatus = (st: string) => (s: Seen) => s.name === 'event' && s.payload.type === 'status' && s.payload.status === st;
const runner = () => (service as any).runner;

try {
  ok(fs.existsSync(path.join(dataDir, 'self.md')) && fs.readFileSync(path.join(dataDir, 'journal.md'), 'utf8').includes('I hatched today'), 'init seeds the self and the first journal line in the data dir');

  // 1. a task runs; its events arrive in order
  await service.run('TASK-A open the page');
  await until(() => count('done') === 1, 'task A done');
  const iTask = idx((s) => s.name === 'task');
  const iOn = idx((s) => s.name === 'desktop' && s.payload.state === 'on');
  const iRunning = idx(isStatus('running'));
  const iShot = idx((s) => s.name === 'event' && s.payload.type === 'screenshot');
  const iSaid = idx((s) => s.name === 'event' && s.payload.type === 'assistant');
  const iFinished = idx((s) => s.name === 'event' && s.payload.type === 'task_finished');
  const iDone = idx(isStatus('done'));
  ok(iTask >= 0 && iOn > iTask && iRunning > iOn && iShot > iRunning && iSaid > iShot && iFinished > iSaid && iDone > iFinished, `task → desktop on → running → screenshot → assistant → task_finished → done (${[iTask, iOn, iRunning, iShot, iSaid, iFinished, iDone]})`);
  ok(requests.length === 1 && requests[0].model === 'model-a' && requests[0].text.includes('TASK-A'), 'one model call, with the task');
  ok(service.latestScreenshot?.dataUrl.startsWith('data:image/jpeg;base64,'), 'the latest screenshot is kept for a late Desktop tab');
  const chats = service.chats.list();
  ok(chats.length === 1 && fs.readFileSync(chats[0].file, 'utf8').includes('TASK-A'), 'the transcript is written in the data dir');

  // 2. one queue: a second run while busy waits and starts after the first ends
  closeGate();
  await service.run('TASK-B first');
  await until(() => requests.some((r) => r.text.includes('TASK-B')), 'task B at the model');
  await service.run('TASK-C second');
  ok(service.queued === 1 && service.busy, 'C is queued while B runs');
  ok(seen.some((s) => s.name === 'notice' && /starts when that one ends/.test(s.payload.text)), 'the queue says so in the chat');
  await sleep(200);
  ok(!requests.some((r) => r.text.includes('TASK-C')), 'C has not reached the model while B runs');
  openGate();
  await until(() => requests.some((r) => r.text.includes('TASK-C')) && count('done') === 3, 'C started and finished after B');
  const iBDone = idx(isStatus('done'), iDone + 1);
  const iCTask = seen.findIndex((s) => s.name === 'task' && s.payload.text.includes('TASK-C'));
  ok(iBDone >= 0 && iCTask > iBDone, `C was submitted to the runner only after B was done (${iBDone} < ${iCTask})`);
  ok(maxInflight === 1, `never two model calls at once (max ${maxInflight})`);
  ok(service.queued === 0, 'the queue is empty again');

  // 3. say during a reflection is held and started after it
  closeGate();
  const r = await service.reflect();
  ok(r === 'started', 'reflection started');
  await until(() => service.screenFree && inflight === 1, 'reflecting, at the model');
  service.say('TASK-D said while she reflects');
  ok(seen.some((s) => s.name === 'notice' && /She is reflecting/.test(s.payload.text)), 'the held notice is posted');
  ok(!requests.some((q) => q.text.includes('TASK-D')), 'the reflection never sees the held message');
  ok((await service.reflect()) === 'busy', 'a second reflect while busy says busy');
  openGate();
  await until(() => requests.some((q) => q.text.includes('TASK-D')), 'the held message starts as a task');
  await until(() => !service.busy, 'D done');

  // 4. Stop drops what is queued
  closeGate();
  await service.run('TASK-E running');
  await until(() => requests.some((q) => q.text.includes('TASK-E')) && inflight === 1, 'E at the model');
  await service.run('TASK-F queued');
  ok(service.queued === 1, 'F queued');
  const stoppedBefore = count('stopped');
  service.stop();
  await until(() => count('stopped') === stoppedBefore + 1, 'E stopped');
  openGate();
  await sleep(400);
  ok(service.queued === 0 && !requests.some((q) => q.text.includes('TASK-F')) && !service.busy, 'F was dropped, never started');
  ok(seen.some((s) => s.name === 'notice' && /waiting behind it was not started/.test(s.payload.text)), 'Stop says what it dropped');

  // 5. a schedule due while she is busy fires after the task, as its own chat
  closeGate();
  await service.run('TASK-G long one');
  await until(() => requests.some((q) => q.text.includes('TASK-G')) && inflight === 1, 'G at the model');
  const now = Date.now();
  const pad = (x: number) => String(x).padStart(2, '0');
  const d = new Date(now - 60_000);
  const at = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  service.schedules.add('TASK-S scheduled', { kind: 'once', at }, now - 180_000);
  await service.tickSchedules();
  ok(!seen.some((s) => s.name === 'schedule') && logLines.some((l) => /waiting for the current task to finish: TASK-S/.test(l)), 'due while busy: pending, not fired');
  const resetsBefore = seen.filter((s) => s.name === 'reset').length;
  openGate();
  await until(() => seen.some((s) => s.name === 'schedule' && s.payload.kind === 'fired'), 'the schedule fires after G', 10_000);
  await until(() => requests.some((q) => q.text.includes('TASK-S')), 'the scheduled task reaches the model');
  const fired = seen.find((s) => s.name === 'schedule')!.payload;
  ok(fired.auto === true && fired.task === 'TASK-S scheduled' && seen.filter((s) => s.name === 'reset').length === resetsBefore + 1, 'fired automatically, in a new chat');
  const sChat = service.chats.list().find((c) => c.firstTask.includes('TASK-S'));
  ok(sChat && !fs.readFileSync(sChat.file, 'utf8').includes('TASK-G'), 'the scheduled task has a transcript of its own');
  ok(service.schedules.list().length === 0, 'the one-off schedule is spent');
  await until(() => !service.busy, 'S done');

  // 6. the Downloads watcher's event comes out of the service
  ok(service.downloads.active, 'the watcher runs while the desktop is on');
  downloads.push({ name: 'report.pdf', size: 1234, mtime: Date.now(), dir: false });
  await until(() => seen.some((s) => s.name === 'download'), 'download event', 10_000);
  const dl = seen.find((s) => s.name === 'download')!.payload;
  ok(dl.name === 'report.pdf' && dl.path === '/home/bot/Downloads/report.pdf' && dl.size === 1234, `download reported: ${JSON.stringify(dl)}`);
  const listed = await service.listDownloads();
  ok(listed.length === 1 && listed[0].name === 'report.pdf', 'listDownloads through the service');

  // 7. setConfig with a new model: a running task keeps its runner; the next run builds a new one
  closeGate();
  nextWaits = 1;
  const before = requests.length;
  await service.run('TASK-H follow-up');
  await until(() => requests.length === before + 1 && inflight === 1, 'H at the model');
  const runnerDuring = runner();
  service.setConfig({ ...cfg, model: 'model-b' });
  ok(seen.some((s) => s.name === 'config' && s.payload.model === 'model-b'), 'setConfig emits config');
  openGate();
  await until(() => requests.length === before + 2 && !service.busy, 'H finished its second turn');
  ok(requests[before + 1].model === 'model-a' && runner() === runnerDuring, 'mid-task the model and the runner are unchanged');
  await service.run('TASK-I next');
  await until(() => requests.some((q) => q.text.includes('TASK-I')) && !service.busy, 'I done');
  ok(requests[requests.length - 1].model === 'model-b' && runner() !== runnerDuring, 'the next run gets a new runner on the new model');

  // 8. new chat clears the queue and the transcript; a past chat replays
  const file = service.chats.list()[0].file;
  service.openChat(file, 'earlier');
  ok(seen.some((s) => s.name === 'replay' && Array.isArray(s.payload.items)), 'a past chat replays as items');

  // 9. runs submitted while the tank is still turning on (checkpoint 1): the second waits in the queue
  let tankOn = false;
  let startCalls = 0;
  const slow = new DeskfishService({
    dataDir: dataDir2, resourceDir: ROOT, config: cfg,
    createEngine: () => ({ isHealthy: async () => tankOn && (await probe()), start: async () => { startCalls++; await sleep(300); tankOn = true; }, stop: async () => { tankOn = false; }, inspectNetworkMode: async () => 'isolated' as const, networkMode: 'isolated' as const }),
  });
  slow.setKey('deskfish.apiKey.127.0.0.1', 'dummy');
  slow.init(newSelfKey());
  const slowStatuses: { status: string; message?: string }[] = [];
  slow.on('event', (e: AgentEvent) => { if (e.type === 'status') slowStatuses.push(e); });
  closeGate();
  maxInflight = inflight;
  const pJ = slow.run('TASK-J first while the tank starts');
  await sleep(50);
  ok(slow.busy && !tankOn, 'busy while the tank is still starting');
  await slow.run('TASK-K second while the tank starts');
  ok(slow.queued === 1, 'the second run is queued, not started beside the first');
  ok((await slow.reflect()) === 'busy', 'a reflection asked while the tank starts says busy');
  await pJ;
  await until(() => requests.some((q) => q.text.includes('TASK-J')) && inflight === 1, 'J at the model');
  openGate();
  await until(() => requests.some((q) => q.text.includes('TASK-K')) && !slow.busy, 'K ran after J');
  ok(startCalls === 1 && maxInflight === 1, `the tank started once and one model call at a time (starts ${startCalls}, max ${maxInflight})`);
  await slow.desktop.stop();
  const pL = slow.run('TASK-L stopped before the tank is on');
  await sleep(50);
  slow.stop();
  await pL;
  await sleep(100);
  ok(!requests.some((q) => q.text.includes('TASK-L')) && slowStatuses.some((s) => s.status === 'stopped' && /before the desktop was on/.test(s.message ?? '')) && !slow.busy, 'Stop while the tank starts: the task never starts');
  slow.dispose();
} finally {
  service.dispose();
  daemon.close();
  model.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(dataDir2, { recursive: true, force: true });
}
console.log(`service: ${n} checks passed`);
process.exit(0);
