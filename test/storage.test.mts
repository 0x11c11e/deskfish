// Gateway storage (src/gateway/storage.ts): the data dir per platform and its overrides; the
// secrets file and the gateway token are 0600; the move out of globalStorage copies her files byte
// for byte with the self key, so her signature still verifies, and it is idempotent (a second run
// does nothing, a data dir that already holds a self is never overwritten, a move interrupted
// before the key is finished); an empty data dir seeds exactly as a first start always did.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HER_FILES, SecretsFile, dataDir, ensureToken, migrateData, readToken } from '../src/gateway/storage';
import { DeskfishService } from '../src/gateway/service';
import { SelfStore, newSelfKey } from '../src/agent/self';
import { DEFAULT_SELF } from '../src/agent/seed';
import { STARTER_PLAYBOOKS } from '../src/agent/starter';
import type { DeskfishConfig } from '../src/gateway/config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const mode = (f: string) => fs.statSync(f).mode & 0o777;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-storage-'));

try {
  // 1. data dir per platform
  ok(dataDir({}, 'linux', '/home/a') === '/home/a/.local/share/deskfish', 'linux default');
  ok(dataDir({ XDG_DATA_HOME: '/x/data' }, 'linux', '/home/a') === '/x/data/deskfish', 'linux XDG_DATA_HOME');
  ok(dataDir({}, 'darwin', '/Users/a') === '/Users/a/Library/Application Support/deskfish', 'macOS');
  ok(dataDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a') === 'C:\\Users\\a\\AppData\\Roaming\\deskfish', 'Windows APPDATA');
  ok(dataDir({}, 'win32', 'C:\\Users\\a') === 'C:\\Users\\a\\AppData\\Roaming\\deskfish', 'Windows without APPDATA');
  ok(dataDir({ DESKFISH_HOME: '/srv/her', XDG_DATA_HOME: '/x' }, 'linux', '/home/a') === '/srv/her', 'DESKFISH_HOME wins on linux');
  ok(dataDir({ DESKFISH_HOME: '/srv/her' }, 'darwin', '/Users/a') === '/srv/her', 'DESKFISH_HOME wins on macOS');

  // 2. secrets file and token: 0600, stable
  const dir = path.join(tmp, 'data');
  const secrets = new SecretsFile(path.join(dir, 'secrets.json'));
  ok(secrets.set('deskfish.apiKey.anthropic', 'sk-one') && !secrets.set('deskfish.apiKey.anthropic', 'sk-one'), 'set reports a change only once');
  ok(mode(secrets.file) === 0o600, `secrets.json is 0600 (${mode(secrets.file).toString(8)})`);
  const k = secrets.ensureSelfKey();
  ok(k && secrets.ensureSelfKey() === k && new SecretsFile(secrets.file).selfKey === k, 'the self key is created once and read back from disk');
  ok(secrets.slots().join() === 'deskfish.apiKey.anthropic' && !JSON.stringify(secrets.slots()).includes('sk-one'), 'slots names only');
  secrets.set('deskfish.apiKey.anthropic', '');
  ok(secrets.get('deskfish.apiKey.anthropic') === undefined && secrets.selfKey === k, 'clearing a slot keeps the self key');
  ok(mode(secrets.file) === 0o600, 'still 0600 after a rewrite');
  ok(readToken(dir) === undefined, 'no token before the gateway made one');
  const token = ensureToken(dir);
  const tokenFile = path.join(dir, 'gateway.token');
  ok(/^[0-9a-f]{64}$/.test(token) && ensureToken(dir) === token && readToken(dir) === token, 'token: 32 bytes hex, stable');
  ok(mode(tokenFile) === 0o600, `gateway.token is 0600 (${mode(tokenFile).toString(8)})`);
  fs.chmodSync(tokenFile, 0o644);
  ok(ensureToken(dir) === token && mode(tokenFile) === 0o600, 'a loosened token file is tightened back to 0600');

  // 3. migration out of globalStorage
  const from = path.join(tmp, 'globalStorage');
  const to = path.join(tmp, 'home');
  fs.mkdirSync(path.join(from, 'chats'), { recursive: true });
  const selfKey = newSelfKey();
  const oldSelf = new SelfStore(path.join(from, 'self.md'), selfKey);
  oldSelf.ensureSeed(DEFAULT_SELF);
  ok(oldSelf.revise('What I have learned', 'Recipes are better read twice.').ok, 'her self, revised and signed in globalStorage');
  fs.writeFileSync(path.join(from, 'memory.md'), '# Memory\n\n- the user likes tea\n');
  fs.writeFileSync(path.join(from, 'journal.md'), '# Journal\n\n- 2026-09-01 I hatched today\n');
  fs.writeFileSync(path.join(from, 'journal-state.json'), '{"tasksSinceReflection":2}');
  fs.writeFileSync(path.join(from, 'playbook.md'), '# Playbooks\n');
  fs.writeFileSync(path.join(from, 'charter.md'), 'my charter\n');
  fs.writeFileSync(path.join(from, 'chats', '2026-09-01 10-00 - hello.md'), '# Chat — 2026-09-01 10:00\n');
  const vault: Record<string, string> = { 'deskfish.selfKey': selfKey, 'deskfish.apiKey.anthropic': 'sk-ant', 'deskfish.apiKey.openrouter.ai': 'sk-or' };
  const logs: string[] = [];
  const opts = { from, to, readSecret: async (name: string) => vault[name], slots: ['deskfish.apiKey.anthropic', 'deskfish.apiKey.openrouter.ai', 'deskfish.apiKey.api.x.ai'], selfKeySecret: 'deskfish.selfKey', log: (l: string) => logs.push(l) };

  ok((await migrateData({ ...opts, from: path.join(tmp, 'empty') })) === 'nothing', 'nothing to move when globalStorage has no self');
  ok((await migrateData(opts)) === 'done', 'moved');
  for (const f of [...HER_FILES.filter((f) => fs.existsSync(path.join(from, f))), 'chats/2026-09-01 10-00 - hello.md']) {
    ok(Buffer.compare(fs.readFileSync(path.join(from, f)), fs.readFileSync(path.join(to, f))) === 0, `byte-identical: ${f}`);
  }
  const moved = new SecretsFile(path.join(to, 'secrets.json'));
  ok(moved.selfKey === selfKey && new SelfStore(path.join(to, 'self.md'), moved.selfKey!).load().status === 'ok', 'the self key travelled; her signature verifies in the data dir');
  ok(moved.get('deskfish.apiKey.anthropic') === 'sk-ant' && moved.get('deskfish.apiKey.openrouter.ai') === 'sk-or' && !moved.get('deskfish.apiKey.api.x.ai'), 'API keys copied by slot');
  ok(mode(moved.file) === 0o600, 'the moved secrets are 0600');
  ok(fs.existsSync(path.join(from, 'migrated.json')) && fs.existsSync(path.join(from, 'self.md')), 'marker written; globalStorage keeps its copy');
  ok(logs.length === 1 && /her files moved/.test(logs[0]) && !logs[0].includes('sk-'), `one log line, no keys in it: ${logs[0]}`);
  ok(!fs.readFileSync(path.join(from, 'migrated.json'), 'utf8').includes('sk-'), 'the marker holds no keys');

  // idempotent: the marker stops a second run
  fs.appendFileSync(path.join(to, 'memory.md'), '- a fact learned after the move\n');
  ok((await migrateData(opts)) === 'already' && logs.length === 1, 'a second run does nothing');
  // without the marker, a data dir that already holds a self is never overwritten
  fs.rmSync(path.join(from, 'migrated.json'));
  ok((await migrateData(opts)) === 'kept-existing', 'a data dir with a self is kept');
  ok(fs.readFileSync(path.join(to, 'memory.md'), 'utf8').includes('after the move'), 'nothing in the data dir was overwritten');

  // interrupted after the files, before the key: the next run finishes it
  const to2 = path.join(tmp, 'home2');
  fs.mkdirSync(to2);
  for (const f of ['self.md', 'self.sig']) fs.copyFileSync(path.join(from, f), path.join(to2, f));
  fs.rmSync(path.join(from, 'migrated.json'));
  ok((await migrateData({ ...opts, to: to2 })) === 'done', 'an interrupted move is finished');
  const s2 = new SecretsFile(path.join(to2, 'secrets.json'));
  ok(s2.selfKey === selfKey && fs.existsSync(path.join(to2, 'journal.md')) && new SelfStore(path.join(to2, 'self.md'), selfKey).load().status === 'ok', 'files completed, key set, signature verifies');

  // the service on the moved data dir: no second hatching, the self verifies
  const cfg = { provider: 'mock', model: 'm', baseUrl: '', daemonUrl: 'http://127.0.0.1:9', containerCli: 'auto', screen: '320x200x24', scheduleGraceMinutes: 5 } as DeskfishConfig;
  const journalBefore = fs.readFileSync(path.join(to, 'journal.md'), 'utf8');
  const svc = new DeskfishService({ dataDir: to, resourceDir: ROOT, config: cfg, createEngine: () => ({ isHealthy: async () => false, start: async () => {}, stop: async () => {}, inspectNetworkMode: async () => undefined, networkMode: undefined }) });
  svc.init();
  ok(svc.self.load().status === 'ok' && fs.readFileSync(path.join(to, 'journal.md'), 'utf8') === journalBefore, 'the service opens her as she was: signature ok, no new hatch line');
  svc.dispose();

  // 4. an empty data dir seeds exactly as a first start
  const fresh = path.join(tmp, 'fresh');
  const svc2 = new DeskfishService({ dataDir: fresh, resourceDir: ROOT, config: cfg, createEngine: () => ({ isHealthy: async () => false, start: async () => {}, stop: async () => {}, inspectNetworkMode: async () => undefined, networkMode: undefined }) });
  svc2.init();
  const sk = new SecretsFile(path.join(fresh, 'secrets.json')).selfKey;
  ok(sk && mode(path.join(fresh, 'secrets.json')) === 0o600, 'first start: a self key in secrets.json (0600)');
  ok(fs.readFileSync(path.join(fresh, 'self.md'), 'utf8').trim().startsWith(DEFAULT_SELF.trim().slice(0, 40)) && new SelfStore(path.join(fresh, 'self.md'), sk!).load().status === 'ok', 'first start: the seed self, signed');
  ok(fs.readFileSync(path.join(fresh, 'playbook.md'), 'utf8').trim() === STARTER_PLAYBOOKS.trim(), 'first start: the starter playbooks');
  const hatch = fs.readFileSync(path.join(fresh, 'journal.md'), 'utf8');
  ok((hatch.match(/I hatched today/g) ?? []).length === 1, 'first start: one "I hatched today" line');
  svc2.dispose();
  const svc3 = new DeskfishService({ dataDir: fresh, resourceDir: ROOT, config: cfg, createEngine: () => ({ isHealthy: async () => false, start: async () => {}, stop: async () => {}, inspectNetworkMode: async () => undefined, networkMode: undefined }) });
  svc3.init();
  ok(fs.readFileSync(path.join(fresh, 'journal.md'), 'utf8') === hatch && svc3.self.load().status === 'ok', 'a second start seeds nothing and keeps the same key');
  svc3.dispose();
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`storage: ${n} checks passed`);
process.exit(0);
