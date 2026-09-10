// Schedules: due-time arithmetic for each kind, grace vs missed, settle-once semantics, one-offs
// spent, persistence. "She was busy" is the controller's pending set, not the store's concern.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduleStore, nextDueAfter, lastDueAtOrBefore, describeWhen, formatLocal } from '../src/agent/schedule';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-sched-'));
const file = path.join(dir, 'schedules.json');
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();
const MIN = 60_000;

// Monday 2026-09-07 is a Monday.
const monday0700 = local(2026, 9, 7, 7, 0);
const store = new ScheduleStore(file);
const coffee = store.add('order my usual coffee', { kind: 'weekly', day: 1, time: '07:00' }, local(2026, 9, 6, 20, 0));
const night = store.add('check the ads', { kind: 'daily', time: '22:00' }, local(2026, 9, 6, 20, 0));
const once = store.add('send the report', { kind: 'once', at: '2026-09-07T22:00' }, local(2026, 9, 6, 20, 0));
const every = store.add('glance at the inbox', { kind: 'every', minutes: 90 }, local(2026, 9, 6, 20, 0));

ok(describeWhen(coffee.when) === 'every Monday at 07:00' && describeWhen(night.when) === 'every day at 22:00' && describeWhen(once.when) === 'once on 2026-09-07 at 22:00' && describeWhen(every.when) === 'every 90 min', 'describeWhen');
ok(nextDueAfter(coffee, local(2026, 9, 6, 20, 0)) === monday0700, 'weekly: next Monday 07:00 from Sunday evening');
ok(nextDueAfter(coffee, monday0700) === monday0700 + 7 * 24 * 60 * MIN, 'weekly: at the due minute, next is the week after');
ok(nextDueAfter(night, local(2026, 9, 6, 20, 0)) === local(2026, 9, 6, 22, 0) && nextDueAfter(night, local(2026, 9, 6, 22, 30)) === local(2026, 9, 7, 22, 0), 'daily: today if still ahead, else tomorrow');
ok(nextDueAfter(every, local(2026, 9, 6, 20, 0)) === local(2026, 9, 6, 21, 30), 'every 90 min from creation');
ok(lastDueAtOrBefore(coffee, local(2026, 9, 7, 7, 3)) === monday0700 && lastDueAtOrBefore(coffee, local(2026, 9, 6, 20, 0)) === monday0700 - 7 * 24 * 60 * MIN, 'weekly: last due at or before');
ok(lastDueAtOrBefore(once, local(2026, 9, 7, 21, 0)) === undefined && lastDueAtOrBefore(once, local(2026, 9, 7, 22, 1)) === local(2026, 9, 7, 22, 0), 'once: due only after its time');

// Nothing due Sunday evening (occurrences from before creation do not count).
ok(store.due(local(2026, 9, 6, 20, 30), 5 * MIN).length === 0, 'nothing due Sunday 20:30');
// 21:30: the every-90-min one is due (within grace).
{
  const d = store.due(local(2026, 9, 6, 21, 31), 5 * MIN);
  ok(d.length === 1 && d[0].schedule.id === every.id && d[0].verdict === 'fire', `every: fires within grace (${JSON.stringify(d.map((x) => [x.schedule.task, x.verdict]))})`);
  store.settle(every.id, d[0].dueAt, 'fired', local(2026, 9, 6, 21, 31));
  ok(store.due(local(2026, 9, 6, 21, 32), 5 * MIN).length === 0, 'settled occurrence does not fire again');
}
// 22:00 Sunday: the daily one (the once is Monday).
{
  const d = store.due(local(2026, 9, 6, 22, 0), 5 * MIN);
  ok(d.length === 1 && d[0].schedule.id === night.id, 'daily due at 22:00');
  store.settle(night.id, d[0].dueAt, 'fired', local(2026, 9, 6, 22, 0));
}
// Monday 07:40, Deskfish only sees the moment now (laptop was off): coffee is MISSED, not fired.
{
  const d = store.due(local(2026, 9, 7, 7, 40), 5 * MIN);
  const c = d.find((x) => x.schedule.id === coffee.id);
  ok(c && c.verdict === 'missed' && c.dueAt === monday0700, `coffee missed when Deskfish came back late (${JSON.stringify(d.map((x) => [x.schedule.task, x.verdict]))})`);
  store.settle(coffee.id, c!.dueAt, 'missed', local(2026, 9, 7, 7, 40));
  ok(store.get(coffee.id)?.lastOutcome === 'missed', 'missed recorded');
  ok(nextDueAfter(store.get(coffee.id)!, local(2026, 9, 7, 7, 40)) === monday0700 + 7 * 24 * 60 * MIN, 'next Monday still scheduled');
}
// Next Monday 07:12 with no tick in between (laptop asleep with VS Code open): missed, not run late.
{
  const d = store.due(monday0700 + 7 * 24 * 60 * MIN + 12 * MIN, 5 * MIN);
  const c = d.find((x) => x.schedule.id === coffee.id);
  ok(c && c.verdict === 'missed', 'a due moment slept through is missed even though the process never restarted');
  const e = store.due(monday0700 + 7 * 24 * 60 * MIN + 3 * MIN, 5 * MIN);
  ok(e.find((x) => x.schedule.id === coffee.id)?.verdict === 'fire', 'within the grace → fire');
}
// The once fires Monday 22:00 and is then gone.
{
  const d = store.due(local(2026, 9, 7, 22, 2), 5 * MIN);
  const o = d.find((x) => x.schedule.id === once.id);
  ok(o && o.verdict === 'fire', 'once fires');
  store.settle(once.id, o!.dueAt, 'fired', local(2026, 9, 7, 22, 2));
  ok(!store.get(once.id), 'once is spent after firing');
}
// Persistence + validation.
{
  const again = new ScheduleStore(file);
  ok(again.list().length === 3 && again.get(coffee.id)?.lastOutcome === 'missed', 'reloaded from disk with history');
  assert.throws(() => again.add('x', { kind: 'daily', time: '25:00' }), /HH:MM|range/);
  assert.throws(() => again.add('x', { kind: 'once', at: '2020-01-01T10:00' }, local(2026, 9, 7, 9, 0)), /already passed/);
  assert.throws(() => again.add('x', { kind: 'every', minutes: 1 }), /at least 5/);
  assert.throws(() => again.add('   ', { kind: 'daily', time: '10:00' }), /empty/);
  n += 4;
  const lines = again.describe(local(2026, 9, 7, 9, 0));
  ok(lines.length === 3 && lines.some((l) => l.startsWith('every Monday at 07:00 — order my usual coffee · next 2026-09-14 07:00 · last missed 2026-09-07 07:00')), `describe lines: ${lines.join(' | ')}`);
  ok(again.remove(coffee.id) && again.list().length === 2 && !again.remove('nope'), 'remove');
}
ok(formatLocal(monday0700) === '2026-09-07 07:00', 'formatLocal');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`schedule: ${n} checks passed`);
