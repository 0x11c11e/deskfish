// Settings, one source of truth, schedules over the wire (gateway plan step 6A). The schema the web
// page's Settings dialog renders is derived from package.json: every deskfish.* setting but
// gateway.*, with the type, enum and default of DEFAULT_CONFIG, each key in one group, the model's
// three keys listed but not rendered; SETTINGS_KEYS is the one table of setting names. The sync rules
// (src/gateway/configSync.ts) against a fake gateway and a fake settings.json whose writes echo at
// once: a change made elsewhere is written and its echo pushes nothing; a two-key save and the model
// picker's three writes do not undo each other; the seed happens once; a refused value does not block
// the others. Then the real gateway: `config.schema`, `configSaved`, a model set by one client is the
// model of a run started by another, schedules added (with and without a budget), listed, run now
// and removed over the wire; the schedule form's parsing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { DEFAULT_CONFIG, applyConfigPatch, type DeskfishConfig } from '../src/gateway/config';
import { CONFIG_KEYS, SETTINGS_KEYS, settingLabel, settingsSchema } from '../src/gateway/settingsSchema';
import { ConfigSync, changedKeys, patchBetween, writesFor, type SettingWrite } from '../src/gateway/configSync';
import { DeskfishService } from '../src/gateway/service';
import { GatewayServer } from '../src/gateway/server';
import { GatewayClient } from '../src/gateway/client';
import { validate } from '../src/gateway/protocol';
import { inAnHour, parseBudget, whenFromFields } from '../src/agent/scheduleForm';

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
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const props = pkg.contributes.configuration.properties as Record<string, any>;

