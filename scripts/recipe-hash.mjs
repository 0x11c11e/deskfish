#!/usr/bin/env node
// Prints the tank recipe fingerprint the extension stamps on the image (label deskfish.recipe).
// Same algorithm as src/desktop/recipe.ts. Usage: node scripts/recipe-hash.mjs [docker/desktop]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'docker', 'desktop'));
const files = [];
const walk = (d) => {
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
console.log(h.digest('hex').slice(0, 16));
