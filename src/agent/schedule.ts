import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Schedules: tasks that start themselves. Pure Node — the store, the "when is it due" arithmetic
 * and the fired/missed bookkeeping live here; the extension owns the timer and starts the runs.
 *
 * A schedule fires when Deskfish is running at the due moment (VS Code open, extension loaded).
 * If the bot is busy then, the run waits for her to finish and still happens. If Deskfish was not
 * running at the due moment and comes back later than the grace, the occurrence is *missed* and
 * recorded as such — a coffee ordered forty minutes late is not what was asked. Every occurrence
 * is remembered by its due time, so a reload cannot fire it twice.
 */

export type When =
  | { kind: 'once'; at: string } // local ISO "YYYY-MM-DDTHH:MM"
  | { kind: 'daily'; time: string } // "HH:MM"
  | { kind: 'weekly'; day: number; time: string } // day 0 = Sunday … 6 = Saturday
  | { kind: 'every'; minutes: number };

export interface Schedule {
  id: string;
  task: string;
  when: When;
  createdAt: string;
  /**
   * The fence on a run nobody is watching (gateway plan, step 5). Both optional so a
   * `schedules.json` written before them still loads: without them a fired schedule runs
   * `guided` on `deskfish.unattendedMaxCostUsd`.
   */
  autonomy?: 'free' | 'guided';
  /** Cost budget in USD for this schedule's runs; 0 = none. */
  maxCostUsd?: number;
  /** Due time (ms since epoch) of the last occurrence that was fired or missed. */
  lastDueAt?: number;
  lastOutcome?: 'fired' | 'missed';
  lastAt?: string;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseHm(time: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) throw new Error(`time must be HH:MM, got "${time}"`);
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) throw new Error(`time out of range: "${time}"`);
  return { h, m: mm };
}

function atLocal(base: Date, h: number, m: number, dayOffset = 0): number {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, h, m, 0, 0);
  return d.getTime();
}

/** Parse a local "YYYY-MM-DDTHH:MM" (or "YYYY-MM-DD HH:MM"). */
export function parseLocal(at: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m) throw new Error(`date must be YYYY-MM-DD HH:MM, got "${at}"`);
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
  if (Number.isNaN(t)) throw new Error(`not a date: "${at}"`);
  return t;
}

export function validateWhen(when: When): void {
  switch (when.kind) {
    case 'once':
      parseLocal(when.at);
      return;
    case 'daily':
      parseHm(when.time);
      return;
    case 'weekly':
      if (!Number.isInteger(when.day) || when.day < 0 || when.day > 6) throw new Error('weekday must be 0 (Sunday) to 6 (Saturday)');
      parseHm(when.time);
      return;
    case 'every':
      if (!Number.isFinite(when.minutes) || when.minutes < 5) throw new Error('"every" needs at least 5 minutes');
      return;
  }
}

/** The most recent due time at or before `now` (ms), or undefined if none yet. */
export function lastDueAtOrBefore(s: Schedule, now: number): number | undefined {
  const base = new Date(now);
  switch (s.when.kind) {
    case 'once': {
      const t = parseLocal(s.when.at);
      return t <= now ? t : undefined;
    }
    case 'daily': {
      const { h, m } = parseHm(s.when.time);
      const today = atLocal(base, h, m);
      return today <= now ? today : atLocal(base, h, m, -1);
    }
    case 'weekly': {
      const { h, m } = parseHm(s.when.time);
      const offset = (base.getDay() - s.when.day + 7) % 7;
      const thisWeek = atLocal(base, h, m, -offset);
      return thisWeek <= now ? thisWeek : atLocal(base, h, m, -offset - 7);
    }
    case 'every': {
      const start = Date.parse(s.createdAt);
      const step = s.when.minutes * 60_000;
      if (now < start + step) return undefined;
      return start + Math.floor((now - start) / step) * step;
    }
  }
}

/** The next due time strictly after `now`, or undefined when a one-off is spent. */
export function nextDueAfter(s: Schedule, now: number): number | undefined {
  const base = new Date(now);
  switch (s.when.kind) {
    case 'once': {
      const t = parseLocal(s.when.at);
      return t > now && s.lastDueAt !== t ? t : undefined;
    }
    case 'daily': {
      const { h, m } = parseHm(s.when.time);
      const today = atLocal(base, h, m);
      return today > now ? today : atLocal(base, h, m, 1);
    }
    case 'weekly': {
      const { h, m } = parseHm(s.when.time);
      const offset = (s.when.day - base.getDay() + 7) % 7;
      const candidate = atLocal(base, h, m, offset);
      return candidate > now ? candidate : atLocal(base, h, m, offset + 7);
    }
    case 'every': {
      const start = Date.parse(s.createdAt);
      const step = s.when.minutes * 60_000;
      const n = Math.floor(Math.max(0, now - start) / step) + 1;
      return start + n * step;
    }
  }
}

