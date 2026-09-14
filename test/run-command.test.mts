// run_command: the terminal without the screen. The parser (defaults and caps) and describe line;
// the model's view of a result (stdout, stderr, exit code, timeout, the middle cut); the tank
// daemon itself, run on this machine with a throwaway HOME and a display that does not exist
// (echo and exit codes, closed stdin, cwd confined to HOME, an empty command refused, a timeout
// that kills, the capture limit, a hang-up that kills the process, and an input-side action
// answered while a command runs, i.e. not queued); the daemon client's mapping and the loop path
// against the mock daemon (result text for the model, trimmed output on the event); Stop during a
// command; and that the prompt and the docs know the tool.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { runCommandAction, RUN_COMMAND_DEFAULT_TIMEOUT, RUN_COMMAND_MAX_TIMEOUT } from '../src/agent/actions';
import { cutMiddle, renderCommand, summarizeCommand, MAX_COMMAND_OUTPUT, type RunCommand } from '../src/agent/command';
import { DesktopDaemonComputer } from '../src/computer/daemon';
import { AgentRunner } from '../src/agent/loop';
import { tankNote } from '../src/agent/prompts';
import { describeAction, type ActionResult, type ComputerProvider } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- parser ----------
const a = runCommandAction({ command: 'ls -la', timeout_seconds: 5000, cwd: ' work ' }) as RunCommand;
ok(a.type === 'run_command' && a.command === 'ls -la' && a.timeoutSeconds === RUN_COMMAND_MAX_TIMEOUT && a.cwd === 'work', 'timeout capped at the max, cwd trimmed');
ok((runCommandAction({ command: 'x' }) as RunCommand).timeoutSeconds === RUN_COMMAND_DEFAULT_TIMEOUT, 'default timeout');
ok((runCommandAction({ command: 'x', timeout_seconds: 0.2 }) as RunCommand).timeoutSeconds === 1, 'a fraction rounds up to one second');
ok((runCommandAction({}) as RunCommand).command === '' && !('cwd' in runCommandAction({ command: 'x', cwd: '  ' })), 'no command → empty (the daemon refuses it); blank cwd dropped');
ok(describeAction({ type: 'run_command', command: 'x'.repeat(80) }) === `run: ${'x'.repeat(57)}…`, 'describe cuts a long command');

// ---------- the model's view ----------
const base = { timedOut: false, ms: 12 };
ok(renderCommand(a, { ...base, stdout: 'hi\n', stderr: '', exit: 0 }) === '$ ls -la\nhi\n(exit 0 · 12 ms)', 'stdout, exit 0, milliseconds');
ok(renderCommand(a, { ...base, ms: 1500, stdout: '', stderr: 'oops\n', exit: 3 }) === '$ ls -la\n[stderr]\noops\n(exit 3 · 1.5 s)', 'stderr labelled, exit code, seconds');
ok(renderCommand(a, { ...base, stdout: '', stderr: '', exit: 0 }).includes('(no output)'), 'no output says so');
ok(renderCommand(a, { ...base, stdout: '', stderr: '', exit: null, timedOut: true }).endsWith('(timed out after 600 s and was killed)'), 'timeout names the limit');
ok(renderCommand(a, { ...base, stdout: 'partial', stderr: '', exit: null }).endsWith('(killed before it finished)'), 'killed without a timeout');
ok(renderCommand(a, { ...base, stdout: 'x', stderr: '', exit: 0, truncated: true }).includes('stopped capturing'), 'the daemon\'s capture limit is reported');
const big = cutMiddle('x'.repeat(50_000));
ok(big.length < MAX_COMMAND_OUTPUT + 80 && big.startsWith('x'.repeat(14_000)) && big.endsWith('x'.repeat(6_000)) && big.includes('[30,000 characters omitted]'), `the middle is cut, head and tail kept (${big.length})`);
ok(cutMiddle('short') === 'short', 'short text untouched');
ok(summarizeCommand({ ...base, stdout: 'a\nb\n', stderr: '', exit: 0 }) === 'exit 0 · 0.0 s · 2 lines' && summarizeCommand({ ...base, ms: 61_000, stdout: '', stderr: '', exit: null, timedOut: true }) === 'timed out after 61 s' && summarizeCommand({ ...base, stdout: '', stderr: '', exit: null }) === 'killed', 'one-line summaries');

