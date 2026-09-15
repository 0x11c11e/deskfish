// The tank's image build says what it is doing and how long it takes: the prefix before the build
// starts, "<prefix> — step X of Y" on each STEP line at once, and inside the long package step what
// apt is doing (downloading N, unpacking, setting up), at most one progress call per second.
// A fake `podman` on PATH prints a scripted build; nothing touches a real container engine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopEngine } from '../src/desktop/engine';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-build-'));
const ctx = path.join(dir, 'ctx');
fs.mkdirSync(ctx);
fs.writeFileSync(path.join(ctx, 'Dockerfile'), 'FROM scratch\n');
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);

/** Writes a fake podman whose `build` prints `script` (lines; "sleep S" pauses). */
function fakePodman(script: string[], exit = 0) {
  const body = script.map((l) => (l.startsWith('sleep ') ? l : `printf '%s\\n' ${JSON.stringify(l)}`)).join('\n');
  fs.writeFileSync(path.join(bin, 'podman'), `#!/bin/sh\n[ "$1" = build ] || exit 0\n${body}\nexit ${exit}\n`, { mode: 0o755 });
}
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

function engine() {
  const calls: { t: number; m: string }[] = [];
  const t0 = Date.now();
  const e = new DesktopEngine(
    { buildContext: ctx, cli: 'podman', daemonUrl: 'http://127.0.0.1:1', daemonToken: '', vncPassword: '', screen: '1280x800' },
    { info() {}, progress(m) { calls.push({ t: Date.now() - t0, m }); } },
  );
  return { e, calls };
}

const B = 'Building the desktop image — a few minutes the first time';

// 1. The whole scripted build: message sequence and the throttle
{
  const steps24 = Array.from({ length: 20 }, (_, i) => `STEP ${i + 5}/24: RUN true`);
  fakePodman([
    'sleep 0.2',
    'STEP 1/24: FROM debian:trixie-slim',
    'STEP 2/24: ENV DEBIAN_FRONTEND=noninteractive',
    'STEP 3/24: RUN apt-get update && apt-get install -y --no-install-recommends xfce4 firefox-esr',
    'Get:1 http://deb.debian.org/debian trixie InRelease [140 kB]',
    'Get:2 http://deb.debian.org/debian trixie-updates InRelease [47 kB]',
    'Get:3 http://deb.debian.org/debian trixie/main amd64 Packages [9670 kB]',
    'sleep 1.2',
    'Get:4 http://deb.debian.org/debian trixie/main amd64 libc6 amd64 2.41-12 [2800 kB]',
    'Get:5 http://deb.debian.org/debian trixie/main amd64 xfce4 amd64 4.20 [9 kB]',
    'Fetched 12.6 MB in 2s (6300 kB/s)',
    'sleep 1.2',
    'Selecting previously unselected package libc6.',
    'Unpacking libc6:amd64 (2.41-12) ...',
    'Unpacking xfce4 (4.20) ...',
    'sleep 1.2',
    'Setting up libc6:amd64 (2.41-12) ...',
    'Processing triggers for man-db ...',
    'Setting up xfce4 (4.20) ...',
    'sleep 1.2',
    'STEP 4/24: COPY daemon /opt/daemon',
    ...steps24,
    'COMMIT localhost/deskfish-desktop:latest',
    '--> 1a2b3c4d5e6f',
    'Successfully tagged localhost/deskfish-desktop:latest',
  ]);
  const { e, calls } = engine();
  await e.build('podman');
  const msgs = calls.map((c) => c.m);
  ok(msgs[0] === B && calls[0].t < 150, `the prefix is announced before the build prints anything (${calls[0].t} ms): ${msgs[0]}`);
  ok(msgs[1] === `${B} — step 1 of 24` && msgs[2] === `${B} — step 2 of 24` && msgs[3] === `${B} — step 3 of 24`, `STEP 1, 2, 3 each at once, never throttled: ${msgs.slice(1, 4).join(' | ')}`);
  const i4 = msgs.indexOf(`${B} — step 4 of 24`);
  const inside = msgs.slice(4, i4);
  ok(JSON.stringify(inside) === JSON.stringify([
    `${B} — step 3 of 24 · downloading packages (3)`,
    `${B} — step 3 of 24 · downloading packages (5)`,
    `${B} — step 3 of 24 · unpacking packages`,
    `${B} — step 3 of 24 · setting up packages`,
  ]), `inside step 3: the latest apt line of each second, others dropped, other lines leave it alone:\n  ${inside.join('\n  ')}`);
  const stepTimes = calls.slice(4, i4).map((c) => c.t);
  const gaps = stepTimes.map((t, i) => t - (i ? stepTimes[i - 1] : calls[3].t));
  ok(gaps.every((g) => g >= 950), `at most one progress call per second inside a step (gaps ${gaps.join(', ')} ms)`);
  ok(msgs.slice(i4).length === 21 && msgs.slice(i4).every((m, i) => m === `${B} — step ${i + 4} of 24`), `STEP 4 … STEP 24 each at once, none swallowed by the throttle (${msgs.slice(i4).length})`);
  ok(msgs.at(-1) === `${B} — step 24 of 24`, `COMMIT and the tag lines leave the last message alone: ${msgs.at(-1)}`);
  ok(new Set(msgs).size === msgs.length, 'no message is repeated');
}

