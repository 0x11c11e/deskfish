// Build script: three bundles.
//   dist/extension.js        - the VS Code extension host code (Node, CJS, `vscode` external)
//   dist/webview/{chat,desktop}.js - browser bundles for the two webviews (noVNC lives in desktop.js)
//   dist/smoke.js            - headless CLI runner for testing the agent loop without VS Code
//   docs/site/index.html     - the documentation site, rendered from docs/*.md (scripts/build-docs.mjs)
import * as esbuild from 'esbuild';
import { buildDocs } from './scripts/build-docs.mjs';

buildDocs();

// The reading library ships fixed: hash every passage so a file changed on disk is not read.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
{
  const manifest = {};
  for (const f of readdirSync('library').filter((f) => f.endsWith('.md')).sort()) {
    manifest[f] = createHash('sha256').update(readFileSync(`library/${f}`, 'utf8')).digest('hex');
  }
  writeFileSync('library/manifest.json', JSON.stringify(manifest, null, 1) + '\n');
  console.log(`library: ${Object.keys(manifest).length} readings hashed → library/manifest.json`);
}

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/webview/chat.ts', 'src/webview/desktop.ts'],
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
  },
  {
    ...common,
    entryPoints: ['src/smoke.ts', 'src/smokeDesktop.ts'],
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
