// The watch list's store (src/agent/watch.ts), pure: validation, the due arithmetic, the four
// outcomes of a check (the first is a baseline), the cooldown, the day counter and its reset, expiry,
// persistence across a reload, and describeCheck. No network and no service: the tick, the fetch and
// the runs are service.test.mts's. Tests named "H<n> …" are the ones ADR-0001's table names.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/gateway/protocol';
import { WatchStore, describeCheck, hashBody, localDay, validateCheck, DEFAULT_COOLDOWN_MINUTES } from '../src/agent/watch';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const names: string[] = [];
function test(name: string, fn: () => void): void {
  fn();
  names.push(name);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-watch-'));
const file = path.join(dir, 'watches.json');
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();
const MIN = 60_000;
const URL_A = 'https://example.org/releases.atom';
const t0 = local(2026, 11, 13, 9, 0);
const H = (s: string) => hashBody(Buffer.from(s));

try {
  test('store: describeCheck says how often and what', () => {
    ok(describeCheck({ kind: 'url', url: URL_A, everyMinutes: 30 }) === `every 30 min: ${URL_A}`, 'minutes');
    ok(describeCheck({ kind: 'url', url: URL_A, everyMinutes: 120 }) === `every 2 hours: ${URL_A}`, 'hours');
    ok(describeCheck({ kind: 'url', url: URL_A, everyMinutes: 60 }) === `every 1 hour: ${URL_A}`, 'one hour');
  });

  test('store: a new item has the defaults and no bookkeeping', () => {
    const s = new WatchStore(file);
    const w = s.add('  read the newest entry  ', { kind: 'url', url: URL_A, everyMinutes: 30 }, t0);
    ok(w.task === 'read the newest entry' && w.cooldownMinutes === DEFAULT_COOLDOWN_MINUTES && w.trips === 0 && w.tripsToday === 0, 'trimmed task, cooldown 60, no trips');
    ok(w.baseline === undefined && w.lastCheckedAt === undefined && w.autonomy === undefined && w.maxCostUsd === undefined, 'no baseline, never checked, the default fence');
    s.remove(w.id);
  });

  test('store: due is "never checked, or the interval has passed", and never a paused item', () => {
    const s = new WatchStore(file);
    const w = s.add('t', { kind: 'url', url: URL_A, everyMinutes: 30 }, t0);
    ok(s.due(t0).some((x) => x.id === w.id), 'never checked: due at once');
    s.settleCheck(w.id, { hash: H('a') }, t0);
    ok(!s.due(t0 + 29 * MIN).some((x) => x.id === w.id), 'not due before 30 min');
    ok(s.due(t0 + 30 * MIN).some((x) => x.id === w.id), 'due at 30 min');
    s.setPaused(w.id, true);
    ok(!s.due(t0 + 90 * MIN).some((x) => x.id === w.id) && s.get(w.id)!.paused === true, 'paused: never due');
    s.setPaused(w.id, false);
    ok(s.due(t0 + 90 * MIN).some((x) => x.id === w.id) && s.get(w.id)!.paused === undefined, 'resumed: due again');
    s.remove(w.id);
  });

  test("store: a check's four outcomes, the first one a baseline", () => {
    const s = new WatchStore(file);
    const w = s.add('t', { kind: 'url', url: URL_A, everyMinutes: 5 }, t0);
    const r1 = s.settleCheck(w.id, { hash: H('one') }, t0);
    ok(r1.outcome === 'baseline' && r1.since === undefined && s.get(w.id)!.baseline === H('one'), 'first: baseline, kept');
    const r2 = s.settleCheck(w.id, { hash: H('one') }, t0 + 5 * MIN);
    ok(r2.outcome === 'same' && r2.since === t0, 'same body: same');
    const r3 = s.settleCheck(w.id, { error: 'the address answered 500' }, t0 + 10 * MIN);
    ok(r3.outcome === 'error' && s.get(w.id)!.baseline === H('one') && s.get(w.id)!.lastError === 'the address answered 500' && s.get(w.id)!.lastCheckedAt === t0 + 10 * MIN, 'error: recorded, baseline kept, the check counted as run');
    const r4 = s.settleCheck(w.id, { hash: H('two') }, t0 + 15 * MIN);
    ok(r4.outcome === 'changed' && r4.since === t0 + 5 * MIN && s.get(w.id)!.baseline === H('two') && s.get(w.id)!.lastError === undefined, 'changed: new baseline, error cleared, "since" is the last good check');
    ok(/^[0-9a-f]{64}$/.test(s.get(w.id)!.baseline!) && !fs.readFileSync(file, 'utf8').includes('"body"'), 'only the hash is kept, never a body');
    s.remove(w.id);
  });

  test('store: the cooldown runs from the last trip', () => {
    const s = new WatchStore(file);
    const w = s.add('t', { kind: 'url', url: URL_A, everyMinutes: 5 }, t0, { cooldownMinutes: 60 });
    ok(!s.inCooldown(w.id, t0), 'never tripped: no cooldown');
    s.trip(w.id, t0);
    ok(s.inCooldown(w.id, t0 + 59 * MIN) && !s.inCooldown(w.id, t0 + 60 * MIN), 'inside 60 min, then out');
    s.skip(w.id, 'skipped-cooldown', t0 + 10 * MIN);
    ok(s.get(w.id)!.lastOutcome === 'skipped-cooldown' && s.get(w.id)!.trips === 1, 'a skip records the outcome and is not a trip');
    const z = s.add('t', { kind: 'url', url: URL_A, everyMinutes: 5 }, t0, { cooldownMinutes: 0 });
    s.trip(z.id, t0);
    ok(!s.inCooldown(z.id, t0), 'cooldown 0: none');
    s.remove(w.id);
    s.remove(z.id);
  });

  test('store: trips are counted in total and per local day, and the day count starts again', () => {
    const s = new WatchStore(file);
    const a = s.add('a', { kind: 'url', url: URL_A, everyMinutes: 5 }, t0);
    const b = s.add('b', { kind: 'url', url: 'http://localhost:8080/status', everyMinutes: 5 }, t0);
    s.trip(a.id, t0);
    s.trip(a.id, t0 + 2 * 60 * MIN);
    s.trip(b.id, t0 + 3 * 60 * MIN);
    ok(s.get(a.id)!.trips === 2 && s.get(a.id)!.tripsToday === 2 && s.get(a.id)!.tripsDay === localDay(t0), 'two today on a');
    ok(s.tripsOn(t0) === 3, 'three across items today');
    const tomorrow = local(2026, 11, 14, 0, 1);
    ok(s.tripsOn(tomorrow) === 0, 'a new local day: none yet');
    s.settleCheck(a.id, { hash: H('x') }, tomorrow);
    ok(s.get(a.id)!.tripsToday === 0 && s.get(a.id)!.trips === 2 && s.get(a.id)!.tripsDay === localDay(tomorrow), 'the first check of the day resets the day count, not the total');
    s.trip(b.id, tomorrow);
    ok(s.get(b.id)!.tripsToday === 1 && s.get(b.id)!.trips === 2, 'the first trip of the day resets it too');
    s.remove(a.id);
    s.remove(b.id);
  });

  test('store: an item past its expiry is expired', () => {
    const s = new WatchStore(file);
    const w = s.add('t', { kind: 'url', url: URL_A, everyMinutes: 5 }, t0, { expiresAt: '2026-11-13 18:00' });
    ok(s.get(w.id)!.expiresAt === '2026-11-13T18:00', 'stored as YYYY-MM-DDTHH:MM');
    ok(s.expired(local(2026, 11, 13, 17, 59)).length === 0 && s.expired(local(2026, 11, 13, 18, 0)).some((x) => x.id === w.id), 'expired at its time');
    s.remove(w.id);
  });

  test('H1 the watch list survives a reload in watches.json', () => {
    const s = new WatchStore(file);
    const w = s.add('keep me', { kind: 'url', url: URL_A, everyMinutes: 45 }, t0, { autonomy: 'free', maxCostUsd: 1.5, cooldownMinutes: 15 });
    s.settleCheck(w.id, { hash: H('body') }, t0);
    s.trip(w.id, t0 + MIN);
    s.setPaused(w.id, true);
    ok(path.basename(file) === 'watches.json' && fs.existsSync(file), 'written to watches.json');
    const again = new WatchStore(file).get(w.id)!;
    ok(again && again.task === 'keep me' && again.check.url === URL_A && again.check.everyMinutes === 45, 'the item is back after a reload');
    ok(again.autonomy === 'free' && again.maxCostUsd === 1.5 && again.cooldownMinutes === 15 && again.paused === true, 'with its fence, cooldown and pause');
    ok(again.baseline === H('body') && again.trips === 1 && again.lastTripAt === t0 + MIN && again.lastCheckedAt === t0, 'and its bookkeeping');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
    ok(new WatchStore(path.join(dir, 'broken.json')).list().length === 0, 'a broken file loads as an empty list');
    s.remove(w.id);
  });

  test('H10 watch.add is refused in a sentence for a bad field, address or interval', () => {
    // The wire, as the gateway validates every request: exactly the fields watch.add takes, each of its type.
    const good = { task: 't', check: { kind: 'url', url: URL_A, everyMinutes: 30 } };
    const wire = (args: unknown) => validate({ id: 1, cmd: 'watch.add', args });
    ok(wire(good).ok && wire({ ...good, autonomy: 'guided', maxCostUsd: 1, cooldownMinutes: 0, expiresAt: '2026-12-01 09:00' }).ok, 'the form passes the validator');
    const refused = (args: unknown, re: RegExp, what: string) => {
      const v = wire(args);
      ok(!v.ok && re.test(v.error) && /^watch\.add: /.test(v.error), `${what}: ${!v.ok && v.error}`);
    };
    refused({ ...good, every: 30 }, /unknown argument every/, 'an unknown field');
    refused({ ...good, check: { ...good.check, selector: '#price' } }, /check must be a check/, 'an unknown field inside the check');
    refused({ ...good, check: { ...good.check, everyMinutes: '30' } }, /check must be a check/, 'a wrong type inside the check');
    refused({ ...good, check: { kind: 'file', url: URL_A, everyMinutes: 30 } }, /check must be a check/, 'another kind');
    refused({ ...good, cooldownMinutes: 'an hour' }, /cooldownMinutes must be number/, 'a wrong type');
    refused({ ...good, autonomy: 'wild' }, /autonomy must be autonomy/, 'a bad autonomy');
    refused({ check: good.check }, /task must be string/, 'no task');
    // The store, where the gateway turns the rest into a sentence (the server answers it as the error).

    const s = new WatchStore(file);
    const refuses = (fn: () => unknown, re: RegExp, what: string) => {
      try {
        fn();
      } catch (err) {
        ok(re.test((err as Error).message), `${what}: ${(err as Error).message}`);
        return;
      }
      assert.fail(`${what}: not refused`);
    };
    refuses(() => s.add('t', { kind: 'url', url: 'file:///etc/passwd', everyMinutes: 30 }, t0), /only http and https/, 'file: address');
    refuses(() => s.add('t', { kind: 'url', url: 'ftp://example.org/x', everyMinutes: 30 }, t0), /only http and https/, 'ftp: address');
    refuses(() => s.add('t', { kind: 'url', url: 'not an address', everyMinutes: 30 }, t0), /not an address/, 'garbage');
    refuses(() => s.add('t', { kind: 'url', url: 'https://me:secret@example.org/', everyMinutes: 30 }, t0), /no credentials/, 'credentials in the address');
    refuses(() => s.add('t', { kind: 'url', url: URL_A, everyMinutes: 4 }, t0), /every 5 minutes/, 'every 4 min');
    refuses(() => s.add('t', { kind: 'url', url: URL_A, everyMinutes: 30 }, t0, { cooldownMinutes: -1 }), /cooldown/, 'negative cooldown');
    refuses(() => s.add('t', { kind: 'url', url: URL_A, everyMinutes: 30 }, t0, { maxCostUsd: -1 }), /budget/, 'negative budget');
    refuses(() => s.add('t', { kind: 'url', url: URL_A, everyMinutes: 30 }, t0, { expiresAt: '2026-11-13 08:00' }), /already passed/, 'past expiry');
    refuses(() => s.add('   ', { kind: 'url', url: URL_A, everyMinutes: 30 }, t0), /empty/, 'empty task');
    refuses(() => validateCheck({ kind: 'file', url: URL_A, everyMinutes: 30 } as never), /unknown check kind/, 'another kind');
    ok(s.list().length === 0, 'nothing refused was stored');
    ok(validate({ id: 1, cmd: 'watch.list' }).ok && validate({ id: 1, cmd: 'watch.pause', args: { id: 'x', paused: true } }).ok && !validate({ id: 1, cmd: 'watch.pause', args: { id: 'x' } }).ok, 'the other watch commands are on the wire');
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
for (const name of names) console.log(`✓ ${name}`);
console.log(`watch: ${names.length} tests, ${n} checks passed`);
