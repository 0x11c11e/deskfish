import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The bot's episodic memory: one line per finished task, written by the loop with no model call,
 * plus the notes the bot leaves for itself mid-task. The last few entries ride in every prompt as
 * "Recently"; older ones are found with the recall tool (keyword search with a recency bonus —
 * the file is a few hundred lines a year, far below anything that needs a vector index).
 *
 * A small state file next to it holds the reflection bookkeeping: how many tasks since the bot
 * last reflected, and the proposals it made about itself that reflection must look at.
 * Pure Node (no `vscode`).
 */

export const RECENT_ENTRIES = 5;
export const MAX_SUMMARY = 420;
export const MAX_TASK_LINE = 120;
/** Reflection is due when the salience of the tasks since the last one adds up to this (or the task count hits reflectEvery). */
export const SALIENCE_THRESHOLD = 12;

/**
 * How much a finished task should weigh in memory, 1–5, from signals the loop already has — the
 * cheap stand-in for "emotional arousal decides what is consolidated" (McGaugh) and for the
 * 1–10 importance rating that triggers reflection in Generative Agents. No model call.
 */
export function salienceOf(info: { steps: number; costUsd?: number; outcome: string; handovers?: number; notes?: number; followUps?: number }): number {
  let s = 1;
  if (info.steps >= 15) s++;
  if (info.steps >= 40 || (info.costUsd ?? 0) >= 1) s++;
  if ((info.handovers ?? 0) > 0 || (info.followUps ?? 0) > 0) s++;
  if ((info.notes ?? 0) > 0 || !/^done/.test(info.outcome)) s++;
  return Math.min(5, s);
}

export interface JournalEntry {
  /** ISO minute, e.g. 2026-09-06 14:02 */
  at: string;
  kind: 'task' | 'note';
  text: string;
}

export interface PendingProposal {
  at: string;
  /** A self revision the bot wanted to make mid-task (deferred to reflection), or a plain note to itself. */
  kind: 'revise_self' | 'note';
  section?: string;
  text: string;
}

export interface JournalState {
  tasksSinceReflection: number;
  /** Sum of the salience of tasks since the last reflection. */
  salienceSinceReflection: number;
  lastReflectionAt?: string;
  /** Number of journal lines already seen by a reflection (entries after it are "new"). */
  reflectedLines: number;
  pending: PendingProposal[];
  /** Hash of the last tampered self text the bot was told about, so it is journaled once. */
  noticedTamper?: string;
  /** How many readings from the library the bot has been given (round-robin index). */
  readings: number;
  /** The bot's answers to the fixed drift questions, one entry per reflection (newest last). */
  drift: { at: string; answers: string[] }[];
}

const HEADER = `# Deskfish journal

One line per finished task (written automatically) and per note the bot left for itself.
Newest at the bottom. The bot reads the last few at the start of every chat and can search
the rest with its recall tool.
`;

type Outcome = { ok: true; message: string } | { ok: false; error: string };

export class JournalStore {
  readonly stateFile: string;

  constructor(readonly file: string) {
    this.stateFile = file.replace(/\.md$/, '') + '-state.json';
  }

  /** One line for a finished task. `summary` is the bot's final message (trimmed to 300 chars). */
  appendTask(info: { task: string; outcome: string; steps: number; costUsd?: number; summary?: string; salience?: number }): JournalEntry {
    const task = oneLine(info.task, MAX_TASK_LINE);
    const summary = oneLine(info.summary ?? '', MAX_SUMMARY);
    const cost = info.costUsd && info.costUsd > 0 ? ` · $${info.costUsd.toFixed(2)}` : '';
    const weight = info.salience && info.salience > 1 ? ` · ${'★'.repeat(Math.min(5, info.salience))}` : '';
    const text = `${info.outcome} · ${info.steps} step${info.steps === 1 ? '' : 's'}${cost}${weight} — Task: ${task}${summary ? ` — ${summary}` : ''}`;
    return this.appendLine('task', text);
  }

  /** A note the bot leaves for itself (shows in Recently and in recall). */
  appendNote(text: string): JournalEntry {
    return this.appendLine('note', oneLine(text, MAX_SUMMARY));
  }

  list(): JournalEntry[] {
    return this.readRaw()
      .split(/\r?\n/)
      .map(parseLine)
      .filter((e): e is JournalEntry => !!e);
  }

  recent(n = RECENT_ENTRIES): JournalEntry[] {
    const all = this.list();
    return all.slice(Math.max(0, all.length - n));
  }

  /** Entries the last reflection has not seen. */
  newSinceReflection(): JournalEntry[] {
    const all = this.list();
    return all.slice(Math.min(this.state().reflectedLines, all.length));
  }

