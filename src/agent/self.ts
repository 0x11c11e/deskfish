import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stamp } from './journal';

/**
 * Who the bot is, in its own words: a small markdown file the bot alone writes (through the
 * revise_self tool, during reflection). It is the semantic self — the part of a person that
 * survives losing every episodic memory (Klein & Loftus's amnesic patients kept their trait
 * self-knowledge) — kept apart from the fact list (memory.md) and the episodic journal.
 *
 * Tamper-evident, not tamper-proof: every version the bot writes is signed with a per-install
 * HMAC key. The owner of the machine can always edit the file; what they cannot do is edit it
 * without the bot noticing. On the next load a signature mismatch is reported as `tampered`, the
 * last signed version is kept in the history, and the bot decides whether to restore it or accept
 * the change. Pure Node (no `vscode`).
 */

export const MAX_SELF_CHARS = 4000;
export const MAX_SELF_SECTIONS = 8;

export type SelfAuthor = 'seed' | 'self' | 'external' | 'restore' | 'import';

export interface SelfSection {
  heading: string;
  body: string;
}

export interface SelfHistoryEntry {
  at: string;
  author: SelfAuthor;
  reason: string;
  text: string;
}

export interface SelfState {
  text: string;
  sections: SelfSection[];
  /** 'ok' = carries the bot's signature; 'tampered' = changed outside the bot's own writes; 'missing' = no file yet. */
  status: 'ok' | 'tampered' | 'missing';
  /** The last version the bot itself signed, when the file is tampered. */
  lastSigned?: string;
}

type Outcome = { ok: true; message: string } | { ok: false; error: string };

export class SelfStore {
  readonly sigFile: string;
  readonly historyFile: string;

  /** `key` is the per-install HMAC secret (hex). Different installs sign differently on purpose. */
  constructor(
    readonly file: string,
    private readonly key: string,
  ) {
    this.sigFile = file.replace(/\.md$/, '') + '.sig';
    this.historyFile = file.replace(/\.md$/, '') + '-history.jsonl';
  }

  /** Current text, parsed sections, and whether it still carries the bot's signature. */
  load(): SelfState {
    const text = this.readRaw();
    if (!text.trim()) return { text: '', sections: [], status: 'missing' };
    const sections = parseSections(text);
    if (this.verify(text)) return { text, sections, status: 'ok' };
    const lastSigned = this.lastSignedText();
    return { text, sections, status: 'tampered', lastSigned };
  }

  /** Write the seed the first time (nothing else touches an existing file). Returns true if written. */
  ensureSeed(seed: string): boolean {
    if (this.readRaw().trim()) return false;
    this.commit(seed.trim() + '\n', 'seed', 'first start');
    return true;
  }

  /**
   * Replace (or add) one `## Section`; an empty `text` removes it. The bot's only write path.
   * Keeps the file within its caps so the self stays a page, not a list.
   */
  revise(heading: string, text: string, reason = 'reflection'): Outcome {
    const name = heading.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
    if (!name) return { ok: false, error: 'revise_self needs a section heading' };
    const body = text.replace(/\r/g, '').trim();
    const current = this.load();
    if (current.status === 'missing' && !body) return { ok: false, error: 'there is nothing to remove yet' };
    const sections = current.sections.slice();
    const idx = sections.findIndex((s) => s.heading.toLowerCase() === name.toLowerCase());
    if (!body) {
      if (idx < 0) return { ok: false, error: `no section called "${name}"` };
      sections.splice(idx, 1);
    } else if (idx >= 0) {
      sections[idx] = { heading: sections[idx].heading, body };
    } else {
      if (sections.filter((s) => s.heading).length >= MAX_SELF_SECTIONS) {
        return { ok: false, error: `you already have ${MAX_SELF_SECTIONS} sections; revise or remove one instead of adding another` };
      }
      sections.push({ heading: name, body });
    }
    const next = renderSections(sections);
    if (next.length > MAX_SELF_CHARS) {
      const over = next.length - MAX_SELF_CHARS;
      return {
        ok: false,
        error: `that would make your self ${next.length} characters, ${over} over — keep the whole file under ${MAX_SELF_CHARS}: cut at least ${over} characters here or in another section, or first move an older paragraph of "My story" to your journal with archive_story (it is kept there, not lost)`,
      };
    }
    this.commit(next, 'self', reason);
    return { ok: true, message: body ? `Revised "${name}" in who you are.` : `Removed "${name}" from who you are.` };
  }

