// The documentation, from both ends: what the bot reads through `read_docs` (DocsLibrary over
// `docs/*.md`) and what the site build makes of the same files. Recreated in step 8 — the old
// "DocsLibrary asserts (12)" suite lived in a scratchpad and was lost, and nothing under test/
// referenced it. Added here: the rendered page's links all resolve, and the shell shown on the
// pages people copy from (advanced, running-without-vscode, the-app) is valid shell.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DocsLibrary } from '../src/agent/docs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
let n = 0;
const ok = (c: unknown, m: string) => {
  assert.ok(c, m);
  n++;
};

/* ---------- DocsLibrary: what the bot reads ---------- */

const lib = DocsLibrary.load(DOCS);
const files = fs.readdirSync(DOCS).filter((f) => f.endsWith('.md'));
ok(lib.size === files.length, `every page is loaded (${lib.size} of ${files.length})`);
ok(lib.size === 20, `20 pages today (got ${lib.size})`);

const index = lib.index();
const lines = index.split('\n');
ok(lines.length === lib.size, 'one index line per page');
for (const line of lines) ok(/^- [a-z0-9-]+: .+ — .+$/.test(line), `index line format: ${line}`);
ok(lines[0].startsWith('- introduction: '), 'the index is in section order, introduction first');
ok(index.includes('- running-without-vscode: '), 'the new gateway page is in the index');
ok(index.includes('- the-app: '), 'the app page is in the index');

// Every page has the frontmatter the site and the index need.
for (const file of files) {
  const raw = fs.readFileSync(path.join(DOCS, file), 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  ok(!!m, `${file} has frontmatter`);
  for (const key of ['title', 'description', 'section', 'order']) ok(new RegExp(`^${key}:\\s*\\S`, 'm').test(m![1]), `${file}: ${key}`);
  const section = m![1].match(/^section:\s*(.+)$/m)![1].trim();
  ok(['Start here', 'Using Deskfish', 'Under the hood', 'Reference', 'Help'].includes(section), `${file}: known section (${section})`);
}
// Two pages must never share a place in a section.
const places = new Map<string, string>();
for (const p of lib.pages) {
  const key = `${p.section}/${p.order}`;
  ok(!places.has(key), `${key} is ${p.slug} alone (not also ${places.get(key)})`);
  places.set(key, p.slug);
}

// read(): by slug, by title, mixed case, with .md, with spaces.
for (const name of ['the-app', 'The app', 'THE-APP', 'the-app.md', 'The App']) {
  const r = lib.read(name);
  ok(r.ok && r.text.includes('Deskfish documentation — The app (the-app)'), `read("${name}") finds the page`);
}
const app = lib.read('the-app');
ok(app.ok && !app.text.includes('---\ntitle:'), 'the frontmatter is stripped from what the model sees');
ok(app.ok && app.text.includes('## Download'), 'the body is there');

const unknown = lib.read('how-to-fly');
ok(!unknown.ok, 'an unknown page is an error');
ok(!unknown.ok && unknown.error.includes('running-without-vscode') && unknown.error.includes('faq'), 'the error lists the slugs');

for (const name of ['', 'index', 'list', 'toc', '  ']) {
  const r = lib.read(name);
  ok(r.ok && r.text.includes('call read_docs with a slug') && r.text.includes('- the-app: '), `read("${name}") returns the list`);
}

const empty = DocsLibrary.load(path.join(os.tmpdir(), `deskfish-no-docs-${process.pid}`));
ok(empty.size === 0, 'a missing folder is an empty library');
ok(empty.index() === '', 'an empty library has an empty index');
const emptyRead = empty.read('faq');
ok(!emptyRead.ok && emptyRead.error.includes('not available'), 'an empty library fails cleanly rather than throwing');

/* ---------- the rendered site ---------- */

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-docs-'));
const { buildDocs } = (await import(pathToFileURL(path.join(ROOT, 'scripts', 'build-docs.mjs')).href)) as {
  buildDocs: (o: { docsDir?: string; outFile?: string; log?: (s: string) => void }) => unknown;
};
const outFile = path.join(out, 'index.html');
buildDocs({ docsDir: DOCS, outFile, log: () => {} });
const html = fs.readFileSync(outFile, 'utf8');
// The page carries its own script and stylesheet; every check below is about the rendered
// documentation, not about them.
const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

ok(!body.includes('\x01'), 'no placeholder marker survived the renderer');
ok(!/\*\*/.test(body.replace(/<code>[\s\S]*?<\/code>/g, '')), 'no unrendered bold outside code');
ok(!/\]\([a-z0-9#-]+\)/.test(body), 'no unrendered markdown link');
ok(!/^\s*[-*] /m.test(body.replace(/<[^>]+>/g, '')), 'no unrendered list bullet');

const slugs = new Set([...body.matchAll(/data-slug="([^"]+)"/g)].map((m) => m[1]));
ok(slugs.size === lib.size, `one article per page (${slugs.size})`);
const ids = new Set([...body.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
const broken: string[] = [];
for (const m of body.matchAll(/href="#([^"]+)"/g)) {
  const target = m[1];
  if (target === 'main') continue; // the skip link
  const [slug, anchor] = target.split('/');
  if (!slugs.has(slug)) broken.push(`no page #${target}`);
  else if (anchor && !ids.has(anchor)) broken.push(`no anchor #${target}`);
}
ok(broken.length === 0, `every in-page link resolves${broken.length ? `: ${broken.slice(0, 8).join(', ')}` : ''}`);
fs.rmSync(out, { recursive: true, force: true });

/* ---------- the shell on the pages people copy from ---------- */

function fences(file: string): { lang: string; code: string }[] {
  const raw = fs.readFileSync(path.join(DOCS, file), 'utf8');
  return [...raw.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1], code: m[2] }));
}

for (const file of ['advanced.md', 'running-without-vscode.md', 'the-app.md']) {
  const blocks = fences(file).filter((b) => b.lang === 'sh' || b.lang === 'bash');
  ok(blocks.length > 0, `${file} has shell to check`);
  for (const b of blocks) {
    // A leading "$ " is a prompt, not shell.
    const code = b.code.replace(/^\$ /gm, '');
    const r = spawnSync('sh', ['-n'], { input: code, encoding: 'utf8' });
    ok(r.status === 0, `${file}: sh -n on ${JSON.stringify(code.split('\n')[0])} — ${r.stderr.trim()}`);
  }
}

// The systemd unit is shown in full, so it must be a unit and it must start Deskfish.
const unit = fences('advanced.md').find((b) => b.code.includes('[Unit]'));
ok(!!unit, 'advanced.md shows the systemd unit');
ok(unit!.lang === 'text', 'the unit is fenced as text, so no shell check is attempted on it');
const KNOWN = new Set(['Description', 'After', 'ExecStart', 'Restart', 'RestartSec', 'WantedBy', 'Environment', 'WorkingDirectory', 'Type']);
let execStart = '';
for (const line of unit!.code.split('\n')) {
  const t = line.trim();
  if (!t || /^\[(Unit|Service|Install)\]$/.test(t)) continue;
  const kv = t.match(/^([A-Za-z]+)=(.*)$/);
  ok(!!kv, `unit line is key=value: ${t}`);
  ok(KNOWN.has(kv![1]), `unit key is a real one: ${kv![1]}`);
  if (kv![1] === 'ExecStart') execStart = kv![2];
}
ok(/\bdeskfish serve\b/.test(execStart), `ExecStart runs the gateway: ${execStart}`);
ok(execStart.startsWith('/'), 'ExecStart is an absolute path, as systemd requires');

console.log(`docs: ${n} checks passed`);
