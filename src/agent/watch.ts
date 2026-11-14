import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatLocal, parseLocal } from './schedule';

/**
 * The watch list: the heartbeat's store (ADR-0001). Pure Node, modelled on `schedule.ts`: the
 * types, the validation, the "is it due" arithmetic, persistence and the bookkeeping live here; the
 * gateway owns the tick, the fetch and the runs.
 *
 * A watch item is a check the gateway can run without a model, plus the task the user agreed to when
 * the item was made. The check is edge-triggered: the first result is the baseline, and an item trips
 * on the first change after that — "it changed", never what it changed to. The store keeps the hash
 * of the body, never the body.
 */

/** What is checked. `url`: fetch the address every N minutes (at least 5). Later kinds join this union. */
export type WatchCheck = { kind: 'url'; url: string; everyMinutes: number };

export type WatchOutcome = 'fired' | 'skipped-cooldown' | 'skipped-cap' | 'skipped-off' | 'expired';

export interface Watch {
  id: string;
  task: string;
  check: WatchCheck;
  createdAt: string;
  /** The fence on its runs, as on a Schedule: guided and `deskfish.unattendedMaxCostUsd` when unset. */
  autonomy?: 'free' | 'guided';
  maxCostUsd?: number;
  /** Minutes after a trip during which a change is recorded and does not start a run. */
  cooldownMinutes: number;
  /** Local "YYYY-MM-DDTHH:MM", as a one-off schedule's time; the item is removed after it. */
  expiresAt?: string;
  paused?: boolean;
  // Bookkeeping — the gateway's, never the user's.
  /** SHA-256 hex of the last body seen. */
  baseline?: string;
  /** When the last check ran, whatever its result (ms since epoch). */
  lastCheckedAt?: number;
  /** When the baseline was last confirmed by a successful check: the "since" of a trip. */
  lastOkAt?: number;
  /** The last check's error; cleared by the next successful one. */
  lastError?: string;
  trips: number;
  tripsToday: number;
  /** The local day ("YYYY-MM-DD") `tripsToday` counts. */
  tripsDay?: string;
  lastTripAt?: number;
  lastOutcome?: WatchOutcome;
}

/** What a new item may carry besides its task and check. */
export interface WatchOptions {
  autonomy?: 'free' | 'guided';
  maxCostUsd?: number;
  cooldownMinutes?: number;
  expiresAt?: string;
}

export const DEFAULT_COOLDOWN_MINUTES = 60;
export const MIN_EVERY_MINUTES = 5;
export const CHECK_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 1_048_576;

/** The local calendar day of `ms`, "YYYY-MM-DD". */
export function localDay(ms: number): string {
  return formatLocal(ms).slice(0, 10);
}

