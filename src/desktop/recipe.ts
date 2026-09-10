import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const RECIPE_LABEL = 'deskfish.recipe';

/**
 * Fingerprint of the tank's recipe: every file under docker/desktop (sorted relative path +
 * content). Stamped on the image as a label at build time; the engine rebuilds when the label of
 * the existing image differs, so an updated extension (new daemon, new Firefox extension, new
 * packages) reaches the user's tank at the next start instead of never.
 * `scripts/recipe-hash.mjs` computes the same value from the shell.
 */
export function recipeHash(dir: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) files.push(p);
    }
  };
  walk(dir);
  const h = createHash('sha256');
  for (const f of files) {
    h.update(path.relative(dir, f).split(path.sep).join('/'));
    h.update('\n');
    h.update(createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
    h.update('\n');
  }
  return h.digest('hex').slice(0, 16);
}
