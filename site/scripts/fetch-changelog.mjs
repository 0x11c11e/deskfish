/**
 * Reads the project's GitHub releases; writes only app/content/changelog.json.
 * Each release's notes end with a **Changes** list of commit subjects, and that list is the changelog.
 * Offline rule: if the fetch fails for any reason the checked-in file stays and the build goes on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(site, 'app/content/changelog.json');
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'deskfish-website',
};
if (process.env.GITHUB_TOKEN)
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function fetchReleases() {
  const releases = [];
  let url =
    'https://api.github.com/repos/0x11c11e/deskfish/releases?per_page=100';
  while (url) {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    releases.push(...(await res.json()));
    url = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  return releases;
}

/** The bullets under **Changes**, without merges and without the line a product-less build carries. */
function changes(body) {
  const lines = (body ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '**Changes**');
  if (start < 0) return [];
  return lines
    .slice(start + 1)
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((l) => l && !l.startsWith('Merge '));
}

try {
  const releases = (await fetchReleases())
    .filter((r) => !r.draft && r.published_at)
    .map((r) => ({
      tag_name: r.tag_name,
      name: r.name,
      published_at: r.published_at,
      html_url: r.html_url,
      changes: changes(r.body),
    }))
    .filter((r) => r.changes.length)
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
  if (!releases.length) throw new Error('no release with a list of changes');
  fs.writeFileSync(out, JSON.stringify(releases, null, 2) + '\n');
  console.log(`Wrote ${releases.length} releases into the changelog.`);
} catch (error) {
  console.warn(
    `Changelog not refreshed (${error.message}); the checked-in copy stays.`,
  );
}