// ---------- the real daemon, on this machine ----------
// HOME is a throwaway folder; DISPLAY points at nothing, so every xdotool/xinput call fails harmlessly.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-cmd-'));
const port = 9979;
const daemon = spawn(process.execPath, [path.join(ROOT, 'docker/desktop/daemon.mjs')], {
  env: { ...process.env, HOME: home, DISPLAY: ':98', DAEMON_BIND: '127.0.0.1', DAEMON_PORT: String(port), WS_PORT: '6098' },
  stdio: 'ignore',
});
const url = `http://127.0.0.1:${port}/computer-use/computer`;
const post = async (body: Record<string, unknown>, init: RequestInit = {}) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init })).json() as Promise<{ success: boolean; error?: string; data?: Record<string, unknown> }>;
try {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await sleep(50); }
  }
  const r1 = await post({ action: 'run_command', command: 'echo hi; echo oops >&2; exit 3' });
  ok(r1.success && r1.data?.stdout === 'hi\n' && r1.data?.stderr === 'oops\n' && r1.data?.exit === 3 && r1.data?.timedOut === false && typeof r1.data?.ms === 'number', `stdout, stderr and exit code come back (${JSON.stringify(r1)})`);
  const t0 = Date.now();
  const r2 = await post({ action: 'run_command', command: 'cat' });
  ok(r2.success && r2.data?.exit === 0 && r2.data?.stdout === '' && Date.now() - t0 < 2000, 'stdin is closed: cat returns at once instead of waiting');
  fs.mkdirSync(path.join(home, 'sub'));
  const r3 = await post({ action: 'run_command', command: 'pwd', cwd: 'sub' });
  ok(r3.success && String(r3.data?.stdout).trim() === fs.realpathSync(path.join(home, 'sub')), `cwd is relative to HOME (${r3.data?.stdout})`);
  const r4 = await post({ action: 'run_command', command: 'pwd', cwd: '../..' });
  ok(!r4.success && /inside/.test(r4.error ?? ''), 'a cwd outside HOME is refused');
  const r5 = await post({ action: 'run_command', command: '  ' });
  ok(!r5.success && /needs a command/.test(r5.error ?? ''), 'an empty command is refused');
  const t1 = Date.now();
  const r6 = await post({ action: 'run_command', command: 'echo start; sleep 30; echo never', timeout_seconds: 1 });
  ok(r6.success && r6.data?.timedOut === true && r6.data?.exit === null && r6.data?.stdout === 'start\n' && Date.now() - t1 < 4000, `a timeout kills the command and keeps its output so far (${Date.now() - t1} ms)`);
  const r7 = await post({ action: 'run_command', command: "head -c 300000 /dev/zero | tr '\\0' a" });
  ok(r7.success && String(r7.data?.stdout).length === 256 * 1024 && r7.data?.truncated === true, `capture stops at the limit and says so (${String(r7.data?.stdout).length})`);
  // Hanging up (Stop) kills the process group.
  const ctl = new AbortController();
  const hung = post({ action: 'run_command', command: `echo $$ > "${home}/pid"; sleep 30`, timeout_seconds: 20 }, { signal: ctl.signal }).catch(() => undefined);
  await sleep(400);
  ctl.abort();
  await hung;
  await sleep(600);
  const pid = Number(fs.readFileSync(path.join(home, 'pid'), 'utf8').trim());
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  ok(pid > 0 && !alive, `the caller hanging up kills the command (pid ${pid} alive: ${alive})`);
  // Not queued: an input-side action is answered while a command runs.
  const slow = post({ action: 'run_command', command: 'sleep 2', timeout_seconds: 5 });
  await sleep(100);
  const t2 = Date.now();
  const r8 = await post({ action: 'list_files', path: '.' });
  ok(r8.success && Date.now() - t2 < 1000, `list_files answered in ${Date.now() - t2} ms while a command ran`);
  await slow;
  const r9 = await post({ action: 'nope' });
  ok(!r9.success && /unknown action/.test(r9.error ?? ''), 'other actions still dispatch as before');
} finally {
  daemon.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

// ---------- the client and the loop, against the mock daemon ----------
const mockPort = 9978;
const mock = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-daemon.mjs')], { env: { ...process.env, MOCK_PORT: String(mockPort) }, stdio: 'ignore' });
try {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${mockPort}/`); break; } catch { await sleep(50); }
  }
  const computer = new DesktopDaemonComputer(`http://127.0.0.1:${mockPort}`);
  const r = await computer.execute({ type: 'run_command', command: 'git status', timeoutSeconds: 5 });
  ok(r.ok && r.command?.exit === 0 && r.command.stdout.includes('mock output of: git status'), `the client maps run_command to the daemon action (${JSON.stringify(r)})`);

  const seen: string[] = [];
  const events: string[] = [];
  let turn = 0;
  const adapter = {
    name: 'scripted',
    start() {},
    addUserMessage() {},
    async step(obs: Observation): Promise<ModelTurn> {
      turn++;
      for (const res of obs.results) if (res.message) seen.push(res.message);
      if (turn === 1) return { text: 'checking', actions: [{ type: 'run_command', command: 'git status', timeoutSeconds: 5 }, { type: 'run_command', command: 'fail now' }, { type: 'run_command', command: 'sleep 99' }] };
      return { text: 'done', actions: [], done: true };
    },
  } as unknown as ModelAdapter;
  const runner = new AgentRunner({
    computer,
    adapter,
    maxSteps: 4,
    screenshotWidth: 640,
    settleMs: 10,
    onEvent: (e) => { if (e.type === 'action') events.push(`${e.action.type}:${e.result.ok}:${e.result.message ?? ''}:${e.result.command ? 'out' : '-'}`); },
  });
  await runner.run('look at the repo');
  ok(runner.currentStatus === 'done', `loop finished (${runner.currentStatus})`);
  ok(seen.length === 3 && seen[0].startsWith('$ git status\nmock output of: git status\n(exit 0'), `the model gets the rendered result: ${seen[0]}`);
  ok(seen[1].includes('[stderr]') && seen[1].includes('(exit 127'), `a failing command shows stderr and the code: ${seen[1]}`);
  ok(seen[2].includes('timed out after 60 s'), `a timed-out command says so: ${seen[2]}`);
  ok(events.length === 3 && events[0] === 'run_command:true:exit 0 · 0.0 s · 1 line:out' && events[1].startsWith('run_command:true:exit 127') && events[2].startsWith('run_command:true:timed out'), `events carry a summary and the trimmed output: ${events.join(' | ')}`);
} finally {
  mock.kill();
}

// ---------- Stop during a command ----------
const frame = (): ActionResult => ({ ok: true });
const slowComputer: ComputerProvider = {
  name: 'slow',
  async displaySize() { return { width: 320, height: 200 }; },
  async screenshot() { const png = new PNG({ width: 320, height: 200 }); return { png: PNG.sync.write(png), width: 320, height: 200 }; },
  async execute(action, signal) {
    if (action.type !== 'run_command') return frame();
    await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => resolve(), { once: true }); setTimeout(resolve, 10_000); });
    return { ok: false, error: 'aborted' };
  },
};
let stopEvents = 0;
let t3 = 0;
const runner3 = new AgentRunner({
  computer: slowComputer,
  adapter: { name: 's', start() {}, addUserMessage() {}, async step(): Promise<ModelTurn> { t3++; return t3 === 1 ? { text: '', actions: [{ type: 'run_command', command: 'sleep 10' }] } : { text: 'done', actions: [], done: true }; } } as unknown as ModelAdapter,
  maxSteps: 4,
  screenshotWidth: 320,
  settleMs: 5,
  onEvent: (e) => { if (e.type === 'action') stopEvents++; },
});
const started = Date.now();
setTimeout(() => runner3.stop(), 150);
await runner3.run('t');
ok(runner3.currentStatus === 'stopped' && Date.now() - started < 1500 && stopEvents === 0, `Stop hangs up on the command: ${runner3.currentStatus} after ${Date.now() - started} ms, ${stopEvents} action events`);

// ---------- the prompt and the docs know it ----------
ok(tankNote().includes('run_command') && tankNote().includes('github.com/0x11c11e/deskfish') && tankNote().includes('Never commit to main'), 'the tank note lists the tool and the pull-request rule');
ok(fs.readFileSync(path.join(ROOT, 'docs/how-the-bot-sees-and-acts.md'), 'utf8').includes('| `run_command` |'), 'the docs tool table has the row');

console.log(`run_command: ${n} checks passed`);