// ---------- 1. the schema, from package.json ----------
{
  const schema = settingsSchema(pkg);
  const settings = Object.keys(props).filter((k) => k.startsWith('deskfish.') && !k.startsWith('deskfish.gateway.'));
  ok(schema.length === 31 && CONFIG_KEYS.length === 31 && Object.keys(DEFAULT_CONFIG).length === 31, `31 settings (schema ${schema.length}, table ${CONFIG_KEYS.length})`);
  ok(JSON.stringify(schema.map((e) => e.setting).sort()) === JSON.stringify(settings.sort()), 'every deskfish.* setting of package.json except gateway.* is in the schema, and nothing else');
  ok(Object.keys(props).filter((k) => k.startsWith('deskfish.gateway.')).length === 3 && !schema.some((e) => e.setting.startsWith('deskfish.gateway.')), 'the three gateway.* settings never reach it');
  const bad: string[] = [];
  for (const e of schema) {
    const d = DEFAULT_CONFIG[e.key];
    const p = props[e.setting];
    if (e.setting !== SETTINGS_KEYS[e.key]) bad.push(`${e.key}: setting`);
    if (e.nullable ? !(e.type === 'number' && d === null) : typeof d !== e.type) bad.push(`${e.key}: type ${e.type}`);
    if (e.default !== d) bad.push(`${e.key}: default ${JSON.stringify(e.default)} ≠ ${JSON.stringify(d)}`);
    if (e.description !== p.description || !e.description) bad.push(`${e.key}: description`);
    if (JSON.stringify(e.enum) !== JSON.stringify(p.enum)) bad.push(`${e.key}: enum`);
    if (e.enum) {
      for (const v of e.enum) try { applyConfigPatch(DEFAULT_CONFIG, { [e.key]: v }); } catch { bad.push(`${e.key}: enum value ${v} refused by the gateway`); }
      try { applyConfigPatch(DEFAULT_CONFIG, { [e.key]: 'not-in-the-enum' }); bad.push(`${e.key}: a value outside the enum accepted`); } catch { /* refused, as it must be */ }
    }
  }
  ok(bad.length === 0, `every entry has the type, default, enum and words of package.json and DEFAULT_CONFIG: ${bad.join('; ') || 'all'}`);
  ok(schema.find((e) => e.key === 'temperature')?.nullable === true && schema.find((e) => e.key === 'temperature')?.maximum === 2, 'temperature: a nullable number with its range');
  ok(schema.find((e) => e.key === 'autonomy')?.enumDescriptions?.length === 2, 'enum descriptions travel (autonomy)');
  ok(new Set(schema.map((e) => e.key)).size === 31, 'each key in exactly one group');
  const group = (g: string) => schema.filter((e) => e.group === g).map((e) => e.key).join();
  // `auth` joins them: the model picker owns it (it is how "Sign in with Grok" is remembered), so
  // like the other three it is in the schema but never rendered as a field of its own.
  ok(group('model') === 'provider,model,baseUrl,auth', `the model picker's four keys are marked model (${group('model')})`);
  ok(group('work') === 'autonomy,maxSteps,maxCostUsd,unattendedMaxCostUsd,effort,reflectEvery,userName', `How she works: ${group('work')}`);
  ok(group('desktop') === 'containerCli,screen,autoStart,openDesktopOnRun,screenshotWidth,settleMs,vncPassword', `Her desktop: ${group('desktop')}`);
  ok(group('remote') === 'remoteRelay,remoteUsername', `Reaching her from anywhere: ${group('remote')}`);
  ok(group('advanced') === 'daemonUrl,daemonToken,vncUrl,composeFile,anthropicWorkspaceId,temperature,promptCaching,cacheTtl,ledgerEvery,ledgerTokens,scheduleGraceMinutes', `Advanced: ${group('advanced')}`);
  const order = schema.map((e) => e.group).filter((g, i, a) => a.indexOf(g) === i).join();
  ok(order === 'model,work,desktop,remote,advanced', `groups in order: ${order}`);
  // The table readConfig() uses: one setting per key, and back.
  const back = Object.fromEntries(Object.entries(SETTINGS_KEYS).map(([k, s]) => [s, k]));
  ok(Object.keys(back).length === 31 && CONFIG_KEYS.every((k) => back[SETTINGS_KEYS[k]] === k), 'SETTINGS_KEYS round-trips (no two keys share a setting)');
  // The relay plan's two keys are settings like any other — and the password and the keys are not settings at all.
  ok(SETTINGS_KEYS.remoteRelay === 'deskfish.remote.relay' && SETTINGS_KEYS.remoteUsername === 'deskfish.remote.username' && DEFAULT_CONFIG.remoteRelay === '' && DEFAULT_CONFIG.remoteUsername === '', 'remote access is two settings, both empty by default');
  ok(!CONFIG_KEYS.some((k) => /password|secret|record|key$/i.test(k) && k !== 'vncPassword'), 'no credential of the relay is a setting');
  ok(SETTINGS_KEYS.daemonToken === 'deskfish.desktop.token' && SETTINGS_KEYS.openDesktopOnRun === 'deskfish.desktop.openOnRun', 'the two renamed desktop settings');
  ok(['daemonUrl', 'vncUrl', 'vncPassword', 'composeFile', 'containerCli', 'screen', 'autoStart'].every((k) => SETTINGS_KEYS[k as keyof DeskfishConfig] === `deskfish.desktop.${k}`), 'the seven desktop.* settings that keep their name');
  ok(settingLabel('deskfish.desktop.openOnRun') === 'Desktop: Open On Run' && settingLabel('deskfish.maxCostUsd') === 'Max Cost Usd', 'labels as VS Code shows them');
  ok(settingsSchema({}).length === 0 && settingsSchema(null).length === 0, 'a package.json without settings gives an empty schema, no throw');
}

