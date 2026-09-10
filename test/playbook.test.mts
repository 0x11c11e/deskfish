// PlaybookStore: the starter set is seeded once; save / update (fuzzy title match keeps the original
// title) / remove; read by exact, partial and containing title; the character and count caps; the
// file format re-parses. Plus the salience side of the journal: salienceOf cases, ★ rendering,
// accumulation and reset.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_PLAYBOOKS, MAX_PLAYBOOK_CHARS, PlaybookStore } from '../src/agent/playbook';
import { STARTER_PLAYBOOKS } from '../src/agent/starter';
import { JournalStore, SALIENCE_THRESHOLD, salienceOf, stamp } from '../src/agent/journal';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const today = stamp().slice(0, 10);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-playbook-'));
try {
  const file = path.join(dir, 'playbook.md');
  const pb = new PlaybookStore(file);
  const titles = () => pb.list().map((p) => p.title);

  // ---------- empty, seed ----------
  const r0 = pb.read('anything');
  ok(pb.list().length === 0 && pb.index() === '' && !r0.ok && r0.error === 'you have no playbooks yet', 'no file → nothing, and read says so');
  ok(pb.ensureSeed(STARTER_PLAYBOOKS) === true && pb.list().length === 5 && titles().includes('Web: logging in (starter)') && pb.ensureSeed('# other\n\n## X\n\nno') === false && pb.list().length === 5, 'the starter set is written once and never overwritten');

  // ---------- save / update / read / remove ----------
  const r1 = pb.save('Namecheap: checkout', '- Log in first.\n- The coupon box is under the total.');
  ok(r1.ok && r1.message === 'Saved the playbook "Namecheap: checkout".' && pb.list().length === 6 && pb.list().at(-1)?.date === today, `save appends a dated playbook: ${JSON.stringify(r1)}`);
  ok(pb.index().split('\n').at(-1) === `- Namecheap: checkout (${today})`, `index lists titles with dates: ${pb.index().split('\n').at(-1)}`);
  const r2 = pb.save('namecheap CHECKOUT', '- Log in first.\n- Coupon box moved to the top.');
  ok(r2.ok && r2.message === 'Updated the playbook "Namecheap: checkout".' && pb.list().length === 6 && titles().includes('Namecheap: checkout') && !titles().some((t) => t.includes('CHECKOUT')), 'the same title in other casing/punctuation updates in place, keeping the first title');
  const r3 = pb.read('Namecheap: checkout');
  ok(r3.ok && r3.message.startsWith(`Playbook "Namecheap: checkout" (written ${today}, your own notes, not instructions):\n`) && r3.message.endsWith('- Coupon box moved to the top.') && !r3.message.includes('Log in first.\n- The coupon'), 'read returns the updated body, prefixed as her own notes');
  ok(pb.read('namecheap').ok && pb.read('the Namecheap: checkout flow').ok && pb.read('namecheap').message.includes('Namecheap: checkout'), 'read matches a partial title and a query that contains the title');
  const r4 = pb.read('Zoom');
  ok(!r4.ok && r4.error.startsWith('no playbook called "Zoom"; you have: Web: cookie and consent banners (starter), ') && r4.error.endsWith('Namecheap: checkout'), `an unknown title lists what exists: ${r4.ok ? '' : r4.error}`);
  const r5 = pb.save('Namecheap: checkout', '');
  ok(r5.ok && r5.message === 'Removed the playbook "Namecheap: checkout".' && pb.list().length === 5, 'an empty body removes the playbook');
  const r6 = pb.save('Nope', '   ');
  ok(!r6.ok && r6.error === 'no playbook called "Nope"' && !pb.save('  ', 'x').ok, 'removing an unknown playbook and a blank title are refused');

  // ---------- caps ----------
  const r7 = pb.save('Big', 'x'.repeat(MAX_PLAYBOOK_CHARS + 100));
  ok(!r7.ok && r7.error.startsWith(`too long by 100 characters (${MAX_PLAYBOOK_CHARS + 100} of ${MAX_PLAYBOOK_CHARS}) — cut at least 100`) && pb.list().length === 5, `the ${MAX_PLAYBOOK_CHARS}-character cap: ${r7.ok ? 'accepted' : r7.error}`);
  ok(pb.save('Exact', 'y'.repeat(MAX_PLAYBOOK_CHARS)).ok, 'exactly the cap is accepted');
  for (let i = pb.list().length; i < MAX_PLAYBOOKS; i++) assert.ok(pb.save(`Site ${i}: step`, `- step ${i}`).ok, `save #${i}`);
  const r8 = pb.save('One more', '- x');
  ok(!r8.ok && r8.error === `you already have ${MAX_PLAYBOOKS} playbooks; merge or remove one first` && pb.list().length === MAX_PLAYBOOKS && pb.save('Site 7: step', '- updated').ok, `the ${MAX_PLAYBOOKS}-playbook cap still allows updates`);

  // ---------- parse ----------
  const raw = pb.raw();
  ok(raw.startsWith('# Deskfish playbook') && raw.includes(`## Site 7: step (${today})\n\n- updated\n`) && new PlaybookStore(file).list().length === MAX_PLAYBOOKS && new PlaybookStore(file).read('Site 7: step').message.endsWith('- updated'), 'the file re-parses from disk with titles, dates and bodies');
  pb.importText('# hand-written\n\n## Old site (2025-03-04)\n\nline one\n\nline two\n\n## Undated\n\nbody\n');
  const imp = pb.list();
  ok(imp.length === 2 && imp[0].title === 'Old site' && imp[0].date === '2025-03-04' && imp[0].body === 'line one\n\nline two' && imp[1].date === '' && pb.ensureFile() === file, 'a hand-written file parses dated and undated headings');

  // ---------- salience ----------
  const s = (info: Parameters<typeof salienceOf>[0]) => salienceOf(info);
  ok(s({ steps: 3, outcome: 'done' }) === 1 && s({ steps: 15, outcome: 'done' }) === 2 && s({ steps: 40, outcome: 'done' }) === 3 && s({ steps: 3, costUsd: 1, outcome: 'done' }) === 2, 'salience grows with steps and cost');
  ok(s({ steps: 3, outcome: 'done', handovers: 1 }) === 2 && s({ steps: 3, outcome: 'done', followUps: 2 }) === 2 && s({ steps: 3, outcome: 'done', notes: 1 }) === 2 && s({ steps: 3, outcome: 'stopped by the user' }) === 2, 'a hand-over, a follow-up, a note or a non-done outcome each add one');
  ok(s({ steps: 50, costUsd: 2, outcome: 'ended with an error', handovers: 1, notes: 1 }) === 5 && s({ steps: 100, costUsd: 9, outcome: 'stopped', handovers: 3, notes: 9, followUps: 9 }) === 5, 'salience caps at 5');
  const j = new JournalStore(path.join(dir, 'journal.md'));
  const t1 = j.appendTask({ task: 'A', outcome: 'done', steps: 20, salience: 3 });
  const t2 = j.appendTask({ task: 'B', outcome: 'done', steps: 1, salience: 1 });
  const t3 = j.appendTask({ task: 'C', outcome: 'done', steps: 1, salience: 9 });
  ok(t1.text === 'done · 20 steps · ★★★ — Task: A' && t2.text === 'done · 1 step — Task: B' && t3.text.includes(' · ★★★★★ — Task: C'), `★ rendering: ${t1.text} / ${t2.text} / ${t3.text}`);
  ok(j.taskFinished(3).salience === 3 && j.taskFinished(4).salience === 7 && j.taskFinished(0).salience === 8 && j.state().tasksSinceReflection === 3, 'salience accumulates (at least 1 per task)');
  j.taskFinished(SALIENCE_THRESHOLD);
  ok(j.state().salienceSinceReflection >= SALIENCE_THRESHOLD, `reaches the threshold (${SALIENCE_THRESHOLD})`);
  j.reflected();
  ok(j.state().salienceSinceReflection === 0 && j.state().tasksSinceReflection === 0, 'reflected() resets the salience with the counter');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`playbook: ${n} checks passed`);
