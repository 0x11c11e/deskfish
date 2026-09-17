// Step 5 of the gateway plan: unattended runs and staying alive.
//
// 1. `state.json` — the pure part (round trip, the journal line, the resume note's sentences) and
//    the live part through the real service with a mock daemon and a fake model: the file appears
//    when a run starts (0600, with the tank's container id), holds the ledger, is written by the
//    tick, and is gone after done, after Stop and after New chat.
// 2. Resume — a service started over a leftover state file writes one journal line and hands the
//    next run a note in its first observation (the ledger, the gap, the last action, whether the
//    tank restarted); a reflection does not take the note, and it is delivered only once.
// 3. The fence — a fired schedule builds its runner guided with the unattended budget (or the
//    schedule's own); an ordinary run keeps the settings the person chose; the fingerprint
//    separates them. `schedules.add` through the real validator, with and without the fields, and
//    an old `schedules.json` still loads.
// 4. Autostart — the entry's path and contents per platform, the rewrite decision, the removal.
//
// Nothing here touches podman, the user's data dir, or the real ~/.config/autostart.
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
import { validate } from '../src/gateway/protocol';
import { ScheduleStore } from '../src/agent/schedule';
import { describeGap, interruptedLine, readState, resumeNote, writeState, type RunState } from '../src/gateway/state';
import { autostartNeedsWrite, autostartPlan, hasDesktopSession, removeAutostart, writeAutostart } from '../src/gateway/autostart';

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

// ---------- 1. state.json, the pure part ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-state-'));
const base: RunState = {
  task: 'Book the 09:40 train to Munich',
  startedAt: new Date(Date.now() - 50 * 60_000).toISOString(),
  steps: 23,
  lastStepAt: new Date(Date.now() - 41 * 60_000).toISOString(),
  ledger: { step: 20, text: 'Goal: book the train.\nDone: search open.\nLeft: pick the 09:40.' },
  said: ['second class', 'aisle seat'],
  lastAssistant: 'I have the search results open.',
  lastAction: { step: 23, describe: 'left click at (410, 220)', ok: true },
  containerId: 'aaaa1111',
};

ok(describeGap(20_000) === 'less than a minute' && describeGap(41 * 60_000) === '41 minutes' && describeGap(60_000) === '1 minute' && describeGap(3 * 3600_000) === '3 hours' && describeGap(3 * 24 * 3600_000) === '3 days', `describeGap in words: ${[describeGap(20_000), describeGap(41 * 60_000), describeGap(3 * 3600_000), describeGap(3 * 24 * 3600_000)].join(' / ')}`);

writeState(tmp, base);
const back = readState(tmp)!;
ok(back.task === base.task && back.steps === 23 && back.ledger?.text === base.ledger!.text && back.said.length === 2 && back.lastAction?.describe === 'left click at (410, 220)' && back.containerId === 'aaaa1111', 'state.json round trip keeps every field');
ok((fs.statSync(path.join(tmp, 'state.json')).mode & 0o077) === 0, 'state.json is 0600 (nothing the file tells is anyone else\'s)');
fs.writeFileSync(path.join(tmp, 'state.json'), '{ not json');
ok(readState(tmp) === undefined, 'a broken state file reads as nothing, not as a crash');
fs.rmSync(path.join(tmp, 'state.json'));
ok(readState(tmp) === undefined, 'no state file, no state');

const line = interruptedLine(base, Date.now());
ok(/^Interrupted after 23 steps: "Book the 09:40 train to Munich" — 41 minutes ago\.$/.test(line), `the journal line says what and how long ago: ${line}`);
ok(interruptedLine({ ...base, reflection: true, task: 'a reflection', steps: 1 }, Date.now()).startsWith('Interrupted after 1 step: a reflection —'), 'an interrupted reflection is named as one');