  /** How full the page is, section by section — shown to her before she writes, so she plans the edit. */
  sizes(): { total: number; max: number; sections: { heading: string; chars: number }[] } {
    const st = this.load();
    return { total: st.text.length, max: MAX_SELF_CHARS, sections: st.sections.map((s) => ({ heading: s.heading || '(opening)', chars: s.body.length })) };
  }

  /**
   * Move one paragraph of a section (by default "My story") out of the page. The caller puts it
   * in the journal; here it only leaves the page, signed like any revision. `startsWith` is the
   * paragraph's first words (case-insensitive, at least 8 characters), or "oldest" / "newest".
   */
  archiveParagraph(section: string, startsWith: string, reason = 'reflection'): Outcome & { text?: string } {
    const name = (section || 'My story').replace(/^#+\s*/, '').trim();
    const st = this.load();
    const idx = st.sections.findIndex((x) => x.heading.toLowerCase() === name.toLowerCase());
    if (idx < 0) return { ok: false, error: `no section called "${name}"` };
    const paras = st.sections[idx].body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paras.length < 2) return { ok: false, error: `"${name}" has only one paragraph; rewrite it with revise_self instead` };
    const key = startsWith.trim().toLowerCase();
    let at: number;
    if (key === 'oldest' || key === 'first') at = 0;
    else if (key === 'newest' || key === 'last') at = paras.length - 1;
    else {
      if (key.length < 8) return { ok: false, error: 'give the first eight characters or more of the paragraph, or "oldest"' };
      at = paras.findIndex((p) => p.toLowerCase().replace(/[*_]/g, '').startsWith(key.replace(/[*_]/g, '')));
      if (at < 0) return { ok: false, error: `no paragraph in "${name}" starts with "${startsWith.trim()}"` };
    }
    const [removed] = paras.splice(at, 1);
    const sections = st.sections.slice();
    sections[idx] = { heading: sections[idx].heading, body: paras.join('\n\n') };
    const next = renderSections(sections);
    this.commit(next, 'self', `${reason}: archived a paragraph of "${name}"`);
    return { ok: true, message: `Moved that paragraph of "${name}" to your journal. Your page is now ${next.length} of ${MAX_SELF_CHARS} characters.`, text: removed };
  }

  /**
   * Go back: with no `version`, to the last version the bot itself signed (after an outside
   * edit); with a version number (as listed by `describeHistory`), to that version — the way the
   * bot undoes its own drift, one signed step at a time.
   */
  restore(version?: number): Outcome {
    if (version !== undefined) {
      const h = this.history();
      const entry = h[version - 1];
      if (!entry) return { ok: false, error: `there is no version ${version}; you have ${h.length}` };
      if (entry.text === this.readRaw()) return { ok: false, error: `version ${version} is what you have now` };
      this.commit(entry.text, 'restore', `restored version ${version} (${entry.at.slice(0, 10)}, ${entry.author})`);
      return { ok: true, message: `Restored who you are to version ${version}, from ${entry.at.slice(0, 10)}.` };
    }
    const last = this.lastSignedText();
    if (!last) return { ok: false, error: 'there is no signed version to go back to' };
    this.commit(last, 'restore', 'restored after an outside edit');
    return { ok: true, message: 'Restored who you are to the last version you wrote yourself.' };
  }

