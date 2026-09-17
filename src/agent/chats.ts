import * as fs from 'node:fs';
import * as path from 'node:path';
import { maskSecrets } from './secrets';

/**
 * Past chats: every conversation is written to a markdown transcript as it happens (your
 * messages, her replies, the small memory lines, action counts, hand-overs, how it ended), so
 * "New chat" no longer throws the work away. The bot's recall tool searches them like it searches
 * the journal; the user can open one, or continue it in a new chat. Images are never stored.
 * Pure Node (no `vscode`).
 */

export interface ChatSummary {
  file: string;
  name: string;
  /** YYYY-MM-DD HH:MM */
  startedAt: string;
  firstTask: string;
  bytes: number;
  /** Last write, for ordering chats that started in the same minute. */
  mtime: number;
  /** How it ended, from the file's tail; undefined when it never reached an end (unfinished). */
  outcome?: ChatOutcome;
}

/** How a past chat ended: its last status line, or a knock with no status after it. */
export type ChatOutcome = 'done' | 'stopped' | 'error' | 'needs_user';

/** The bytes of a transcript's end that `outcomeOf` reads (the status line is written after her last reply). */
export const OUTCOME_TAIL = 2048;

/**
 * How a transcript ends, from its last few kilobytes: the last `_done — …_` / `_stopped — …_` /
 * `_error — …_` line, or `needs_user` when a `> **Deskfish needs you:**` comes after it (or there is
 * no status at all). Nothing of either: undefined, a chat that never finished.
 */
export function outcomeOf(tail: string): ChatOutcome | undefined {
  let status: { kind: ChatOutcome; at: number } | undefined;
  // The pattern parseTranscript uses (a status could run into a step line in the first format).
  for (const m of tail.matchAll(/_(done|stopped|error)\b[^_\n]*_/g)) status = { kind: m[1] as ChatOutcome, at: m.index };
  const knock = tail.lastIndexOf('> **Deskfish needs you:**');
  if (knock >= 0 && (!status || knock > status.at)) return 'needs_user';
  return status?.kind;
}

type Outcome = { ok: true; message: string } | { ok: false; error: string };

export class ChatStore {
  constructor(readonly dir: string) {}

  /** Open a new transcript for a conversation whose first task is `firstTask`. */
  start(firstTask: string, meta: { model: string; provider: string }): ChatTranscript {
    fs.mkdirSync(this.dir, { recursive: true });
    const at = stamp();
    const slug = firstTask.replace(/\s+/g, ' ').trim().slice(0, 48).replace(/[^\p{L}\p{N} ._-]+/gu, '').trim() || 'chat';
    let file = path.join(this.dir, `${at.replace(':', '-')} - ${slug}.md`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(this.dir, `${at.replace(':', '-')} - ${slug} (${i}).md`);
    fs.writeFileSync(file, `# Chat — ${at}\n\nmodel: ${meta.model} (${meta.provider})\n\n`);
    return new ChatTranscript(file);
  }

  list(): ChatSummary[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.md'));
    } catch {
      return [];
    }
    return files
      .map((name) => {
        const file = path.join(this.dir, name);
        const head = readHead(file, 2000);
        const m = head.match(/^# Chat — (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
        const task = head.match(/^## You[^\n]*\n+([^\n]+)/m);
        const bytes = safeSize(file);
        return { file, name, startedAt: m?.[1] ?? '', firstTask: task?.[1]?.trim() ?? '', bytes, mtime: safeMtime(file), outcome: outcomeOf(readTail(file, OUTCOME_TAIL, bytes)) };
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.mtime - a.mtime);
  }

  read(file: string): string {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Keyword search over the transcripts, newest first: lines with the most matching terms win;
   * each hit carries the chat's date and first task. Output is bounded (~2,500 characters).
   */
  search(query: string, limit = 6): Outcome {
    const terms = query.toLowerCase().split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}.@/-]/gu, '')).filter((t) => t.length >= 3);
    if (!terms.length) return { ok: false, error: 'recall needs a few words to search for' };
    const chats = this.list().slice(0, 200);
    const hits: { score: number; when: string; task: string; line: string }[] = [];
    for (const c of chats) {
      const text = this.read(c.file);
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('model:')) continue;
        const hay = line.toLowerCase();
        const n = terms.reduce((k, t) => k + (hay.includes(t) ? 1 : 0), 0);
        if (n) hits.push({ score: n, when: c.startedAt, task: c.firstTask.slice(0, 60), line: line.length > 200 ? line.slice(0, 197) + '…' : line });
      }
    }
    if (!hits.length) return { ok: false, error: `nothing in your past chats matches "${query}"` };
    hits.sort((a, b) => b.score - a.score || b.when.localeCompare(a.when));
    const top = hits.slice(0, limit).sort((a, b) => a.when.localeCompare(b.when));
    let out = `From your past chats (${top.length} of ${hits.length} matching lines):\n`;
    for (const h of top) {
      const piece = `- [${h.when} · ${h.task}] ${h.line}\n`;
      if (out.length + piece.length > 2500) break;
      out += piece;
    }
    return { ok: true, message: out.trimEnd() };
  }

  /** Delete one transcript by its file (the caller checked the name). */
  delete(file: string): void {
    fs.unlinkSync(file);
  }

  deleteAll(): number {
    const all = this.list();
    for (const c of all) {
      try {
        fs.unlinkSync(c.file);
      } catch {
        /* ignore */
      }
    }
    return all.length;
  }

  /** For export: every transcript as {name, text}. */
  dump(): { name: string; text: string }[] {
    return this.list().map((c) => ({ name: c.name, text: this.read(c.file) }));
  }

  /** For import: write transcripts that do not exist yet. Returns how many were written. */
  restore(items: { name: string; text: string }[]): number {
    fs.mkdirSync(this.dir, { recursive: true });
    let n = 0;
    for (const it of items) {
      if (!it?.name || typeof it.text !== 'string' || it.name.includes('/') || it.name.includes('\\')) continue;
      const file = path.join(this.dir, it.name);
      if (fs.existsSync(file)) continue;
      fs.writeFileSync(file, it.text);
      n++;
    }
    return n;
  }
}