const noteRestarted = resumeNote({ state: base, now: Date.now(), containerId: 'bbbb2222', desktopOn: true });
ok(noteRestarted.includes('Book the 09:40 train to Munich') && noteRestarted.includes('23 steps'), 'the note carries the task and how far it got');
ok(noteRestarted.includes('41 minutes ago'), 'the note says how long the gap was');
ok(noteRestarted.includes('Goal: book the train.') && noteRestarted.includes('after 20 steps'), 'the note carries the last ledger in full');
ok(noteRestarted.includes('"second class"') && noteRestarted.includes('"aisle seat"'), 'the note carries what the user said mid-task, in order');
ok(noteRestarted.includes('I have the search results open.'), 'the note carries the last thing she said');
ok(noteRestarted.includes('step 23: left click at (410, 220)') && noteRestarted.includes('unknown'), 'the note names the last action that finished and says the rest is unknown');
ok(noteRestarted.includes('tank itself restarted') && noteRestarted.includes('assume nothing in its windows survived'), 'a different container id means: assume nothing survived');
ok(/look first/i.test(noteRestarted) && /never continue with an action you had queued/i.test(noteRestarted), 'the note ends with the rule: look first, never a queued click');

const noteSame = resumeNote({ state: base, now: Date.now(), containerId: 'aaaa1111', desktopOn: true });
ok(!noteSame.includes('tank itself restarted') && noteSame.includes('same container'), 'the same container id does not claim a restart');
const noteOff = resumeNote({ state: base, now: Date.now(), desktopOn: false });
ok(noteOff.includes('tank is off right now') && noteOff.includes('Assume nothing in its windows survived'), 'a tank that is off now means the same thing');
const noteSched = resumeNote({ state: base, now: Date.now(), containerId: 'aaaa1111', desktopOn: true, schedules: [{ kind: 'missed', task: 'water report' }] });
ok(noteSched.includes('While you were away') && noteSched.includes('was missed') && noteSched.includes('water report'), 'what happened meanwhile is in the note');
const noNews = resumeNote({ state: { ...base, ledger: undefined, said: [], lastAssistant: undefined, lastAction: undefined }, now: Date.now(), desktopOn: true });
ok(!noNews.includes('ledger') && noNews.includes('No action of that run was recorded'), 'a run with nothing recorded says so instead of inventing it');

// ---------- 4. autostart (pure; a temp home, never the user's own) ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-home-'));
const A = { execPath: '/usr/share/code/code', entry: '/home/mx/.vscode/extensions/deskfish-0.1.0/dist/gateway.js', dataDir: '/home/mx/.local/share/deskfish', port: 9980, home };

const xdg = autostartPlan({ ...A, platform: 'linux', desktopSession: true });
ok(xdg.kind === 'xdg' && xdg.file === path.join(home, '.config', 'autostart', 'deskfish.desktop'), `linux with a desktop session writes the XDG entry: ${xdg.file}`);
ok(
  xdg.contents!.includes('[Desktop Entry]') &&
    xdg.contents!.includes(`Exec=env ELECTRON_RUN_AS_NODE=1 "${A.execPath}" "${A.entry}" "serve" "--port" "9980" "--data-dir" "${A.dataDir}"`) &&
    xdg.contents!.includes('Terminal=false') &&
    xdg.contents!.includes('X-GNOME-Autostart-enabled=true'),
  `the entry runs the same command spawn.ts does:\n${xdg.contents}`,
);
ok(xdg.install.startsWith('sh -c ') && xdg.install.includes('cat') && xdg.remove.includes('rm -f'), 'the terminal shows the entry, and the removal is one rm');

const cron = autostartPlan({ ...A, platform: 'linux', desktopSession: false });
ok(cron.kind === 'cron' && !cron.file && cron.install.includes('@reboot') && cron.install.includes('crontab -') && cron.reapplyOnChange, 'linux without a desktop session falls back to a @reboot crontab line');
ok(cron.install.includes('ELECTRON_RUN_AS_NODE=1') && cron.install.includes('--data-dir') && cron.remove.includes('grep -v'), 'the cron line carries the same command, and the removal filters it out');