// ---------- 2. patchBetween, writesFor ----------
{
  const a = { ...DEFAULT_CONFIG };
  ok(JSON.stringify(patchBetween(a, { ...a })) === '{}', 'no change → {}');
  ok(JSON.stringify(patchBetween(a, { ...a, maxSteps: 30, model: 'm' })) === JSON.stringify({ model: 'm', maxSteps: 30 }), 'changed keys only');
  ok(JSON.stringify(patchBetween({ ...a, temperature: 0.3 }, a)) === '{"temperature":null}', 'a temperature back to null is a change');
  ok(JSON.stringify(patchBetween(a, { ...a, maxSteps: 30, model: 'm' }, ['maxSteps'])) === '{"maxSteps":30}', 'limited to the keys asked for');
  ok(changedKeys(a, { ...a, autoStart: false }).join() === 'autoStart', 'changedKeys');
  const w = writesFor({ ...a, model: 'grok-4.6', maxSteps: 0 }, { ...a, maxSteps: 12 });
  ok(w.length === 2 && w.find((x) => x.key === 'model')?.value === 'grok-4.6' && w.find((x) => x.key === 'model')?.setting === 'deskfish.model', 'a differing value is written to its setting');
  ok(w.find((x) => x.key === 'maxSteps')?.value === undefined && w.find((x) => x.key === 'maxSteps')?.setting === 'deskfish.maxSteps', 'a value equal to the default is written as undefined (removed from settings.json)');
  ok(writesFor(a, { ...a }).length === 0, 'equal → no writes');
  ok(writesFor({ ...a, model: 'x', daemonToken: 't' }, a, DEFAULT_CONFIG, ['daemonToken'])[0]?.setting === 'deskfish.desktop.token' && writesFor({ ...a, model: 'x', daemonToken: 't' }, a, DEFAULT_CONFIG, ['daemonToken']).length === 1, 'limited to the keys asked for, under the renamed setting');
}

