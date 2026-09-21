/** Reads the project's public documentation; writes only inside site/. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, parseFrontmatter } from './markdown.mjs';
import { applyContentOverrides } from './content-overrides.mjs';
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(site, '..', 'docs');
const order = [
  'Start here',
  'Using Deskfish',
  'Under the hood',
  'Reference',
  'Help',
];
const pages = fs
  .readdirSync(docs)
  .filter((f) => f.endsWith('.md'))
  .map((file) => {
    const { meta, body: original } = parseFrontmatter(
      fs.readFileSync(path.join(docs, file), 'utf8'),
    );
    const body = applyContentOverrides(file, original);
    const page = {
      slug: file.replace('.md', ''),
      title: meta.title,
      description: meta.description,
      section: meta.section,
      order: Number(meta.order),
      body,
    };
    return { ...page, ...render(body, page) };
  })
  .sort(
    (a, b) =>
      order.indexOf(a.section) - order.indexOf(b.section) || a.order - b.order,
  );
fs.mkdirSync(path.join(site, 'app/content'), { recursive: true });
fs.writeFileSync(
  path.join(site, 'app/content/docs.json'),
  JSON.stringify(pages),
);
fs.writeFileSync(
  path.join(site, 'public/sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['', 'docs/', ...pages.map((p) => 'docs/' + p.slug + '/')].map((p) => `<url><loc>https://deskfish.sh/${p}</loc></url>`).join('')}</urlset>`,
);
console.log(`Synced ${pages.length} documentation pages into site.`);
