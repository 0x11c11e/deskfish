// The npm tarball: `deskfish.tgz` on every release is the server install
// (`sudo npm i -g https://…/releases/latest/download/deskfish.tgz` gives the `deskfish` command).
// `package.json`'s `files` field decides what it carries, and it must carry exactly what
// `cli.ts` looks for next to itself — no more. Without a `files` field npm packed 308 files:
// every source map, the extension and gateway bundles, the smoke runners and `dist/app/main.js`.
// `npm pack --dry-run --json` is the same listing `npm pack` writes, without writing anything.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => {
  assert.ok(c, m);
  n++;
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'package.json has a files field');
ok(pkg.bin?.deskfish === 'dist/cli.js', 'the deskfish command is dist/cli.js');

const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
ok(r.status === 0, `npm pack --dry-run ran (${r.status}) ${r.stderr.split('\n').slice(-3).join(' ')}`);
// npm prints the listing on stdout and its notices on stderr; the JSON is the whole of stdout.
const files: string[] = JSON.parse(r.stdout)[0].files.map((f: { path: string }) => f.path);
ok(files.length > 0, 'the tarball has files');

// What the CLI needs beside itself: `resourceDir` is the package root (cli.ts), and from there
// it reads docs/ (the *.md for read_docs, site/index.html for /docs), web/, media/, library/,
// docker/desktop/ and package.json (the settings schema).
for (const needed of [
  'package.json',
  'dist/cli.js',
  'dist/web/shim.js',
  'dist/webview/chat.js',
  'dist/webview/desktop.js',
  'web/index.html',
  'web/signin.html',
  'web/web.css',
  'media/icon.png',
  'docs/site/index.html',
  'docs/getting-started.md',
  'docs/running-without-vscode.md',
  'docs/the-app.md',
  'docker/desktop/Dockerfile',
  'docker/desktop/daemon.mjs',
  'library/manifest.json',
]) {
  ok(files.includes(needed), `the tarball carries ${needed}`);
}
ok(
  files.some((f) => f.startsWith('library/') && f.endsWith('.md')),
  'the readings are in the tarball',
);
// Every documentation page the bot may be asked for.
const pages = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md'));
for (const page of pages) ok(files.includes(`docs/${page}`), `docs/${page} is in the tarball`);

// What must never be in it.
const forbidden: [RegExp, string][] = [
  [/\.map$/, 'a source map'],
  [/(^|\/)extension\.js$/, "the extension's bundle"],
  [/(^|\/)gateway\.js$/, 'the gateway bundle (cli.js is the same program)'],
  [/smoke/i, 'a smoke runner'],
  [/^app\//, 'the app'],
  [/^relay\//, 'the relay (its own package and its own container)'],
  [/^dist\/app\//, "the app's main process"],
  [/^src\//, 'the sources'],
  [/^test\//, 'the tests'],
  [/^site\//, 'the website'],
  [/^handbook\//, 'the private handbook'],
  [/^growth\//, 'the private growth notes'],
  [/^demo\//, 'the demo footage'],
  [/^\.github\//, 'the workflows'],
  [/CLAUDE\.md$/, 'CLAUDE.md'],
  [/\.env$/, 'an env file'],
  [/\.vsix$/, 'a vsix'],
];
for (const [re, what] of forbidden) {
  const hit = files.filter((f) => re.test(f));
  ok(hit.length === 0, `no ${what} in the tarball${hit.length ? `: ${hit.slice(0, 5).join(', ')}` : ''}`);
}

// The release workflow is what actually uploads it, under a stable name.
const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
ok(/npm pack/.test(wf), 'the release workflow packs the tarball');
ok(/deskfish\.tgz/.test(wf), 'it uploads it as deskfish.tgz, so releases/latest/download/deskfish.tgz works');

// And every workflow that runs this suite must build first: the listing above is `npm pack
// --dry-run`, which lists only files that exist, and `dist/` exists only after `npm run build`.
// Locally dist/ is always there, so this order is wrong only on a fresh checkout — which is
// every CI run. It cost the first 0.2 release (release.yml, 2026-09-19) and then every pull
// request check (pr.yml, one red run merged as pull request 2).
for (const name of ['release.yml', 'pr.yml']) {
  const y = fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
  const build = y.indexOf('run: npm run build');
  const test = y.indexOf('run: npm test');
  ok(build >= 0 && test >= 0 && build < test, `${name} builds before it tests (the tarball listing needs dist/)`);
}

console.log(`pack: ${n} checks passed`);