// ---------- 3. the sync against a fake gateway and a fake settings.json ----------
function world(start: { gateway?: Partial<DeskfishConfig>; settings?: Partial<DeskfishConfig>; delayEvents?: boolean } = {}) {
  const w = {
    gateway: { ...DEFAULT_CONFIG, ...start.gateway } as DeskfishConfig,
    settings: { ...DEFAULT_CONFIG, ...start.settings } as DeskfishConfig,
    pushes: [] as Partial<DeskfishConfig>[],
    writes: [] as SettingWrite[],
    keys: [] as string[],
    logs: [] as string[],
    pending: [] as DeskfishConfig[],
    sync: undefined as unknown as ConfigSync,
    /** A setting changed in VS Code: onDidChangeConfiguration names it, and the handler runs at once. */
    edit(key: keyof DeskfishConfig, value: unknown) {
      (w.settings as any)[key] = value;
      return w.sync.settingsChanged((s) => s === SETTINGS_KEYS[key]);
    },
    /** Another client (the web page) changed the gateway: its `config` event reaches VS Code. */
    elsewhere(patch: Partial<DeskfishConfig>) {
      w.gateway = applyConfigPatch(w.gateway, patch);
      return w.sync.config(w.gateway);
    },
    async deliver() {
      while (w.pending.length) await w.sync.config(w.pending.shift()!);
    },
  };
  w.sync = new ConfigSync({
    readSettings: () => ({ ...w.settings }),
    push: async (patch) => {
      w.pushes.push(patch);
      w.gateway = applyConfigPatch(w.gateway, patch as Record<string, unknown>);
      if (start.delayEvents) w.pending.push(w.gateway);
      else await w.sync.config(w.gateway);
      return w.gateway;
    },
    write: async (x) => {
      w.writes.push(x);
      (w.settings as any)[x.key] = x.value === undefined ? DEFAULT_CONFIG[x.key] : x.value;
      // The echo: VS Code fires onDidChangeConfiguration for the written setting while the other writes are still to come.
      void w.sync.settingsChanged((s) => s === x.setting);
    },
    pushKey: async (cfg) => void w.keys.push(`${cfg.provider} ${cfg.baseUrl}`),
    log: (line) => void w.logs.push(line),
  });
  return w;
}
const same = (a: DeskfishConfig, b: DeskfishConfig) => changedKeys(a, b).length === 0;
{
  // The seed: a gateway with no config.json gets VS Code's settings once, whole.
  const grok = { provider: 'openai-compatible' as const, model: 'grok-4.6', baseUrl: 'https://api.x.ai/v1', containerCli: 'podman' as const };
  let w = world({ settings: grok });
  ok((await w.sync.connected({ config: w.gateway, configSaved: false })) === 'seeded', 'no config.json: seeded');
  ok(w.pushes.length === 1 && Object.keys(w.pushes[0]).length === 31 && w.gateway.model === 'grok-4.6' && w.writes.length === 0 && same(w.gateway, w.settings), `one push of every setting, nothing written back (${w.pushes.length} push, ${w.writes.length} writes)`);
  ok(w.keys.includes('openai-compatible https://api.x.ai/v1'), "the seeded provider's key is pushed");
  w = world({ settings: grok });
  ok((await w.sync.connected({ config: w.gateway })) === 'seeded', 'a gateway from before configSaved is seeded as before');

  // Connect to a gateway that has its config: nothing pushed, VS Code follows it.
  w = world({ gateway: { ...grok, maxSteps: 40 }, settings: { model: 'claude-opus-5', maxSteps: 0 } });
  ok((await w.sync.connected({ config: w.gateway, configSaved: true })) === 'mirrored', 'config.json exists: mirrored');
  ok(w.pushes.length === 0 && same(w.gateway, w.settings) && w.writes.length === 5, `no push; every differing setting written (${w.writes.map((x) => x.key).join()})`);
  ok(w.keys.length === 1 && w.keys[0] === 'openai-compatible https://api.x.ai/v1', "the gateway's provider's key is pushed");

  // Ping-pong: a model chosen on the web page is written into settings.json, and the echo pushes nothing.
  w = world();
  await w.sync.connected({ config: w.gateway, configSaved: true });
  await w.elsewhere({ provider: 'openai-compatible', model: 'grok-4.6', baseUrl: 'https://api.x.ai/v1' });
  await sleep(5);
  ok(w.writes.length === 3 && w.pushes.length === 0 && same(w.gateway, w.settings), `a change on the web page: 3 writes, 0 pushes, both equal (${w.writes.length}/${w.pushes.length})`);
  ok(w.keys.at(-1) === 'openai-compatible https://api.x.ai/v1', 'a new provider on the gateway: its key is pushed if VS Code holds one');

  // A two-key save on the web page: the first write's echo must not push the second key's old value.
  const writesBefore = w.writes.length;
  await w.elsewhere({ maxSteps: 10, maxCostUsd: 5 });
  await sleep(5);
  ok(w.pushes.length === 0 && w.gateway.maxSteps === 10 && w.gateway.maxCostUsd === 5 && same(w.gateway, w.settings) && w.writes.length - writesBefore === 2, `a two-key web save survives its own echoes (gateway ${w.gateway.maxSteps}/${w.gateway.maxCostUsd}, ${w.pushes.length} pushes)`);

  // A value back to its default is removed from settings.json.
  await w.elsewhere({ maxSteps: 0 });
  await sleep(5);
  ok(w.writes.at(-1)?.key === 'maxSteps' && w.writes.at(-1)?.value === undefined && w.pushes.length === 0, 'back to the default: the setting is removed, nothing pushed');

  // A change in VS Code: one patch of that key, and its config event writes nothing.
  const wb = w.writes.length;
  await w.edit('reflectEvery', 9);
  await sleep(5);
  ok(w.pushes.length === 1 && JSON.stringify(w.pushes[0]) === '{"reflectEvery":9}' && w.writes.length === wb && w.gateway.reflectEvery === 9, `VS Code edit → one patch of that key, no write back (${JSON.stringify(w.pushes)})`);
  await w.edit('reflectEvery', 9);
  ok(w.pushes.length === 1, 'an edit that leaves the value as the gateway has it pushes nothing');

  // The model picker's three writes, with the gateway's events arriving only after all three.
  w = world({ delayEvents: true });
  await w.sync.connected({ config: w.gateway, configSaved: true });
  await w.edit('provider', 'openai-compatible');
  await w.edit('baseUrl', 'https://api.x.ai/v1');
  await w.edit('model', 'grok-4.6');
  await w.deliver();
  await sleep(5);
  await w.deliver();
  ok(w.pushes.length === 3 && w.writes.length === 0 && w.gateway.model === 'grok-4.6' && w.gateway.baseUrl === 'https://api.x.ai/v1' && same(w.gateway, w.settings), `three quick edits, late events: 3 pushes, nothing written back, both end on grok-4.6 (${w.writes.map((x) => `${x.key}=${String(x.value)}`).join() || 'no writes'})`);

  // A bad value typed into settings.json does not block a good one next to it.
  w = world();
  await w.sync.connected({ config: w.gateway, configSaved: true });
  (w.settings as any).effort = 'extreme';
  w.settings.maxSteps = 7;
  await w.sync.settingsChanged((s) => s === 'deskfish.effort' || s === 'deskfish.maxSteps');
  ok(w.gateway.maxSteps === 7 && w.gateway.effort === '' && w.logs.length === 1 && /bad value for effort/.test(w.logs[0]) && /deskfish\.effort not applied/.test(w.logs[0]), `refused as a whole, then key by key: maxSteps applied, effort logged once (${w.logs.join(' | ')})`);
}