const mac = autostartPlan({ ...A, platform: 'darwin' });
ok(mac.kind === 'launchagent' && mac.file === path.join(home, 'Library', 'LaunchAgents', 'sh.deskfish.gateway.plist'), `macOS writes a LaunchAgent: ${mac.file}`);
ok(mac.contents!.includes('<key>RunAtLoad</key>') && mac.contents!.includes('<string>sh.deskfish.gateway</string>') && mac.contents!.includes(`<string>${A.entry}</string>`) && mac.contents!.includes('ELECTRON_RUN_AS_NODE'), 'the plist runs the gateway at load, as Node');
ok(mac.install.includes('launchctl load -w') && mac.remove.includes('launchctl unload') && mac.remove.includes('rm -f'), 'the agent is loaded and unloaded visibly');

const win = autostartPlan({ ...A, platform: 'win32', dataDir: 'C:\\Users\\mx\\AppData\\Roaming\\deskfish' });
ok(win.kind === 'schtasks' && win.file === 'C:\\Users\\mx\\AppData\\Roaming\\deskfish\\deskfish-gateway.cmd', `Windows points a logon task at a script of ours: ${win.file}`);
ok(win.contents!.includes('set "ELECTRON_RUN_AS_NODE=1"') && win.contents!.includes('--data-dir'), 'the script sets the Node flag and starts the gateway');
ok(win.install.includes('schtasks /create /f /sc onlogon /tn Deskfish') && win.remove.includes('schtasks /delete /f /tn Deskfish'), 'the task is created at logon and deleted again');

ok(autostartNeedsWrite(xdg), 'nothing in place yet: the entry must be written');
writeAutostart(xdg);
ok(fs.readFileSync(xdg.file!, 'utf8') === xdg.contents && !autostartNeedsWrite(xdg), 'written once, the same build asks for no rewrite');
const moved = autostartPlan({ ...A, platform: 'linux', desktopSession: true, entry: '/home/mx/.vscode/extensions/deskfish-0.1.1/dist/gateway.js' });
ok(autostartNeedsWrite(moved), 'after an update moved the extension, the entry is rewritten');
writeAutostart(moved);
ok(!autostartNeedsWrite(moved) && fs.readFileSync(xdg.file!, 'utf8').includes('0.1.1'), 'the rewrite lands in the same file');
removeAutostart(moved);
ok(!fs.existsSync(xdg.file!) && autostartNeedsWrite(moved), 'removing it takes the file away');
ok(hasDesktopSession({ XDG_CURRENT_DESKTOP: 'XFCE' }) && hasDesktopSession({ DISPLAY: ':0' }) && !hasDesktopSession({}), 'a desktop session is detected from XDG_CURRENT_DESKTOP or DISPLAY');

// ---------- the live parts: a mock daemon and a fake model ----------
const png = PNG.sync.write(new PNG({ width: 320, height: 200 })).toString('base64');
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
      case 'list_files': return reply({ success: true, data: { entries: [] } });
      case 'release_input': return reply({ success: true, data: { released: [], blind: false } });
      case 'input_state': return reply({ success: true, data: { keys: [], buttons: [] } });
      default: return reply({ success: true });
    }
  });
});
await new Promise<void>((r) => daemon.listen(0, '127.0.0.1', r));
const daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;

/** The fake model: a queue of replies (a `wait` action, or text), everything else "All done." */
type Scripted = { kind: 'wait' } | { kind: 'text'; text: string };
let queued: Scripted[] = [];
const requests: string[] = [];
/** Requests from this index on wait for `release()` — so a step can be caught half-done. */
let holdFrom = Infinity;
let release = () => {};
let held = new Promise<void>((r) => (release = r));
const model = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const body = JSON.parse(raw);
    requests.push(JSON.stringify(body.messages));
    const mine = requests.length;
    const next = queued.shift() ?? { kind: 'text' as const, text: 'All done.' };
    try {
      if (mine >= holdFrom) await held;
      const message = next.kind === 'wait'
        ? { role: 'assistant', content: null, tool_calls: [{ id: `c${mine}`, type: 'function', function: { name: 'computer', arguments: JSON.stringify({ action: 'wait', duration: 0 }) } }] }
        : { role: 'assistant', content: next.text };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    } catch { /* hung up */ }
  });
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
const probe = async () => { try { return (await fetch(daemonUrl + '/')).ok; } catch { return false; } };