/** "every Monday at 07:00", "daily at 22:00", "once on 2026-09-07 at 22:00", "every 90 min". */
export function describeWhen(when: When): string {
  switch (when.kind) {
    case 'once':
      return `once on ${when.at.replace('T', ' at ')}`;
    case 'daily':
      return `every day at ${when.time}`;
    case 'weekly':
      return `every ${DAY_NAMES[when.day]} at ${when.time}`;
    case 'every':
      return when.minutes % 60 === 0 ? `every ${when.minutes / 60} hour${when.minutes === 60 ? '' : 's'}` : `every ${when.minutes} min`;
  }
}

export function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type DueVerdict = { schedule: Schedule; dueAt: number; verdict: 'fire' | 'missed' };

export class ScheduleStore {
  private items: Schedule[] = [];

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(raw) ? raw.filter((x) => x && typeof x.id === 'string' && typeof x.task === 'string' && x.when) : [];
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2) + '\n');
  }

  list(): Schedule[] {
    return this.items.map((s) => ({ ...s }));
  }

  get(id: string): Schedule | undefined {
    const s = this.items.find((x) => x.id === id);
    return s ? { ...s } : undefined;
  }

  add(task: string, when: When, now = Date.now(), fence: { autonomy?: 'free' | 'guided'; maxCostUsd?: number } = {}): Schedule {
    const text = task.trim();
    if (!text) throw new Error('the task is empty');
    validateWhen(when);
    if (when.kind === 'once' && parseLocal(when.at) <= now) throw new Error('that time has already passed');
    if (fence.autonomy !== undefined && fence.autonomy !== 'free' && fence.autonomy !== 'guided') throw new Error('autonomy must be free or guided');
    if (fence.maxCostUsd !== undefined && (!Number.isFinite(fence.maxCostUsd) || fence.maxCostUsd < 0)) throw new Error('the budget must be a number of dollars, 0 or more');
    const s: Schedule = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, task: text, when, createdAt: new Date(now).toISOString(), ...(fence.autonomy ? { autonomy: fence.autonomy } : {}), ...(fence.maxCostUsd !== undefined ? { maxCostUsd: fence.maxCostUsd } : {}) };
    this.items.push(s);
    this.save();
    return { ...s };
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((s) => s.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }

  /**
   * Occurrences that are due now and not yet settled. `fire` when the due moment is within the
   * grace; `missed` otherwise — a laptop that slept through the due moment (or a closed VS Code)
   * must not run the task hours late. "She was busy at the due moment" is the caller's business:
   * it sees the occurrence within the grace, keeps it pending, and fires it when she is free.
   * Each occurrence is settled exactly once (by due time).
   */
  due(now: number, graceMs: number): DueVerdict[] {
    const out: DueVerdict[] = [];
    for (const s of this.items) {
      const dueAt = lastDueAtOrBefore(s, now);
      if (dueAt === undefined || s.lastDueAt === dueAt) continue;
      if (s.lastDueAt !== undefined && dueAt < s.lastDueAt) continue;
      if (dueAt < Date.parse(s.createdAt)) continue; // an occurrence from before the schedule existed
      out.push({ schedule: { ...s }, dueAt, verdict: now - dueAt <= graceMs ? 'fire' : 'missed' });
    }
    return out;
  }

  settle(id: string, dueAt: number, outcome: 'fired' | 'missed', now = Date.now()): void {
    const s = this.items.find((x) => x.id === id);
    if (!s) return;
    s.lastDueAt = dueAt;
    s.lastOutcome = outcome;
    s.lastAt = new Date(now).toISOString();
    if (s.when.kind === 'once') this.items = this.items.filter((x) => x.id !== id); // spent
    this.save();
  }

  /** One line per schedule, for the list command and the chat. */
  describe(now = Date.now()): string[] {
    return this.items.map((s) => {
      const next = nextDueAfter(s, now);
      const last = s.lastOutcome ? ` · last ${s.lastOutcome}${s.lastDueAt ? ` ${formatLocal(s.lastDueAt)}` : ''}` : '';
      // The fence is part of what a schedule is: shown only when it differs from the default (guided, the setting's budget).
      const fence = `${s.autonomy === 'free' ? ' · free' : ''}${s.maxCostUsd !== undefined ? ` · budget $${s.maxCostUsd.toFixed(2)}` : ''}`;
      return `${describeWhen(s.when)} — ${s.task}${next ? ` · next ${formatLocal(next)}` : ''}${fence}${last}`;
    });
  }
}