// ---------- 4. the schedule form ----------
{
  ok(parseBudget('') === undefined && parseBudget('  ') === undefined, 'an empty budget: the setting');
  ok(parseBudget('1.5') === 1.5 && parseBudget('$2') === 2 && parseBudget('0') === 0, 'a budget in dollars ($ allowed, 0 = none)');
  ok(parseBudget('-1') === 'bad' && parseBudget('two') === 'bad', 'a negative or wordy budget is refused');
  ok(JSON.stringify(whenFromFields({ kind: 'once', at: '2030-01-02T07:30' })) === '{"when":{"kind":"once","at":"2030-01-02T07:30"}}', 'once from datetime-local');
  ok(JSON.stringify(whenFromFields({ kind: 'once', at: '2030-01-02T07:30:15' })) === '{"when":{"kind":"once","at":"2030-01-02T07:30"}}', 'seconds from a datetime-local are dropped');
  ok(JSON.stringify(whenFromFields({ kind: 'weekly', day: '1', time: '07:00' })) === '{"when":{"kind":"weekly","day":1,"time":"07:00"}}', 'weekly: the day as a number');
  ok(JSON.stringify(whenFromFields({ kind: 'daily', time: '09:00' })) === '{"when":{"kind":"daily","time":"09:00"}}' && JSON.stringify(whenFromFields({ kind: 'every', minutes: '90' })) === '{"when":{"kind":"every","minutes":90}}', 'daily and every');
  ok('error' in whenFromFields({ kind: 'every', minutes: '4' }) && 'error' in whenFromFields({ kind: 'once', at: '' }) && 'error' in whenFromFields({ kind: 'daily', time: '' }) && 'error' in whenFromFields({ kind: 'weekly', day: '7', time: '07:00' }), 'what is missing is named, not sent');
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(inAnHour()), 'once proposes the next full hour in datetime-local form');
}

