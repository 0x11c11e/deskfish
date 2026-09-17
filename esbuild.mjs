// Build script: three bundles.
//   dist/extension.js        - the VS Code extension host code (Node, CJS, `vscode` external)
//   dist/webview/{chat,desktop}.js - browser bundles for the two webviews (noVNC lives in desktop.js)
//   dist/web/shim.js         - the web page's stand-in for VS Code (the gateway inlines it into the page it serves)
//   dist/smoke.js            - headless CLI runner for testing the agent loop without VS Code
//   dist/gateway.js, dist/cli.js - the gateway (`deskfish serve`, started detached by the extension) and the `deskfish` command
//   dist/app/main.js         - the app's Electron main process (only when app/node_modules is installed: `npm ci --prefix app`)
//   docs/site/index.html     - the documentation site, rendered from docs/*.md (scripts/build-docs.mjs)
import * as esbuild from 'esbuild';
import { buildDocs } from './scripts/build-docs.mjs';

buildDocs();

// The reading library ships fixed: hash every passage so a file changed on disk is not read.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  // The version and a per-build id: a gateway left running by an older build is recognised and replaced.
  define: { __DESKFISH_VERSION__: JSON.stringify(pkg.version), __DESKFISH_BUILD__: JSON.stringify(Date.now().toString(36)) },
};
// ws probes for these native speed-ups and runs without them.
const wsOptional = ['bufferutil', 'utf-8-validate'];

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', ...wsOptional],
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
    entryPoints: ['web/shim.ts'],
    outfile: 'dist/web/shim.js',
    platform: 'browser',
    format: 'iife',
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
  ...['gateway', 'cli'].map((name) => ({
    ...common,
    entryPoints: ['src/gateway/cli.ts'],
    outfile: `dist/${name}.js`,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: wsOptional,
    banner: { js: '#!/usr/bin/env node' },
  })),
];

// The app is its own npm package (Electron and its builder stay out of the extension's install); without
// its node_modules there is nothing to bundle electron-updater from, and the extension builds as before.
if (existsSync('app/node_modules/electron-updater')) {
  builds.push({
    ...common,
    entryPoints: ['app/main.ts'],
    outfile: 'dist/app/main.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron', ...wsOptional],
  });
} else {
  console.log('app: skipped (no app/node_modules; run npm ci --prefix app to build the app)');
}

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