// 2. A trailing apt line is not lost: Get:1 right after the step (inside the second), then silence
{
  fakePodman(['STEP 1/3: FROM debian', 'STEP 2/3: RUN apt-get install -y x', 'Get:1 http://deb.debian.org/debian trixie InRelease', 'Get:2 http://deb.debian.org/debian x [1 kB]', 'sleep 1.5', 'STEP 3/3: RUN true']);
  const { e, calls } = engine();
  await e.build('podman');
  const msgs = calls.map((c) => c.m);
  ok(msgs.includes(`${B} — step 2 of 3 · downloading packages (2)`), `the newest line of a throttled second is shown when the second is up: ${msgs.join(' | ')}`);
}

// 3. Updating: its own prefix; a pending apt message never lands after the build ends
{
  const U = 'Updating the desktop image after the update — a few minutes';
  fakePodman(['STEP 1/2: FROM debian', 'STEP 2/2: RUN apt-get install -y x', 'Unpacking x (1) ...']);
  const { e, calls } = engine();
  await e.build('podman', 'Updating');
  await new Promise((r) => setTimeout(r, 1300));
  const msgs = calls.map((c) => c.m);
  ok(msgs[0] === U && msgs[1] === `${U} — step 1 of 2` && msgs.at(-1) === `${U} — step 2 of 2`, `Updating prefix on every message, nothing after the build closed: ${msgs.join(' | ')}`);
}

// 4. BuildKit output: "#7 [3/24] RUN …" is a step, "#7 12.3 Get:4 …" is apt output
{
  fakePodman(['#5 [1/24] FROM docker.io/library/debian', '#7 [3/24] RUN apt-get install -y x', 'sleep 1.05', '#7 1.234 Get:4 http://deb.debian.org/debian x [1 kB]']);
  const { e, calls } = engine();
  await e.build('podman');
  const msgs = calls.map((c) => c.m);
  ok(JSON.stringify(msgs) === JSON.stringify([B, `${B} — step 1 of 24`, `${B} — step 3 of 24`, `${B} — step 3 of 24 · downloading packages (4)`]), `BuildKit lines: ${msgs.join(' | ')}`);
}

// 5. A failed build still rejects with the last line
{
  fakePodman(['STEP 1/2: FROM debian', 'Error: something broke'], 125);
  const { e } = engine();
  const err = await e.build('podman').then(() => undefined, (x: Error) => x);
  ok(err && /exit 125.*something broke/.test(err.message), `failure rejects with the tail: ${err?.message}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`buildprogress: ${n} checks passed`);