const cfg: DeskfishConfig = {
  provider: 'openai-compatible', autonomy: 'free', baseUrl, model: 'model-a', anthropicWorkspaceId: '', maxSteps: 0, maxCostUsd: 7, unattendedMaxCostUsd: 2,
  reflectEvery: 0, userName: '', ledgerEvery: 0, ledgerTokens: 0, cacheTtl: '1h', effort: '', scheduleGraceMinutes: 5, promptCaching: 'off',
  temperature: null, screenshotWidth: 320, settleMs: 0, daemonUrl, daemonToken: '', vncUrl: '', vncPassword: '', composeFile: '',
  containerCli: 'auto', screen: '320x200x24', autoStart: false, openDesktopOnRun: true,
};
let tankId = 'tank-one';
const engine = () => ({ isHealthy: probe, start: async () => {}, stop: async () => {}, inspectNetworkMode: async () => 'isolated' as const, networkMode: 'isolated' as const, containerId: async () => tankId });

const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-state-live-'));
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-state-resume-'));
const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-state-fence-'));
const state = (dir: string) => readState(dir);
let live: DeskfishService | undefined;
let resumed: DeskfishService | undefined;
let fenced: DeskfishService | undefined;

try {
  // ---------- 2. the state file's life ----------
  live = new DeskfishService({ dataDir: dirA, resourceDir: ROOT, config: { ...cfg, ledgerEvery: 1 }, tickMs: 150, createEngine: engine, log: () => {} });
  live.setKey('deskfish.apiKey.127.0.0.1', 'dummy');
  live.init(newSelfKey());
  ok(!fs.existsSync(path.join(dirA, 'state.json')), 'nothing is recorded before a run');

  // A step that finishes, then the model held: the file still says 0 steps until the tick writes it.
  queued = [{ kind: 'wait' }, { kind: 'text', text: 'LEDGER-ONE: the boxes are open.' }];
  holdFrom = 3;
  held = new Promise<void>((r) => (release = r));
  await live.run('TASK-STATE the long one');
  await until(() => !!state(dirA), 'the state file appears');
  const started = state(dirA)!;
  ok(started.task.includes('TASK-STATE') && started.containerId === 'tank-one' && started.steps === 0, `the file names the task and the tank at the start: ${started.containerId}`);
  ok((fs.statSync(path.join(dirA, 'state.json')).mode & 0o077) === 0, 'it is 0600');
  await until(() => (state(dirA)?.ledger?.text ?? '').includes('LEDGER-ONE'), 'the ledger is written at once');
  ok(state(dirA)!.ledger!.text.includes('LEDGER-ONE'), 'a ledger is written to the file the moment she writes it');
  await until(() => (state(dirA)?.steps ?? 0) >= 1, 'the tick writes the steps');
  ok(state(dirA)!.steps >= 1 && state(dirA)!.lastAction?.describe, `the 150 ms tick wrote the step and the last action (${state(dirA)!.steps} steps, ${state(dirA)!.lastAction?.describe})`);
  release();
  await until(() => !live!.busy, 'the task finishes');
  ok(!fs.existsSync(path.join(dirA, 'state.json')), 'a finished run leaves nothing behind');

  // Stop and New chat clear it too.
  holdFrom = Infinity;
  queued = [{ kind: 'wait' }];
  holdFrom = 2;
  held = new Promise<void>((r) => (release = r));
  await live.run('TASK-STOP');
  await until(() => !!state(dirA), 'recording again');
  live.stop();
  release();
  await until(() => !fs.existsSync(path.join(dirA, 'state.json')), 'Stop clears the state');
  ok(true, 'Stop clears the state file');
  holdFrom = Infinity;
  writeState(dirA, base);
  live.newConversation();
  ok(!fs.existsSync(path.join(dirA, 'state.json')), 'New chat clears the state file');
  live.dispose();
  live = undefined;

  // ---------- 3. resume: the journal line and the note ----------
  const interrupted: RunState = { ...base, task: 'TASK-INTERRUPTED buy the tickets', containerId: 'tank-zero' };
  writeState(dirB, interrupted);
  resumed = new DeskfishService({ dataDir: dirB, resourceDir: ROOT, config: cfg, createEngine: engine, log: () => {} });
  resumed.setKey('deskfish.apiKey.127.0.0.1', 'dummy');
  resumed.init(newSelfKey());
  const journal = fs.readFileSync(path.join(dirB, 'journal.md'), 'utf8');
  ok(journal.includes('Interrupted after 23 steps: "TASK-INTERRUPTED buy the tickets" — 41 minutes ago.'), `the journal has the one line: ${journal.split('\n').filter((l) => l.includes('Interrupted')).join(' ')}`);
  ok(readState(dirB)?.noted === true, 'the file is marked so a second start does not write the line twice');

  // A reflection does not take the note.
  queued = [];
  const r = await resumed.reflect();
  ok(r === 'started', 'a reflection can start');
  await until(() => !resumed!.busy, 'the reflection finishes');
  const afterReflection = requests.length;
  ok(!requests[afterReflection - 1].includes('did not finish'), 'a reflection is not told about the interruption');

  // The next real task is.
  await resumed.run('TASK-NEXT the new one');
  await until(() => !resumed!.busy, 'the next task finishes');
  const first = requests[afterReflection];
  ok(first.includes('TASK-INTERRUPTED buy the tickets') && first.includes('did not finish'), 'the next task carries the note in its first observation');
  ok(first.includes('41 minutes ago') && first.includes('Goal: book the train.') && first.includes('left click at (410, 220)'), 'the note in the observation has the gap, the ledger and the last action');
  ok(first.includes('tank itself restarted'), 'the tank restarted (tank-zero → tank-one), and the note says so');
  await resumed.run('TASK-AFTER another one');
  await until(() => !resumed!.busy, 'the third task finishes');
  // The follow-up continues the same conversation, so the note is still in its history — once.
  const occurrences = requests[requests.length - 1].split('did not finish').length - 1;
  ok(occurrences === 1, `the note is delivered once and then forgotten (${occurrences} in the last conversation)`);

  // The same container: no restart claim. (A fresh service over a fresh state file.)
  resumed.dispose();
  resumed = undefined;
  fs.rmSync(path.join(dirB, 'state.json'), { force: true });
  writeState(dirB, { ...interrupted, containerId: 'tank-one' });
  resumed = new DeskfishService({ dataDir: dirB, resourceDir: ROOT, config: cfg, createEngine: engine, log: () => {} });
  resumed.setKey('deskfish.apiKey.127.0.0.1', 'dummy');
  resumed.init(newSelfKey());
  const beforeSame = requests.length;
  await resumed.run('TASK-SAME-TANK');
  await until(() => !resumed!.busy, 'that task finishes');
  ok(requests[beforeSame].includes('same container') && !requests[beforeSame].includes('tank itself restarted'), 'the same tank is not reported as restarted');
  resumed.dispose();
  resumed = undefined;

  // ---------- 4. the fence on unattended runs ----------
  fenced = new DeskfishService({ dataDir: dirC, resourceDir: ROOT, config: cfg, createEngine: engine, log: () => {} });
  fenced.setKey('deskfish.apiKey.127.0.0.1', 'dummy');
  fenced.init(newSelfKey());
  const opts = () => (fenced as any).runner?.opts as { budgetUsd?: number; budgetSetting?: string };
  const print = () => (fenced as any).runnerFingerprint as string;

  await fenced.run('TASK-ATTENDED');
  await until(() => !fenced!.busy, 'the attended task finishes');
  ok(opts().budgetUsd === 7 && opts().budgetSetting === 'deskfish.maxCostUsd' && print().includes('"free"'), `a task the person typed keeps their settings (budget ${opts().budgetUsd}, ${print().includes('"free"') ? 'free' : 'guided'})`);
  const attendedPrint = print();

  const now = Date.now();
  const pad = (x: number) => String(x).padStart(2, '0');
  const d = new Date(now - 60_000);
  const at = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  fenced.schedules.add('TASK-SCHEDULED default fence', { kind: 'once', at }, now - 180_000);
  await fenced.tickSchedules();
  await until(() => !fenced!.busy && requests.some((q) => q.includes('TASK-SCHEDULED default fence')), 'the scheduled task ran');
  ok(opts().budgetUsd === 2 && opts().budgetSetting === 'deskfish.unattendedMaxCostUsd', `a fired schedule runs on the unattended budget (${opts().budgetUsd})`);
  ok(print().includes('"guided"') && print() !== attendedPrint, 'it runs guided, on a runner of its own (the fingerprint differs)');

  const d2 = new Date(now - 60_000);
  const at2 = `${d2.getFullYear()}-${pad(d2.getMonth() + 1)}-${pad(d2.getDate())}T${pad(d2.getHours())}:${pad(d2.getMinutes())}`;
  fenced.schedules.add('TASK-SCHEDULED own fence', { kind: 'once', at: at2 }, now - 180_000, { autonomy: 'free', maxCostUsd: 0.5 });
  await fenced.tickSchedules();
  await until(() => !fenced!.busy && requests.some((q) => q.includes('TASK-SCHEDULED own fence')), 'the second scheduled task ran');
  ok(opts().budgetUsd === 0.5 && opts().budgetSetting === "this schedule's budget" && print().includes('"free"'), `a schedule's own fence wins (budget ${opts().budgetUsd}, free)`);

  // "Run it now" is a person's click: attended.
  const s3 = fenced.schedules.add('TASK-RUN-NOW', { kind: 'daily', time: '23:59' });
  await fenced.runSchedule(s3.id);
  await until(() => !fenced!.busy && requests.some((q) => q.includes('TASK-RUN-NOW')), 'run-now ran');
  ok(opts().budgetUsd === 7 && print().includes('"free"'), 'Run it now is attended: the settings the person chose');

  // ---------- 5. schedules with and without the new fields ----------
  const v1 = validate({ id: 1, cmd: 'schedules.add', args: { task: 'x', when: { kind: 'daily', time: '07:00' } } });
  const v2 = validate({ id: 2, cmd: 'schedules.add', args: { task: 'x', when: { kind: 'daily', time: '07:00' }, autonomy: 'free', maxCostUsd: 3 } });
  const v3 = validate({ id: 3, cmd: 'schedules.add', args: { task: 'x', when: { kind: 'daily', time: '07:00' }, autonomy: 'wild' } });
  const v4 = validate({ id: 4, cmd: 'schedules.add', args: { task: 'x', when: { kind: 'daily', time: '07:00' }, budget: 3 } });
  ok(v1.ok && v2.ok, 'schedules.add takes the fence fields, and still works without them');
  ok(!v3.ok && /autonomy/.test(v3.error) && !v4.ok && /unknown argument budget/.test(v4.error), `the validator refuses a bad autonomy and an unknown field: ${!v3.ok && v3.error} / ${!v4.ok && v4.error}`);
  const added = fenced.addSchedule('TASK-ADDED', { kind: 'weekly', day: 1, time: '07:00' }, { autonomy: 'free', maxCostUsd: 1.25 });
  ok(added.autonomy === 'free' && added.maxCostUsd === 1.25, 'the service stores the fence on the schedule');
  ok(fenced.schedules.describe().some((l) => l.includes('TASK-ADDED') && l.includes('free') && l.includes('budget $1.25')), `the list shows the fence: ${fenced.schedules.describe().find((l) => l.includes('TASK-ADDED'))}`);

  // An old schedules.json (no fence fields) still loads, and its runs get the defaults.
  const oldFile = path.join(tmp, 'schedules.json');
  fs.writeFileSync(oldFile, JSON.stringify([{ id: 'old1', task: 'from an older version', when: { kind: 'daily', time: '07:00' }, createdAt: new Date().toISOString() }], null, 2));
  const oldStore = new ScheduleStore(oldFile);
  const old = oldStore.list()[0];
  ok(old && old.task === 'from an older version' && old.autonomy === undefined && old.maxCostUsd === undefined, 'a schedules.json written before the fence still loads');
  fenced.dispose();
  fenced = undefined;
} finally {
  live?.dispose();
  resumed?.dispose();
  fenced?.dispose();
  daemon.close();
  model.close();
  for (const d of [tmp, home, dirA, dirB, dirC]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`state: ${n} checks passed`);
process.exit(0);