/** Throws a sentence when the check is not one the gateway can run. */
export function validateCheck(check: WatchCheck): void {
  if (!check || typeof check !== 'object') throw new Error('the check is missing');
  if (check.kind !== 'url') throw new Error(`unknown check kind: ${String((check as { kind?: unknown }).kind)}`);
  let u: URL;
  try {
    u = new URL(String(check.url).trim());
  } catch {
    throw new Error(`that is not an address: "${check.url}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http and https addresses can be watched, not ${u.protocol.replace(/:$/, '')}`);
  if (u.username || u.password) throw new Error('an address with a user name or password in it cannot be watched: a check sends no credentials');
  if (typeof check.everyMinutes !== 'number' || !Number.isFinite(check.everyMinutes) || check.everyMinutes < MIN_EVERY_MINUTES) throw new Error(`a check runs at most every ${MIN_EVERY_MINUTES} minutes`);
}

function describeEvery(minutes: number): string {
  return minutes % 60 === 0 ? `every ${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `every ${minutes} min`;
}

/** "every 30 min: https://example.org/releases.atom" — for the list, the log and the run's note. */
export function describeCheck(check: WatchCheck): string {
  return `${describeEvery(check.everyMinutes)}: ${check.url}`;
}

export type CheckResult = { hash: string } | { error: string };

/** SHA-256 hex of the body bytes: what the store keeps instead of the body. */
export function hashBody(body: Uint8Array): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

/**
 * One `url` check: a GET with no cookies and no credentials, redirects followed, the body read as
 * bytes up to `maxBytes`. A network error, the timeout, a non-2xx status or a body over the cap is
 * an error, never a change. The body is hashed and dropped here; nothing of it leaves this function.
 */
export async function checkUrl(url: string, opts: { timeoutMs?: number; maxBytes?: number; userAgent: string }): Promise<CheckResult> {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', credentials: 'omit', headers: { 'user-agent': opts.userAgent }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { error: `the address answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}` };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return { error: `the page is over ${Math.round(maxBytes / 1024)} KB` };
    }
    const hash = crypto.createHash('sha256');
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          return { error: `the page is over ${Math.round(maxBytes / 1024)} KB` };
        }
        hash.update(value);
      }
    }
    return { hash: hash.digest('hex') };
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { error: `no answer within ${Math.round(timeoutMs / 1000)} s` };
    return { error: `could not reach the address: ${e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err)}` };
  }
}

export class WatchStore {
  private items: Watch[] = [];

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(raw)
        ? raw
            .filter((x) => x && typeof x.id === 'string' && typeof x.task === 'string' && x.check && typeof x.check.url === 'string')
            .map((x) => ({ ...x, cooldownMinutes: typeof x.cooldownMinutes === 'number' ? x.cooldownMinutes : DEFAULT_COOLDOWN_MINUTES, trips: Number(x.trips) || 0, tripsToday: Number(x.tripsToday) || 0 }))
        : [];
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2) + '\n');
  }

  private find(id: string): Watch | undefined {
    return this.items.find((x) => x.id === id);
  }

  list(): Watch[] {
    return this.items.map((w) => ({ ...w, check: { ...w.check } }));
  }

  get(id: string): Watch | undefined {
    const w = this.find(id);
    return w ? { ...w, check: { ...w.check } } : undefined;
  }

  add(task: string, check: WatchCheck, now = Date.now(), opts: WatchOptions = {}): Watch {
    const text = task.trim();
    if (!text) throw new Error('the task is empty');
    validateCheck(check);
    if (opts.autonomy !== undefined && opts.autonomy !== 'free' && opts.autonomy !== 'guided') throw new Error('autonomy must be free or guided');
    if (opts.maxCostUsd !== undefined && (!Number.isFinite(opts.maxCostUsd) || opts.maxCostUsd < 0)) throw new Error('the budget must be a number of dollars, 0 or more');
    if (opts.cooldownMinutes !== undefined && (!Number.isFinite(opts.cooldownMinutes) || opts.cooldownMinutes < 0)) throw new Error('the cooldown must be a number of minutes, 0 or more');
    if (opts.expiresAt !== undefined && opts.expiresAt !== '' && parseLocal(opts.expiresAt) <= now) throw new Error('that expiry has already passed');
    const w: Watch = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      task: text,
      check: { kind: 'url', url: check.url.trim(), everyMinutes: check.everyMinutes },
      createdAt: new Date(now).toISOString(),
      ...(opts.autonomy ? { autonomy: opts.autonomy } : {}),
      ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
      cooldownMinutes: opts.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES,
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt.trim().replace(' ', 'T') } : {}),
      trips: 0,
      tripsToday: 0,
    };
    this.items.push(w);
    this.save();
    return this.get(w.id)!;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((w) => w.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }

  setPaused(id: string, paused: boolean): Watch | undefined {
    const w = this.find(id);
    if (!w) return undefined;
    if (paused) w.paused = true;
    else delete w.paused;
    this.save();
    return this.get(id);
  }

  /** Items whose interval has passed since their last check (or that were never checked), not paused. */
  due(now: number): Watch[] {
    return this.items.filter((w) => !w.paused && (w.lastCheckedAt === undefined || now - w.lastCheckedAt >= w.check.everyMinutes * 60_000)).map((w) => this.get(w.id)!);
  }

  /** Items whose expiry has passed. */
  expired(now: number): Watch[] {
    return this.items.filter((w) => w.expiresAt && parseLocal(w.expiresAt) <= now).map((w) => this.get(w.id)!);
  }

  /**
   * Record a check's result. The first successful one is the `baseline` (no trip, ever, on
   * creation); a different hash is `changed` and becomes the new baseline; an error is recorded and
   * the baseline kept. `since` is when the previous baseline was confirmed: the trip's "since".
   */
  settleCheck(id: string, result: CheckResult, now: number): { outcome: 'baseline' | 'changed' | 'same' | 'error'; since?: number } {
    const w = this.find(id);
    if (!w) return { outcome: 'error' };
    w.lastCheckedAt = now;
    this.rollDay(w, now);
    if ('error' in result) {
      w.lastError = result.error;
      this.save();
      return { outcome: 'error' };
    }
    delete w.lastError;
    const since = w.lastOkAt;
    w.lastOkAt = now;
    let outcome: 'baseline' | 'changed' | 'same';
    if (w.baseline === undefined) outcome = 'baseline';
    else if (w.baseline !== result.hash) outcome = 'changed';
    else outcome = 'same';
    w.baseline = result.hash;
    this.save();
    return { outcome, ...(since !== undefined ? { since } : {}) };
  }

  /** The item's cooldown still runs at `now` (since its last trip). */
  inCooldown(id: string, now: number): boolean {
    const w = this.find(id);
    return !!w && w.lastTripAt !== undefined && now - w.lastTripAt < w.cooldownMinutes * 60_000;
  }

  /** Trips across all items in the local day of `now`. */
  tripsOn(now: number): number {
    const day = localDay(now);
    return this.items.reduce((sum, w) => sum + (w.tripsDay === day ? w.tripsToday : 0), 0);
  }

  /** A trip that starts a run: counted (total and today), and the cooldown starts. */
  trip(id: string, now: number): void {
    const w = this.find(id);
    if (!w) return;
    this.rollDay(w, now);
    w.trips += 1;
    w.tripsToday += 1;
    w.lastTripAt = now;
    w.lastOutcome = 'fired';
    this.save();
  }

  /** A change that started no run, and why. */
  skip(id: string, outcome: Exclude<WatchOutcome, 'fired'>, now: number): void {
    const w = this.find(id);
    if (!w) return;
    this.rollDay(w, now);
    w.lastOutcome = outcome;
    this.save();
  }

  /** `tripsToday` belongs to `tripsDay`; on a new local day it starts again at 0. */
  private rollDay(w: Watch, now: number): void {
    const day = localDay(now);
    if (w.tripsDay !== day) {
      w.tripsDay = day;
      w.tripsToday = 0;
    }
  }

  /** One line per item, for the list command, the panel and the chat. */
  describe(now = Date.now()): string[] {
    const today = localDay(now);
    return this.items.map((w) => {
      const fence = `${w.autonomy === 'free' ? ' · free' : ''}${w.maxCostUsd !== undefined ? ` · budget $${w.maxCostUsd.toFixed(2)}` : ''}`;
      const trips = ` · trips ${w.tripsDay === today ? w.tripsToday : 0} today, ${w.trips} in all`;
      const last = w.lastCheckedAt === undefined ? ' · not checked yet' : ` · checked ${formatLocal(w.lastCheckedAt)}${w.lastError ? ` — error: ${w.lastError}` : ''}`;
      const outcome = w.lastOutcome ? ` · last ${w.lastOutcome}` : '';
      return `${describeCheck(w.check)} — ${w.task}${w.paused ? ' · paused' : ''}${fence}${trips}${last}${outcome}${w.expiresAt ? ` · until ${w.expiresAt.replace('T', ' ')}` : ''}`;
    });
  }
}
