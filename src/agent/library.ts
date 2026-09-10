import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The reading library: short public-domain passages shipped with the extension (like the docs),
 * one of which is read during a reflection. Exemplars and questions, not commandments — the way
 * stories shape a narrative identity. Each file has a small frontmatter (title, source) and the
 * passage. Pure Node (no `vscode`).
 */

export interface Reading {
  slug: string;
  title: string;
  source: string;
  text: string;
}

export class Library {
  private constructor(private readonly readings: Reading[]) {}

  /**
   * Load the readings, keeping only files whose SHA-256 matches `manifest.json` (written by the
   * build). The corpus is fixed and ships with Deskfish: never fetched live, never assembled from
   * anything a task touched, and a reading edited on disk is simply not read.
   */
  static load(dir: string, opts: { verify?: boolean } = {}): Library {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    } catch {
      return new Library([]);
    }
    let manifest: Record<string, string> | undefined;
    if (opts.verify !== false) {
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, string>;
      } catch {
        return new Library([]);
      }
    }
    const readings: Reading[] = [];
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      if (manifest && manifest[f] !== crypto.createHash('sha256').update(raw).digest('hex')) continue;
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!m) continue;
      const meta: Record<string, string> = {};
      for (const line of m[1].split('\n')) {
        const kv = line.match(/^(\w+):\s*(.*)$/);
        if (kv) meta[kv[1]] = kv[2].trim();
      }
      readings.push({ slug: f.replace(/\.md$/, ''), title: meta.title ?? f, source: meta.source ?? '', text: m[2].trim() });
    }
    return new Library(readings);
  }

  get size(): number {
    return this.readings.length;
  }

  /** The n-th reading, round-robin. */
  pick(n: number): Reading | undefined {
    if (!this.readings.length) return undefined;
    return this.readings[((n % this.readings.length) + this.readings.length) % this.readings.length];
  }

  list(): Reading[] {
    return this.readings.slice();
  }
}
