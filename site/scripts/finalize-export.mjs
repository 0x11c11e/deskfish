/** Add portable directory URLs to Vinext's flat static export. Writes only to site/dist. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/client',
);
const pages = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (
      entry.name.endsWith('.html') &&
      !['index.html', '404.html'].includes(entry.name)
    )
      pages.push(file);
  }
}
walk(root);
for (const file of pages) {
  const target = file.slice(0, -5);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(file, path.join(target, 'index.html'));
}
console.log(
  `Prepared ${pages.length + 1} portable directory routes in dist/client.`,
);
