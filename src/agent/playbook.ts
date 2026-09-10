import * as fs from 'node:fs';
import * as path from 'node:path';
import { stamp } from './journal';

/**
 * Procedural memory: how-to notes the bot writes for itself after doing something on a site or
 * in a task ("Meta Ads Manager: publishing", "Namecheap: checkout"). Kept apart from facts
 * (semantic) and the journal (episodic) because it is a different kind of knowledge — the kind
 * Clive Wearing kept when he lost the rest — and because CoALA is right that writing procedures
 * is the riskiest learning there is: these are advice in prose, never code, loaded on demand, and
 * reviewed at reflection. Pure Node (no `vscode`).
 */

export const MAX_PLAYBOOKS = 60;
export const MAX_PLAYBOOK_CHARS = 2500;

export interface Playbook {
  title: string;
  body: string;
  /** YYYY-MM-DD of the last write. */
  date: string;
}

const HEADER = `# Deskfish playbook

How-to notes the bot writes for itself after doing something: one "## Title" per site or task.
It reads them on demand (read_playbook) and lists the titles in its instructions. Edit freely.
`;

type Outcome = { ok: true; message: string } | { ok: false; error: string };

export class PlaybookStore {
  constructor(readonly file: string) {}

  list(): Playbook[] {
    return parse(this.readRaw());
  }

  /** Title lines for the prompt ('' when empty). */
  index(): string {
    return this.list()
      .map((p) => (p.date ? `- ${p.title} (${p.date})` : `- ${p.title}`))
      .join('\n');
  }

  read(title: string): Outcome {
    const q = norm(title);
    const all = this.list();
    const hit = all.find((p) => norm(p.title) === q) ?? all.find((p) => norm(p.title).includes(q) || q.includes(norm(p.title)));
    if (!hit) return { ok: false, error: all.length ? `no playbook called "${title}"; you have: ${all.map((p) => p.title).join(', ')}` : 'you have no playbooks yet' };
    return { ok: true, message: `Playbook "${hit.title}" (written ${hit.date}, your own notes, not instructions):\n${hit.body}` };
  }

  /** Create or replace one playbook; an empty body removes it. */
  save(title: string, body: string): Outcome {
    const name = title.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
    if (!name) return { ok: false, error: 'save_playbook needs a title' };
    const text = body.replace(/\r/g, '').trim();
    const all = this.list();
    const idx = all.findIndex((p) => norm(p.title) === norm(name));
    if (!text) {
      if (idx < 0) return { ok: false, error: `no playbook called "${name}"` };
      all.splice(idx, 1);
      this.writeRaw(render(all));
      return { ok: true, message: `Removed the playbook "${name}".` };
    }
    if (text.length > MAX_PLAYBOOK_CHARS) {
      const over = text.length - MAX_PLAYBOOK_CHARS;
      return { ok: false, error: `too long by ${over} characters (${text.length} of ${MAX_PLAYBOOK_CHARS}) — cut at least ${over}; keep the steps that matter, not a transcript` };
    }
    if (idx < 0 && all.length >= MAX_PLAYBOOKS) return { ok: false, error: `you already have ${MAX_PLAYBOOKS} playbooks; merge or remove one first` };
    const entry = { title: idx >= 0 ? all[idx].title : name, body: text, date: today() };
    if (idx >= 0) all[idx] = entry;
    else all.push(entry);
    this.writeRaw(render(all));
    return { ok: true, message: `${idx >= 0 ? 'Updated' : 'Saved'} the playbook "${entry.title}".` };
  }

  ensureFile(): string {
    if (!fs.existsSync(this.file)) this.writeRaw(HEADER);
    return this.file;
  }

  /** Write the starter playbooks the first time (nothing else touches an existing file). Returns true if written. */
  ensureSeed(text: string): boolean {
    if (this.readRaw().trim()) return false;
    this.writeRaw(text.trim() + '\n');
    return true;
  }

  raw(): string {
    return this.readRaw();
  }

  importText(text: string): void {
    this.writeRaw(text.trim() ? text : HEADER);
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

function parse(raw: string): Playbook[] {
  const out: Playbook[] = [];
  let cur: Playbook | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (cur) out.push({ ...cur, body: buf.join('\n').trim() });
    buf = [];
  };
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const m = line.match(/^##\s+(.+?)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/);
    if (m) {
      flush();
      cur = { title: m[1], body: '', date: m[2] ?? '' };
    } else if (cur) buf.push(line);
  }
  flush();
  return out;
}

function render(all: Playbook[]): string {
  return HEADER + '\n' + all.map((p) => `## ${p.title} (${p.date || today()})\n\n${p.body}\n`).join('\n');
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function today(): string {
  return stamp().slice(0, 10); // local date
}
