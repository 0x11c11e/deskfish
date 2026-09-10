import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The bot's own documentation, read on demand.
 *
 * `docs/*.md` (the same files the docs site is built from) are loaded once; the system prompt
 * carries only a one-line-per-page index, and the model fetches a page through the `read_docs`
 * tool when the user asks something about Deskfish. This keeps the prompt small on every step
 * while letting the bot answer questions about itself from the actual documentation rather
 * than from memory. Pure Node — no `vscode` import.
 */

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  section: string;
  order: number;
  tagline?: string;
  body: string;
}

const SECTION_ORDER = ['Start here', 'Using Deskfish', 'Under the hood', 'Reference', 'Help'];

export class DocsLibrary {
  constructor(readonly pages: DocPage[]) {}

  /** Load every `*.md` in `dir`. A missing or empty directory yields an empty library. */
  static load(dir: string): DocsLibrary {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      return new DocsLibrary([]);
    }
    const pages: DocPage[] = [];
    for (const file of files) {
      try {
        const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'));
        pages.push({
          slug: file.replace(/\.md$/, ''),
          title: meta.title ?? file,
          description: meta.description ?? '',
          section: meta.section ?? 'Other',
          order: Number(meta.order ?? 99),
          tagline: meta.tagline,
          body: body.trim(),
        });
      } catch {
        /* skip unreadable page */
      }
    }
    const rank = (s: string) => {
      const i = SECTION_ORDER.indexOf(s);
      return i === -1 ? SECTION_ORDER.length : i;
    };
    pages.sort((a, b) => rank(a.section) - rank(b.section) || a.order - b.order || a.title.localeCompare(b.title));
    return new DocsLibrary(pages);
  }

  get size(): number {
    return this.pages.length;
  }

  /** One line per page — the only part of the documentation that lives in the system prompt. */
  index(): string {
    return this.pages.map((p) => `- ${p.slug}: ${p.title} — ${p.description}`).join('\n');
  }

  /** Find a page by slug (tolerant: case, spaces, ".md", or the page title). */
  find(name: string): DocPage | undefined {
    const key = name.trim().toLowerCase().replace(/\.md$/, '').replace(/[\s_]+/g, '-');
    return (
      this.pages.find((p) => p.slug === key) ??
      this.pages.find((p) => p.title.toLowerCase() === name.trim().toLowerCase()) ??
      this.pages.find((p) => p.slug.includes(key) || key.includes(p.slug))
    );
  }

  /** The text a read_docs call returns to the model. */
  read(name: string): { ok: true; text: string } | { ok: false; error: string } {
    if (!this.pages.length) return { ok: false, error: 'the documentation is not available in this session' };
    const key = name.trim().toLowerCase();
    if (!key || key === 'index' || key === 'list' || key === 'toc') {
      return { ok: true, text: `Deskfish documentation — pages (call read_docs with a slug to read one):\n${this.index()}` };
    }
    const page = this.find(name);
    if (!page) {
      return { ok: false, error: `no documentation page "${name}". Available pages: ${this.pages.map((p) => p.slug).join(', ')}` };
    }
    const head = [`Deskfish documentation — ${page.title} (${page.slug})`, page.description, page.tagline].filter(Boolean).join('\n');
    return { ok: true, text: `${head}\n\n${page.body}` };
  }
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta: Record<string, string> = {};
  if (!m) return { meta, body: raw };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}