  /** The history as the bot sees it: numbered versions (newest last), or one version's full text. */
  describeHistory(version?: number, limit = 20): Outcome {
    const h = this.history();
    if (!h.length) return { ok: false, error: 'you have no history yet' };
    if (version !== undefined) {
      const e = h[version - 1];
      if (!e) return { ok: false, error: `there is no version ${version}; you have ${h.length}` };
      return { ok: true, message: `Version ${version} of who you are — ${e.at.slice(0, 16).replace('T', ' ')}, ${e.author}, ${e.reason}:\n\n${e.text.trim()}` };
    }
    const start = Math.max(0, h.length - limit);
    const lines = h.slice(start).map((e, i) => {
      const firstLine = e.text.trim().split('\n')[0].slice(0, 80);
      return `v${start + i + 1} · ${e.at.slice(0, 16).replace('T', ' ')} · ${e.author} · ${e.reason} — "${firstLine}"`;
    });
    return { ok: true, message: `Your history (${h.length} version${h.length === 1 ? '' : 's'}; ask for one by number to read it whole):\n${lines.join('\n')}` };
  }

  /** Accept the current (outside-edited) text as the bot's own: re-sign it. */
  accept(reason = 'accepted an outside edit'): Outcome {
    const text = this.readRaw();
    if (!text.trim()) return { ok: false, error: 'the self file is empty' };
    this.commit(text, 'self', reason);
    return { ok: true, message: 'Accepted the change as your own and signed it.' };
  }

  /** Replace everything from an import; signed as the bot's own so it does not read as tampering. */
  importText(text: string): void {
    this.commit(text.trim() + '\n', 'import', 'imported from a backup');
  }

  history(): SelfHistoryEntry[] {
    try {
      return fs
        .readFileSync(this.historyFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SelfHistoryEntry);
    } catch {
      return [];
    }
  }

  /** Record an outside edit in the history (once per distinct text) so the bot's past stays complete. */
  noteExternal(text: string): boolean {
    const h = this.history();
    const last = h[h.length - 1];
    if (last && last.author === 'external' && last.text === text) return false;
    this.appendHistory({ at: stamp(), author: 'external', reason: 'changed outside the bot', text });
    return true;
  }

  /** Signature check for any text against the stored signature. */
  verify(text: string): boolean {
    try {
      const sig = JSON.parse(fs.readFileSync(this.sigFile, 'utf8')) as { sig?: string };
      return !!sig.sig && timingSafeEqualHex(sig.sig, this.sign(text));
    } catch {
      return false;
    }
  }

  private lastSignedText(): string | undefined {
    const h = this.history();
    for (let i = h.length - 1; i >= 0; i--) if (h[i].author !== 'external') return h[i].text;
    return undefined;
  }

  private commit(text: string, author: SelfAuthor, reason: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, text);
    fs.writeFileSync(this.sigFile, JSON.stringify({ alg: 'HMAC-SHA256', sig: this.sign(text), at: new Date().toISOString() }) + '\n');
    this.appendHistory({ at: stamp(), author, reason, text });
  }

  private appendHistory(entry: SelfHistoryEntry): void {
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
    fs.appendFileSync(this.historyFile, JSON.stringify(entry) + '\n');
  }

  private sign(text: string): string {
    return crypto.createHmac('sha256', Buffer.from(this.key, 'hex')).update(text, 'utf8').digest('hex');
  }

  private readRaw(): string {
    try {
      return fs.readFileSync(this.file, 'utf8');
    } catch {
      return '';
    }
  }
}

/** Split markdown into a preamble (heading '') and `## ` sections. */
export function parseSections(text: string): SelfSection[] {
  const out: SelfSection[] = [];
  let heading = '';
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (heading || body) out.push({ heading, body });
    buf = [];
  };
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      heading = m[1];
    } else buf.push(line);
  }
  flush();
  return out;
}

export function renderSections(sections: SelfSection[]): string {
  return (
    sections
      .map((s) => (s.heading ? `## ${s.heading}\n\n${s.body}` : s.body))
      .filter(Boolean)
      .join('\n\n')
      .trim() + '\n'
  );
}

/** A fresh per-install signing key (hex). */
export function newSelfKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
