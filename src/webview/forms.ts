import type { WhenFields } from '../agent/scheduleForm';
import type { DeskfishConfig } from '../gateway/config';
import type { ChatInfo } from '../gateway/protocol';
import type { SettingsEntry } from '../gateway/settingsSchema';

/**
 * The pure parts of the chat view's panels (gateway plan step 6B): the settings form's fields, the
 * schedule form, and the history list's grouping, titles and filter. No DOM, so the tests import them.
 */

/* ---------- settings ---------- */

/** What a settings field holds in the form: its text, or a checkbox's state. */
export type FieldInput = string | boolean;

/** Settings shown as a password field. */
export const SECRET_SETTINGS = new Set<keyof DeskfishConfig>(['daemonToken', 'vncPassword']);

/** Trimmed on save, as VS Code reads them. */
const TRIMMED_SETTINGS = new Set<keyof DeskfishConfig>(['userName', 'anthropicWorkspaceId']);

/** A field's value as the form shows it. */
export function fieldInput(e: SettingsEntry, cfg: DeskfishConfig): FieldInput {
  const v = cfg[e.key];
  if (e.type === 'boolean') return v === true;
  return v === null || v === undefined ? '' : String(v);
}

/** A field's value for the config, or why it cannot be one (an empty number means null only where null is allowed). */
export function readField(e: SettingsEntry, raw: FieldInput): { value: string | number | boolean | null } | { error: string } {
  if (e.type === 'boolean') return { value: raw === true };
  const text = String(raw);
  if (e.type === 'number') {
    if (!text.trim()) return e.nullable ? { value: null } : { error: 'Enter a number.' };
    const n = Number(text);
    return Number.isFinite(n) ? { value: n } : { error: 'Enter a number.' };
  }
  if (e.enum && !e.enum.includes(text)) return { error: `Pick one of: ${e.enum.map((x) => x || 'default').join(', ')}.` };
  return { value: TRIMMED_SETTINGS.has(e.key) ? text.trim() : text };
}

/** The gateway refused a setting: which one (from "bad value for X" / "unknown setting: X") and its words. */
export interface SettingsRefusal {
  key?: keyof DeskfishConfig;
  message: string;
}

export function refusalOf(error: string): SettingsRefusal {
  const m = /(?:bad value for|unknown setting:) (\w+)/.exec(error);
  return m ? { key: m[1] as keyof DeskfishConfig, message: `Not accepted: ${error}.` } : { message: error };
}

/* ---------- schedules ---------- */

/** The schedule form, as the person filled it in. */
export interface ScheduleForm extends WhenFields {
  task: string;
  autonomy: 'free' | 'guided';
  /** Empty: the setting's budget. */
  budget: string;
}

export interface ScheduleRow {
  id: string;
  /** The gateway's own line: when, the task, next, the fence, the last outcome. */
  line: string;
}

/** The two answers of "How much should she decide on her own". */
export const AUTONOMY_DETAILS: Record<'guided' | 'free', string> = {
  guided: 'She asks before anything irreversible and uses no credentials you did not give her — the safer choice for a run nobody is watching.',
  free: 'The tank is the boundary: she may use any account or login in it and finishes what you asked.',
};

/** The line under the budget field: what an empty budget means with this setting. */
export function budgetHint(unattendedMaxCostUsd: number): string {
  return `Empty: the Unattended Max Cost Usd setting (${unattendedMaxCostUsd > 0 ? `$${unattendedMaxCostUsd.toFixed(2)}` : 'no budget'}). 0 = no budget. A budget acts where the model has a known price or reports its cost.`;
}

/* ---------- history ---------- */

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A chat's first task as one line for its row: spaces collapsed, cut at a word before `max` characters. */
export function chatTitle(firstTask: string, max = 70): string {
  const line = firstTask.replace(/\s+/g, ' ').trim();
  if (!line) return '(no task)';
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** The day heading of a chat that started on `day` (YYYY-MM-DD, the gateway's local date), seen on `now`; `short`: "Tue, 15 Sep". */
export function dayLabel(day: string, now: Date, short = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return 'Earlier';
  if (day === dayKey(now)) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day === dayKey(yesterday)) return 'Yesterday';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const cut = (name: string) => (short ? name.slice(0, 3) : name);
  return `${cut(WEEKDAY_NAMES[d.getDay()])}, ${d.getDate()} ${cut(MONTH_NAMES[d.getMonth()])}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`}`;
}

export interface ChatGroup {
  label: string;
  chats: ChatInfo[];
}

/** Chats (newest first, as `chats.list` gives them) grouped by the day they started: Today, Yesterday, then dates. */
export function groupChats(chats: readonly ChatInfo[], now: Date): ChatGroup[] {
  const groups: ChatGroup[] = [];
  for (const c of chats) {
    const label = dayLabel(c.startedAt.slice(0, 10), now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.chats.push(c);
    else groups.push({ label, chats: [c] });
  }
  return groups;
}

/** The chats whose title holds every word typed in the filter (any case); an empty filter keeps all. */
export function filterChats(chats: readonly ChatInfo[], query: string): ChatInfo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...chats];
  return chats.filter((c) => {
    const title = c.firstTask.toLowerCase();
    return words.every((w) => title.includes(w));
  });
}

/** A row's outcome, in words. */
export function outcomeLabel(outcome: ChatInfo['outcome']): string {
  switch (outcome) {
    case 'done':
      return 'Done';
    case 'stopped':
      return 'Stopped';
    case 'error':
      return 'Error';
    case 'needs_user':
      return 'Needed you';
    default:
      return 'Unfinished';
  }
}

/** The slim bar over a past chat: "Past chat · Mon, 14 Sep · 09:12". */
export function pastChatLine(info: ChatInfo, now: Date): string {
  const day = dayLabel(info.startedAt.slice(0, 10), now, true);
  const time = info.startedAt.slice(11, 16);
  return `Past chat · ${day}${time ? ` · ${time}` : ''}`;
}
