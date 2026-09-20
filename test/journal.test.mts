// JournalStore: the task-line format (steps, cost, the tokens read and how many were fresh, summary
// trimmed to MAX_SUMMARY), the transcript's end fragment (endFragment), notes, "Recently"
// = the last 5 entries, recall scoring (every matching term counts; short queries and no-hit are
// errors), the reflection bookkeeping (counter / pending / reflected() reset), newSinceReflection,
// and re-parsing the file from disk.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { endFragment, JournalStore, MAX_SUMMARY, MAX_TASK_LINE, RECENT_ENTRIES, shortCount, stamp, tokensFragment } from '../src/agent/journal';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-journal-'));
try {
  const file = path.join(dir, 'journal.md');
  const j = new JournalStore(file);
  ok(j.list().length === 0 && j.recent().length === 0 && j.render([]) === '' && j.raw() === '', 'no file → nothing listed, nothing rendered');

  // ---------- entry format ----------
  const e1 = j.appendTask({ task: 'Buy   milk', outcome: 'done', steps: 3, costUsd: 0.125, summary: 'Bought it.' });
  ok(STAMP.test(e1.at) && e1.at === stamp() && e1.kind === 'task' && e1.text === 'done · 3 steps · $0.13 — Task: Buy milk — Bought it.', `task line: ${e1.text}`);
  ok(j.raw().startsWith('# Deskfish journal') && j.raw().endsWith(`- [${e1.at}] ${e1.text}\n`), 'the file gets the header and one dated bullet');
  const e2 = j.appendTask({ task: 'Ping', outcome: 'stopped by the user', steps: 1, costUsd: 0 });
  ok(e2.text === 'stopped by the user · 1 step — Task: Ping', `singular step, no cost, no summary: ${e2.text}`);
  const e3 = j.appendTask({ task: 'Long', outcome: 'done', steps: 2, summary: 'y '.repeat(400) });
  const sum = e3.text.split(' — ')[2];
  ok(sum.length === MAX_SUMMARY && sum.endsWith('…') && !sum.includes('  '), `summary collapsed and trimmed to ${MAX_SUMMARY}: ${sum.length}`);
  const e4 = j.appendTask({ task: 'z'.repeat(200), outcome: 'done', steps: 2 });
  ok(e4.text === `done · 2 steps — Task: ${'z'.repeat(MAX_TASK_LINE - 1)}…`, `the task is cut at ${MAX_TASK_LINE}`);
  const note = j.appendNote('Remember to check the invoice\nbefore paying');
  ok(note.kind === 'note' && note.text === 'Remember to check the invoice before paying' && j.raw().includes(`- [${note.at}] note — Remember to check the invoice before paying\n`), 'a note is marked "note — " and kept to one line');
  ok(j.list().length === 5 && j.list()[4].kind === 'note' && j.list()[0].text === e1.text, 'list parses tasks and notes in order');

  // ---------- recent ----------
  j.appendTask({ task: 'alpha beta gamma', outcome: 'done', steps: 4, summary: 'three terms' });
  j.appendTask({ task: 'alpha only', outcome: 'done', steps: 4 });
  j.appendNote('beta alone');
  const rec = j.recent();
  ok(rec.length === RECENT_ENTRIES && rec[0].text === e4.text && rec.at(-1)?.text === 'beta alone' && rec.some((e) => e.kind === 'note'), `recent = the last ${RECENT_ENTRIES}, notes included`);
  ok(j.render(rec).split('\n').length === 5 && j.render(rec).endsWith(`- [${rec.at(-1)!.at}] note — beta alone`), 'render writes one dated line per entry');

  // ---------- recall ----------
  const r1 = j.recall('alpha beta', 1);
  ok(r1.ok && r1.message.startsWith(`From your journal (1 of ${j.list().length} entries):\n`) && r1.message.includes('alpha beta gamma') && !r1.message.includes('alpha only'), `every matching term counts: ${r1.ok ? r1.message : r1.error}`);
  const r2 = j.recall('invoice CHECK');
  ok(r2.ok && r2.message.includes('note — Remember to check the invoice') && r2.message.split('\n').length === 2, 'recall is case-insensitive and lists only hits');
  const r3 = j.recall('ab');
  ok(!r3.ok && r3.error === 'recall needs a few words to search for', 'terms under 3 characters are dropped → too-short query rejected');
  const r4 = j.recall('zzzzqq');
  ok(!r4.ok && r4.error === 'nothing in your journal matches "zzzzqq"', 'no hit → error');

  // ---------- reflection bookkeeping ----------
  const s0 = j.state();
  ok(s0.tasksSinceReflection === 0 && s0.salienceSinceReflection === 0 && s0.reflectedLines === 0 && s0.pending.length === 0 && s0.drift.length === 0, 'fresh state');
  ok(j.taskFinished().tasks === 1 && j.taskFinished(3).salience === 4 && j.state().tasksSinceReflection === 2, 'taskFinished counts tasks and adds salience');
  j.addPending({ kind: 'revise_self', section: 'People', text: 'Sam likes short answers.' });
  j.addPending({ kind: 'note', text: 'Think about this.' });
  const p = j.state().pending;
  ok(p.length === 2 && STAMP.test(p[0].at) && p[0].kind === 'revise_self' && p[0].section === 'People' && p[1].kind === 'note', 'pending proposals are stamped and kept');
  ok(j.newSinceReflection().length === j.list().length, 'before any reflection every entry is new');
  j.reflected();
  const s1 = j.state();
  ok(s1.tasksSinceReflection === 0 && s1.salienceSinceReflection === 0 && s1.pending.length === 0 && s1.reflectedLines === j.list().length && STAMP.test(s1.lastReflectionAt ?? ''), 'reflected() resets the counters and marks the journal read');
  j.appendNote('after the reflection');
  ok(j.newSinceReflection().length === 1 && j.newSinceReflection()[0].text === 'after the reflection', 'only entries after the reflection are new');

  // ---------- re-parse from disk ----------
  fs.appendFileSync(file, 'a stray line without a bullet\n- [2026-01-02 03:04] done · 1 step — Task: hand-written — by the user\n');
  const again = new JournalStore(file);
  ok(again.list().length === j.list().length && again.list().at(-1)?.at === '2026-01-02 03:04' && again.list().at(-1)?.text === 'done · 1 step — Task: hand-written — by the user' && again.state().reflectedLines === s1.reflectedLines, 're-parse from disk keeps every dated bullet and the state; stray lines are ignored');
  const fresh = new JournalStore(path.join(dir, 'other', 'journal.md'));
  ok(fresh.ensureFile() === fresh.file && fresh.raw().startsWith('# Deskfish journal') && fresh.list().length === 0, 'ensureFile writes the header only');
  fresh.importText(j.raw(), { tasksSinceReflection: 4, reflectedLines: 2 });
  ok(fresh.list().length === j.list().length && fresh.state().tasksSinceReflection === 4 && fresh.state().reflectedLines === 2 && fresh.state().pending.length === 0, 'importText restores the text and the state');

  // ---------- a task's tokens on its line ----------
  // `status` shows the counts only while she runs (decision 127): the journal line keeps what a
  // comparison between builds needs — what the task read in all, and how much of it was fresh.
  const jt = new JournalStore(path.join(dir, 'tokens', 'journal.md'));
  const t1 = jt.appendTask({ task: 'Count', outcome: 'done', steps: 16, costUsd: 0.4, tokens: { input: 61_000, output: 3_000, cacheRead: 410_000, cacheWrite: 5_000 } });
  ok(t1.text === 'done · 16 steps · $0.40 · 471k tokens (61k fresh) — Task: Count', `the tokens read and how many were fresh, after the cost: ${t1.text}`);
  const t2 = jt.appendTask({ task: 'Small', outcome: 'done', steps: 1, tokens: { input: 812, output: 40, cacheRead: 0, cacheWrite: 0 } });
  ok(t2.text === 'done · 1 step · 812 tokens (812 fresh) — Task: Small', `below a thousand, the plain number: ${t2.text}`);
  const t3 = jt.appendTask({ task: 'Zero', outcome: 'done', steps: 2, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  ok(t3.text === 'done · 2 steps — Task: Zero', 'a task whose provider reported nothing keeps the old line, byte for byte');
  const t4 = jt.appendTask({ task: 'Sub', outcome: 'done', steps: 3, subscription: true, reason: 'lesson', salience: 2, tokens: { input: 9_500, output: 1, cacheRead: 2_430_000, cacheWrite: 0 } });
  ok(t4.text === 'done · 3 steps · subscription · 2.4M tokens (9.5k fresh) · lesson · ★★ — Task: Sub', `the fragment sits between the cost word and the reason: ${t4.text}`);
  ok(shortCount(2_440_000) === '2.4M' && shortCount(9_500) === '9.5k' && shortCount(12_345) === '12k' && shortCount(10_000_000) === '10M' && shortCount(999) === '999' && shortCount(1_000) === '1k', 'k and M, with one decimal below 10');
  ok(tokensFragment({ input: 422_000, output: 1, cacheRead: 2_017_000, cacheWrite: 0 }) === ' · 2.4M tokens (422k fresh)' && tokensFragment(undefined) === '', 'the TransUnion line: 2.44M read, 422k fresh; nothing when nothing is known');
  ok(endFragment({ steps: 16, tokens: { input: 61_000, output: 0, cacheRead: 410_000, cacheWrite: 0 } }) === ' · 16 steps · 471k tokens (61k fresh)' && endFragment({ steps: 1 }) === ' · 1 step' && endFragment(undefined) === '', "the transcript's end fragment: the steps always, the tokens when known");
  ok(jt.list().length === 4 && new JournalStore(jt.file).list()[0].text === t1.text, 'the lines with counts re-parse from disk like any other');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`journal: ${n} checks passed`);