/** What a transcript turns back into for the sidebar. */
export type ReplayItem =
  | { kind: 'user'; text: string; at?: string }
  | { kind: 'assistant'; text: string; at?: string }
  | { kind: 'note'; text: string }
  | { kind: 'actions'; step: number; actions: { text: string; failed: boolean }[] }
  | { kind: 'needs_user'; text: string }
  | { kind: 'status'; text: string };

/** One conversation's transcript, appended to as it happens. */
export class ChatTranscript {
  private lastStep = 0;
  /** Whether the file currently ends with a line break (so blocks never run together). */
  private atLineStart = true;
  constructor(readonly file: string) {}

  user(text: string): void {
    this.block(`## You (${clock()})\n\n${text.trim()}\n\n`);
  }

  assistant(text: string): void {
    this.block(`## Deskfish (${clock()})\n\n${text.trim()}\n\n`);
  }

  /** A memory/self/playbook line, as the small pill in the chat. */
  note(text: string): void {
    this.block(`> ${text.replace(/\s+/g, ' ').trim()}\n\n`);
  }

  /** Called per action; one "_step N_:" line per step, actions separated by " · ". */
  action(step: number, description: string, ok: boolean): void {
    const text = ok ? description : `${description} (failed)`;
    if (step !== this.lastStep) {
      this.lastStep = step;
      this.block(`_step ${step}_: ${text}`);
    } else this.append(` · ${text}`);
  }

  needsUser(reason: string): void {
    this.block(`> **Deskfish needs you:** ${reason.trim()}\n\n`);
  }

  status(line: string): void {
    this.block(`_${line.trim()}_\n\n`);
  }

  end(): void {
    this.block(`— chat ended ${clock()} —\n`);
  }

  /** Start a new block on its own line, with one blank line before it. */
  private block(s: string): void {
    this.append((this.atLineStart ? '' : '\n\n') + s);
  }

  private append(s: string): void {
    try {
      fs.appendFileSync(this.file, maskSecrets(s)); // a transcript is a log: no credential is written down
      this.atLineStart = s.endsWith('\n');
    } catch {
      /* a transcript must never break a task */
    }
  }
}

/**
 * A transcript back into sidebar items. Tolerates the first format, where step lines and
 * notes could run together on one line.
 */
export function parseTranscript(text: string): ReplayItem[] {
  // normalize: every block start on its own line
  const norm = text
    .replace(/\r/g, '')
    .replace(/(?<!\n)(_step \d+_: )/g, '\n$1')
    .replace(/(?<!\n)(> )/g, '\n$1')
    .replace(/(?<!\n)(## (?:You|Deskfish) \()/g, '\n\n$1')
    .replace(/(?<!\n)(_(?:done|stopped|error)\b[^_\n]*_)/g, '\n$1');
  const items: ReplayItem[] = [];
  let cur: { kind: 'user' | 'assistant'; at?: string; lines: string[] } | undefined;
  const flush = () => {
    if (cur) {
      const t = cur.lines.join('\n').trim();
      if (t) items.push({ kind: cur.kind, text: t, at: cur.at });
    }
    cur = undefined;
  };
  for (const raw of norm.split('\n')) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if (line.startsWith('# Chat — ') || line.startsWith('model: ') || line.startsWith('— chat ended')) {
      flush();
      continue;
    }
    if ((m = line.match(/^## (You|Deskfish) \((\d\d:\d\d)\)/))) {
      flush();
      cur = { kind: m[1] === 'You' ? 'user' : 'assistant', at: m[2], lines: [] };
      continue;
    }
    if ((m = line.match(/^_step (\d+)_: (.*)$/))) {
      flush();
      const actions = m[2]
        .split(' · ')
        .map((a) => a.trim())
        .filter(Boolean)
        .map((a) => (a.endsWith(' (failed)') ? { text: a.slice(0, -9), failed: true } : { text: a, failed: false }));
      items.push({ kind: 'actions', step: Number(m[1]), actions });
      continue;
    }
    if ((m = line.match(/^> \*\*Deskfish needs you:\*\* (.*)$/))) {
      flush();
      items.push({ kind: 'needs_user', text: m[1].trim() });
      continue;
    }
    if (line.startsWith('> ')) {
      flush();
      items.push({ kind: 'note', text: line.slice(2).trim() });
      continue;
    }
    if ((m = line.match(/^_((?:done|stopped|error)\b[^_]*)_$/))) {
      flush();
      items.push({ kind: 'status', text: m[1].trim() });
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  flush();
  return items;
}

function readHead(file: string, bytes: number): string {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  }
}

/** The last `bytes` of a file (`size` when already known), without reading the rest. */
function readTail(file: string, bytes: number, size: number): string {
  try {
    const fd = fs.openSync(file, 'r');
    const from = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  }
}

function safeMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function safeSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function clock(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
