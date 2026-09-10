import * as fs from 'node:fs';
import * as path from 'node:path';
import { stamp } from './journal';

/**
 * The bot's long-term memory: a small markdown file, one memory per line, that survives new
 * chats and restarts. The file is the source of truth — the user may open and edit it at any
 * time — so every operation re-reads it. Rendered into the system prompt at the start of each
 * conversation; written through the `remember` / `forget` tools. Pure Node (no `vscode`).
 */

export const MAX_MEMORIES = 100;
/** A fact may be a sentence or two — enough for what happened and what to do about it (raised 400 → 600 on 2026-09-10). */
export const MAX_MEMORY_LENGTH = 600;

export interface Memory {
  /** YYYY-MM-DD the memory was saved, or '' for a line the user wrote without a date. */
  date: string;
  text: string;
}

const HEADER = `# Deskfish memory

One memory per line, starting with "- ". Edit or delete lines freely: Deskfish reads this
file at the start of every new chat. "Deskfish: Forget All Memories" empties it.
`;

type Outcome = { ok: true; message: string } | { ok: false; error: string };

export class MemoryStore {
  constructor(readonly file: string) {}

  /** Memories currently on disk. */
  list(): Memory[] {
    return parse(this.readRaw()).memories;
  }

  /** Bullet lines for the system prompt; '' when nothing is remembered. */
  render(): string {
    return this.list()
      .map((m) => `- ${m.date ? `[${m.date}] ` : ''}${m.text}`)
      .join('\n');
  }

  remember(text: string): Outcome {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return { ok: false, error: 'nothing to remember' };
    if (clean.length > MAX_MEMORY_LENGTH) {
      const over = clean.length - MAX_MEMORY_LENGTH;
      return { ok: false, error: `too long, ${clean.length} of ${MAX_MEMORY_LENGTH} characters — over by ${over}; save it again shorter (a sentence or two: the fact and what to do about it), do not drop it` };
    }
    const memories = this.list();
    if (memories.some((m) => m.text.toLowerCase() === clean.toLowerCase())) return { ok: true, message: `Already remembered: ${clean}` };
    if (memories.length >= MAX_MEMORIES) {
      return { ok: false, error: `memory is full (${MAX_MEMORIES} entries); forget something outdated first` };
    }
    const raw = this.readRaw();
    const base = raw.trim() ? raw.replace(/\s*$/, '\n') : HEADER + '\n';
    this.writeRaw(`${base}- [${today()}] ${clean}\n`);
    return { ok: true, message: `Remembered: ${clean}` };
  }

  /** Delete every memory whose text contains `query` (case-insensitive). */
  forget(query: string): Outcome {
    const q = query.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!q) return { ok: false, error: 'say what to forget' };
    const { lines } = parse(this.readRaw());
    const removed: string[] = [];
    const kept = lines.filter((line) => {
      const m = bulletOf(line);
      if (m && m.text.toLowerCase().includes(q)) {
        removed.push(m.text);
        return false;
      }
      return true;
    });
    if (!removed.length) return { ok: false, error: `no memory contains "${query}"` };
    this.writeRaw(kept.join('\n').replace(/\s*$/, '\n'));
    return { ok: true, message: `Forgot ${removed.length === 1 ? '' : `${removed.length} memories: `}${removed.join(' | ')}` };
  }

  /** Empty the memory (the explanatory header stays). */
  clear(): void {
    this.writeRaw(HEADER);
  }

  /** The file's raw text (for export). */
  raw(): string {
    return this.readRaw();
  }

  /** Replace the file from a backup. */
  importText(text: string): void {
    this.writeRaw(text.trim() ? text : HEADER);
  }

  /** Create the file with its header if it does not exist yet; returns the path (for "edit memories"). */
  ensureFile(): string {
    if (!fs.existsSync(this.file)) this.writeRaw(HEADER);
    return this.file;
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

function bulletOf(line: string): Memory | undefined {
  const m = line.match(/^-\s+(?:\[(\d{4}-\d{2}-\d{2})\]\s*)?(.+?)\s*$/);
  return m ? { date: m[1] ?? '', text: m[2] } : undefined;
}

function parse(raw: string): { lines: string[]; memories: Memory[] } {
  const lines = raw.split(/\r?\n/);
  const memories = lines.map(bulletOf).filter((m): m is Memory => !!m);
  return { lines, memories };
}

function today(): string {
  return stamp().slice(0, 10); // local date, the same clock as the journal and the run-start note
}
