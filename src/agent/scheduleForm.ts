import type { When } from './schedule';

/**
 * The questions "Schedule a task" asks, as both hosts ask them: VS Code one input box at a time, the
 * web page as one form. Pure, with no `fs` (the page bundles it); the gateway checks everything again.
 */

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A budget typed by a person: empty → undefined (the setting applies), a number of dollars ≥ 0, or 'bad'. */
export function parseBudget(text: string): number | undefined | 'bad' {
  const t = text.trim().replace(/^\$\s*/, '');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : 'bad';
}

export interface WhenFields {
  kind: When['kind'];
  /** `once`: a `datetime-local` value, YYYY-MM-DDTHH:MM (a space instead of the T is accepted). */
  at?: string;
  /** `daily`, `weekly`: HH:MM. */
  time?: string;
  /** `weekly`: 0 (Sunday) … 6. */
  day?: string | number;
  /** `every`: minutes between runs. */
  minutes?: string | number;
}

/** The `when` of a schedule from the form's fields, or what is missing in words. */
export function whenFromFields(f: WhenFields): { when: When } | { error: string } {
  const time = (f.time ?? '').trim();
  switch (f.kind) {
    case 'once': {
      const at = (f.at ?? '').trim().replace(' ', 'T').slice(0, 16);
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at) ? { when: { kind: 'once', at } } : { error: 'Pick a date and a time.' };
    }
    case 'daily':
      return /^\d{1,2}:\d{2}$/.test(time) ? { when: { kind: 'daily', time } } : { error: 'Pick a time of day.' };
    case 'weekly': {
      const day = Number(f.day);
      if (!Number.isInteger(day) || day < 0 || day > 6) return { error: 'Pick a day of the week.' };
      return /^\d{1,2}:\d{2}$/.test(time) ? { when: { kind: 'weekly', day, time } } : { error: 'Pick a time of day.' };
    }
    case 'every': {
      const minutes = Number(f.minutes);
      return Number.isInteger(minutes) && minutes >= 5 ? { when: { kind: 'every', minutes } } : { error: 'Minutes between runs: a whole number, at least 5.' };
    }
    default:
      return { error: 'Pick when it runs.' };
  }
}

/** The local YYYY-MM-DDTHH:00 an hour from `now` (what both hosts propose for "once"). */
export function inAnHour(now = new Date()): string {
  const d = new Date(now.getTime() + 60 * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}