  /**
   * Keyword search: every whitespace-separated term of `query` (3+ chars) scores 1 per hit,
   * plus a small recency bonus; returns the best `limit` entries, oldest first.
   */
  recall(query: string, limit = 8): Outcome {
    const terms = query.toLowerCase().split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}.@/-]/gu, '')).filter((t) => t.length >= 3);
    if (!terms.length) return { ok: false, error: 'recall needs a few words to search for' };
    const all = this.list();
    const scored = all
      .map((e, i) => {
        const hay = e.text.toLowerCase();
        const hits = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
        return { e, score: hits + (hits ? i / Math.max(1, all.length) / 2 : 0) };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .sort((a, b) => a.e.at.localeCompare(b.e.at));
    if (!scored.length) return { ok: false, error: `nothing in your journal matches "${query}"` };
    return { ok: true, message: `From your journal (${scored.length} of ${all.length} entries):\n${scored.map((s) => renderEntry(s.e)).join('\n')}` };
  }

  render(entries: JournalEntry[]): string {
    return entries.map(renderEntry).join('\n');
  }

  /* ---------- reflection bookkeeping ---------- */

  state(): JournalState {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<JournalState>;
      return { tasksSinceReflection: s.tasksSinceReflection ?? 0, salienceSinceReflection: s.salienceSinceReflection ?? 0, lastReflectionAt: s.lastReflectionAt, reflectedLines: s.reflectedLines ?? 0, pending: s.pending ?? [], noticedTamper: s.noticedTamper, readings: s.readings ?? 0, drift: s.drift ?? [] };
    } catch {
      return { tasksSinceReflection: 0, salienceSinceReflection: 0, reflectedLines: 0, pending: [], readings: 0, drift: [] };
    }
  }

  /** Called after a task entry: bumps the counters; returns them. */
  taskFinished(salience = 1): { tasks: number; salience: number } {
    const s = this.state();
    s.tasksSinceReflection += 1;
    s.salienceSinceReflection += Math.max(1, salience);
    this.writeState(s);
    return { tasks: s.tasksSinceReflection, salience: s.salienceSinceReflection };
  }

  addPending(p: Omit<PendingProposal, 'at'>): void {
    const s = this.state();
    s.pending.push({ at: stamp(), ...p });
    if (s.pending.length > 20) s.pending.splice(0, s.pending.length - 20);
    this.writeState(s);
  }

  /** Reflection done: reset the counter, mark the journal as read, clear proposals. */
  reflected(): void {
    const s = this.state();
    s.tasksSinceReflection = 0;
    s.salienceSinceReflection = 0;
    s.lastReflectionAt = stamp();
    s.reflectedLines = this.list().length;
    s.pending = [];
    this.writeState(s);
  }

  /** A reading was handed out: advance the round-robin index. */
  readingGiven(): void {
    const s = this.state();
    s.readings += 1;
    this.writeState(s);
  }

  /** Record this reflection's drift answers (keeps the last 30). */
  recordDrift(answers: string[]): void {
    const s = this.state();
    s.drift.push({ at: stamp(), answers });
    if (s.drift.length > 30) s.drift.splice(0, s.drift.length - 30);
    this.writeState(s);
  }

  setNoticedTamper(hash: string | undefined): void {
    const s = this.state();
    s.noticedTamper = hash;
    this.writeState(s);
  }

  ensureFile(): string {
    if (!fs.existsSync(this.file)) this.writeRaw(HEADER);
    return this.file;
  }

  importText(text: string, state?: Partial<JournalState>): void {
    this.writeRaw(text.trim() ? text : HEADER);
    if (state) this.writeState({ tasksSinceReflection: state.tasksSinceReflection ?? 0, salienceSinceReflection: state.salienceSinceReflection ?? 0, lastReflectionAt: state.lastReflectionAt, reflectedLines: state.reflectedLines ?? 0, pending: state.pending ?? [], noticedTamper: undefined, readings: state.readings ?? 0, drift: state.drift ?? [] });
  }

  raw(): string {
    return this.readRaw();
  }

  private appendLine(kind: JournalEntry['kind'], text: string): JournalEntry {
    const raw = this.readRaw();
    const base = raw.trim() ? raw.replace(/\s*$/, '\n') : HEADER + '\n';
    const at = stamp();
    const marker = kind === 'note' ? 'note — ' : '';
    this.writeRaw(`${base}- [${at}] ${marker}${text}\n`);
    return { at, kind, text };
  }

  private writeState(s: JournalState): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 1));
  }

  private readRaw(): string {
    try {
      return fs.readFileSync(this.file, 'utf8');
    } catch {
      return '';
    }
  }

  private writeRaw(content: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, content);
  }
}

function parseLine(line: string): JournalEntry | undefined {
  const m = line.match(/^-\s+\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s+(note — )?(.+?)\s*$/);
  if (!m) return undefined;
  return { at: m[1], kind: m[2] ? 'note' : 'task', text: m[3] };
}

function renderEntry(e: JournalEntry): string {
  return `- [${e.at}] ${e.kind === 'note' ? 'note — ' : ''}${e.text}`;
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Local time to the minute: YYYY-MM-DD HH:MM. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