// ---------- 5. the real gateway ----------
const listen = (server: http.Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
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
    return reply({ success: true });
  });
});
const daemonUrl = `http://127.0.0.1:${await listen(daemon)}`;
const atModel: { model: string; text: string }[] = [];
const model = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    atModel.push({ model: body.model, text: JSON.stringify(body.messages ?? []) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
});
const baseUrl = `http://127.0.0.1:${await listen(model)}/v1`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-settings-'));
const probe = async () => { try { return (await fetch(daemonUrl + '/')).ok; } catch { return false; } };
const service = new DeskfishService({
  dataDir, resourceDir: ROOT,
  config: { ...DEFAULT_CONFIG, provider: 'openai-compatible', baseUrl, model: 'model-a', reflectEvery: 0, ledgerEvery: 0, ledgerTokens: 0, promptCaching: 'off', screenshotWidth: 320, settleMs: 0, daemonUrl, autoStart: false, screen: '320x200x24' },
  createEngine: () => ({ isHealthy: probe, start: async () => {}, stop: async () => {}, inspectNetworkMode: async () => 'isolated' as const, networkMode: 'isolated' as const }),
});
service.setKey('deskfish.apiKey.127.0.0.1', 'k');
service.init();
const TOKEN = 'b'.repeat(64);
const server = new GatewayServer({ service, token: TOKEN, port: 0 });
const url = `http://127.0.0.1:${await server.listen()}`;
const clients: GatewayClient[] = [];
const newClient = (kind: 'vscode' | 'web' = 'web') => { const c = new GatewayClient({ url, token: TOKEN, client: kind as any, version: 'test' }); clients.push(c); return c; };
try {
  ok(validate({ id: 1, cmd: 'config.schema' }).ok && !validate({ id: 1, cmd: 'config.schema', args: { all: true } }).ok, 'config.schema takes no arguments');
  const vscode = newClient('vscode');
  const snap = await vscode.connect();
  ok(snap.configSaved === false, 'a fresh service: configSaved false (a client seeds it)');
  const schema = await vscode.call('config.schema');
  ok(JSON.stringify(schema) === JSON.stringify(settingsSchema(pkg)) && schema.length === 31, `config.schema answers the schema from package.json (${schema.length} entries)`);

  const web = newClient('web');
  await web.connect();
  const vscodeHeard: DeskfishConfig[] = [];
  vscode.on('config', (c: DeskfishConfig) => vscodeHeard.push(c));
  const set = await web.call('config.set', { patch: { model: 'model-b' } });
  ok(set.model === 'model-b' && set.baseUrl === baseUrl, 'the web page sets the model');
  await until(() => vscodeHeard.length > 0, 'the config event at the other client');
  ok(vscodeHeard[0].model === 'model-b', 'the other client hears it');
  ok((await vscode.refreshSnapshot()).configSaved === true, 'after config.set: configSaved true');
  await assert.rejects(web.call('config.set', { patch: { maxSteps: 'many' } as any }), /bad value for maxSteps/); n++;

  // The run from VS Code goes out on the model the web page chose: nothing is pushed before a run any more.
  const done = () => new Promise<void>((resolve) => { const f = (e: any) => { if (e.type === 'status' && e.status === 'done') { vscode.off('event', f); resolve(); } }; vscode.on('event', f); });
  let finished = done();
  await vscode.run('SETTINGS-RUN say hello');
  await finished;
  ok(atModel.length >= 1 && atModel.every((r) => r.model === 'model-b'), `the request that reached the model names model-b (${atModel.map((r) => r.model).join()})`);

  // Schedules over the wire: add with and without the fence, list, a bad budget, run now, remove.
  const plain = await web.call('schedules.add', { task: 'SCHED-PLAIN water the plants', when: { kind: 'daily', time: '09:00' } });
  ok(plain.maxCostUsd === undefined && plain.autonomy === undefined, 'added without a budget: none stored (the setting applies)');
  const addArgs = { task: 'SCHED-FENCED check the mail', when: { kind: 'every' as const, minutes: 30 }, autonomy: 'free' as const, maxCostUsd: 1.5 };
  ok(validate({ id: 2, cmd: 'schedules.add', args: addArgs }).ok, 'the form with a budget passes the validator');
  const fenced = await web.call('schedules.add', addArgs);
  ok(fenced.maxCostUsd === 1.5 && fenced.autonomy === 'free', 'added with a budget and free');
  const listed = await vscode.call('schedules.list');
  ok(listed.schedules.length === 2 && listed.lines.length === 2 && /SCHED-FENCED.*· free · budget \$1\.50/.test(listed.lines[1]) && !/budget/.test(listed.lines[0]), `listed with the fence in the line: ${listed.lines.join(' | ')}`);
  await assert.rejects(web.call('schedules.add', { ...addArgs, maxCostUsd: -1 }), /budget/); n++;
  await assert.rejects(web.call('schedules.add', { ...addArgs, maxCostUsd: '2' as any }), /maxCostUsd must be number/); n++;
  const fired: any[] = [];
  vscode.on('schedule', (s: any) => fired.push(s));
  const before = atModel.length;
  finished = done();
  await web.call('schedules.runNow', { id: plain.id });
  await finished;
  ok(fired.some((s) => s.kind === 'fired' && s.auto === false && s.task === 'SCHED-PLAIN water the plants'), 'run now: a fired schedule event, not automatic');
  ok(atModel.length > before && atModel.slice(before).some((r) => r.text.includes('SCHED-PLAIN')), 'run now reached the model with its task');
  await web.call('schedules.remove', { id: plain.id });
  const after = await web.call('schedules.list');
  ok(after.schedules.length === 1 && after.schedules[0].id === fenced.id, 'removed');
} finally {
  for (const c of clients) c.close();
  await server.close();
  service.dispose();
  daemon.close();
  model.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`settings: ${n} checks passed`);
process.exit(0);
