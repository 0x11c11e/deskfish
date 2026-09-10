#!/usr/bin/env node
// Runs every test/*.test.mts with tsx, one after another, and reports. `npm test` or
// `npm test -- page waitfor` (substring filter). Suites are self-contained: the ones that need a
// desktop spawn the mock daemon themselves on their own port; the ones that need a model run a
// fake HTTP server in-process. No network, no container, nothing touches the user's desktop.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.mts'))
  .filter((f) => !only.length || only.some((o) => f.includes(o)))
  .sort();
let failed = 0;
const t0 = Date.now();
for (const f of files) {
  const started = Date.now();
  const r = spawnSync('npx', ['tsx', path.join(dir, f)], { encoding: 'utf8', timeout: 300_000, env: process.env });
  const last = (r.stdout || '').trim().split('\n').pop() || '';
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status === 0) {
    console.log(`ok    ${f.padEnd(28)} ${last}  (${secs}s)`);
  } else {
    failed++;
    const err = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').filter((l) => /AssertionError|Error:|error TS/.test(l)).slice(0, 4).join('\n      ');
    console.log(`FAIL  ${f}\n      ${err || `exit ${r.status}${r.signal ? ` (${r.signal})` : ''}`}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} suites passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed ? 1 : 0);
