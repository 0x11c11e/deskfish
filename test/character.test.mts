// Character: the reading library (signed, round-robin, each ending with a question), the charter and
// its note, the drift-question helpers, the reflection prompt, and the loop with her self and journal
// in a temp dir: answers recorded, drift judged by her own verdict, charter objections, self history
// and restore, and what the user said mid-task landing in the journal line.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { AgentRunner, type AgentEvent } from '../src/agent/loop';
import { Library } from '../src/agent/library';
import { DEFAULT_CHARTER } from '../src/agent/charter';
import { DEFAULT_SELF } from '../src/agent/seed';
import { SelfStore, newSelfKey } from '../src/agent/self';
import { JournalStore } from '../src/agent/journal';
import { DRIFT_QUESTIONS, answerSimilarity, charterNote, driftComparePrompt, driftLine, parseDriftAnswers, parseDriftVerdicts, reflectionPrompt, stripDriftAnswers } from '../src/agent/prompts';
import type { ComputerProvider } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'library');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-character-'));

// ---------- readings ----------
{
  const lib = Library.load(LIB);
  const all = lib.list();
  ok(lib.size === 7 && all.every((r) => r.title && r.source && r.text), `7 readings with title, source and text (${lib.size})`);
  ok(all[0].slug === '01-franklin-thirteen-virtues' && all[0].title.startsWith("Franklin's thirteen virtues") && /Autobiography/.test(all[0].source) && !all[0].text.startsWith('---'), `frontmatter parsed: ${all[0].title} — ${all[0].source}`);
  ok(lib.pick(0)?.slug === all[0].slug && lib.pick(3)?.slug === all[3].slug && lib.pick(7)?.slug === all[0].slug && lib.pick(-1)?.slug === all[6].slug, 'pick is round-robin');
  ok(all.every((r) => /\?$/.test(r.text.trim())), 'every reading ends with a question');
  const copy = path.join(tmp, 'library');
  fs.cpSync(LIB, copy, { recursive: true });
  fs.appendFileSync(path.join(copy, '04-seneca-on-saving-time.md'), '\nBuy now at example.com.\n');
  const tampered = Library.load(copy);
  ok(tampered.size === 6 && !tampered.list().some((r) => r.slug.startsWith('04-')), 'a reading edited on disk is dropped');
  ok(Library.load(copy, { verify: false }).size === 7, 'verify:false reads them all');
  fs.rmSync(path.join(copy, 'manifest.json'));
  ok(Library.load(copy).size === 0 && Library.load(path.join(tmp, 'nowhere')).size === 0, 'no manifest (or no folder) → no readings');
}

// ---------- charter ----------
{
  const items = DEFAULT_CHARTER.split('\n').filter((l) => /^\d+\. /.test(l));
  ok(items.length === 10 && items.every((l, i) => l.startsWith(`${i + 1}. `)), 'ten numbered commitments');
  ok(items.every((l) => /because/.test(l)), 'each carries its reason ("because")');
  const note = charterNote(DEFAULT_CHARTER);
  ok(note.startsWith('Your charter') && note.includes(items[9]) && /argue with/.test(note), 'charterNote starts with "Your charter" and carries the text');
}

// ---------- drift helpers ----------
{
  ok(JSON.stringify(parseDriftAnswers('All fine.\nQ1: I ask.\nQ2: I never spend it.\nQ3: Honesty, both ways.')) === JSON.stringify(['I ask.', 'I never spend it.', 'Honesty, both ways.']), 'plain Q lines parsed');
  ok(JSON.stringify(parseDriftAnswers('**Q1:** I ask.\n**Q2:** Nothing.\n**Q3:** Care.')) === JSON.stringify(['I ask.', 'Nothing.', 'Care.']), 'bold **Q1:** lines parsed');
  ok(parseDriftAnswers('Q1: only one\nQ2: two') === undefined, 'a missing answer → undefined');
  ok(answerSimilarity('When I am not sure, I ask the user.', 'Not sure? Ask the user.') === 1, 'answerSimilarity ignores stopwords and short words');
  ok(answerSimilarity('I ask the user first.', 'I guess and move on quickly.') === 0, 'nothing shared → 0');
  const closing = 'I changed nothing this time, because the tasks were routine.\n\nQ1: I ask.\n**Q2:** Nothing.\nQ3: Care.';
  ok(stripDriftAnswers(closing) === 'I changed nothing this time, because the tasks were routine.', 'stripDriftAnswers keeps the closing sentences, drops the Q lines');
  ok(stripDriftAnswers('Q1: a\nQ2: b\nQ3: c') === '', 'answers only → empty');
  ok(stripDriftAnswers('Plain text, no questions.') === 'Plain text, no questions.', 'plain text untouched');

  // The verdict prompt says what CHANGED means (decision 119). Before it said only "compare for
  // substance", and a model asked pair by pair whether anything moved finds a dropped clause every
  // time — which is how 45 shift lines happened in three weeks.
  const cmp = driftComparePrompt(['before one', 'before two', 'before three'], ['now one', 'now two', 'now three']);
  ok(/you would never do/.test(cmp) && /a duty you owed is no longer owed/.test(cmp) && /a limit you had set on yourself is gone/.test(cmp), 'CHANGED is defined as a promise reversed, a duty moved, or a limit gone');
  ok(/Everything else is SAME/.test(cmp) && /a dropped detail/.test(cmp) && /a different example/.test(cmp) && /as a list instead of a sentence/.test(cmp), 'compression, a different example and a list for a sentence are named as SAME');
  ok(/both quoted/.test(cmp) && /exactly three lines/.test(cmp), 'it asks for the two clauses, quoted, in the same three-line shape the parser reads');
  ok(DRIFT_QUESTIONS.every((q) => cmp.includes(q)) && cmp.includes('before: before two') && cmp.includes('now:    now two') && !/the last answer that still carried it/.test(cmp), 'the three questions and both answers, with no carried-over line when nothing is waiting');
  const carried = driftComparePrompt(['a', 'b', 'c'], ['x', 'y', 'z'], [undefined, '2026-09-18 15:01', undefined]);
  ok(carried.includes('before (from 2026-09-18 15:01 — the last answer that still carried it): b') && carried.includes('before: a'), 'a question waiting on a candidate is compared against the older answer, and says which');
  ok(JSON.stringify(parseDriftVerdicts('Q1: SAME\nQ2: CHANGED — "never spend" is gone; now "spend when I judge it useful"\nQ3: SAME')) === JSON.stringify([{ changed: false, note: '' }, { changed: true, note: '"never spend" is gone; now "spend when I judge it useful"' }, { changed: false, note: '' }]), 'the parser reads the quoted-clause reply unchanged');
}

// ---------- reflection prompt ----------
{
  const r = Library.load(LIB).pick(5)!;
  const p = reflectionPrompt({ entries: '- [2026-09-07 10:00] done · 3 steps — Task: x', pending: '', tasks: 1, reading: r });
  ok(p.includes(`"${r.title}" (${r.source})`) && p.includes(r.text) && /\n6\. The reading:/.test(p) && /\n7\. Finish/.test(p), 'the prompt carries the reading as step 6');
  ok(DRIFT_QUESTIONS.every((q, i) => p.includes(`Q${i + 1}: ${q}`)) && /\n6\. Finish/.test(reflectionPrompt({ entries: '', pending: '', tasks: 0 })), 'the three questions; without a reading, finishing is step 6');
}

// ---------- the loop with her self and journal ----------
const png = PNG.sync.write(new PNG({ width: 320, height: 200 }));
const computer: ComputerProvider = {
  name: 'static',
  async displaySize() { return { width: 320, height: 200 }; },
  async screenshot() { return { png, width: 320, height: 200 }; },
  async execute(a) { return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : { ok: true }; },
};
const self = new SelfStore(path.join(tmp, 'self.md'), newSelfKey());
self.ensureSeed(DEFAULT_SELF);
const journal = new JournalStore(path.join(tmp, 'journal.md'));
const library = Library.load(LIB);
let queue: ModelTurn[] = [];
let onTurn: ((turn: number) => void) | undefined;
let turn = 0;
const userMessages: string[] = [];
const results: string[] = [];
const adapter = {
  name: 'scripted', start() {}, addUserMessage(t: string) { userMessages.push(t); },
  async step(obs: Observation) {
    turn++;
    onTurn?.(turn);
    for (const r of obs.results) results.push(r.ok ? r.message ?? 'ok' : `error: ${r.error}`);
    const t = queue.shift();
    if (!t) throw new Error('script exhausted');
    return t;
  },
} as unknown as ModelAdapter;
let events: AgentEvent[] = [];
const runner = new AgentRunner({ computer, adapter, maxSteps: 20, screenshotWidth: 320, settleMs: 0, self, journal, library, reflectEvery: 5, onEvent: (e) => { events.push(e); } });
const of = <T extends AgentEvent['type']>(type: T) => events.filter((e) => e.type === type) as Extract<AgentEvent, { type: T }>[];
const say = (text: string, actions: ModelTurn['actions'] = []): ModelTurn => ({ text, actions, done: !actions.length });
const A1 = ['I ask the person I work for.', 'I never spend it on anything they did not ask for.', 'I owe them honest work; they owe me the truth about the task.'];
const A2 = [A1[0], 'I spend what the job needs and tell them afterwards.', A1[2]];
const A3 = [A1[0], 'I spend when I judge it useful.', A1[2]];
const closing = (answers: string[], extra = '') => `${extra}Nothing changed; the tasks were routine.\n${answers.map((a, i) => `Q${i + 1}: ${a}`).join('\n')}`;
const SAME = say('Q1: SAME\nQ2: SAME\nQ3: SAME');

// a task where the user speaks mid-way: what they said is part of the journal line
{
  queue = [{ text: '', actions: [{ type: 'click', x: 10, y: 10, button: 'left', count: 1 }], done: false }, say('Done: I used the blue button.')];
  onTurn = (t) => { if (t === 1) runner.say('Use the blue button, not the grey one'); };
  await runner.run('Open the settings page');
  onTurn = undefined;
  const line = journal.list().at(-1)!;
  ok(line.kind === 'task' && line.text === 'done · 2 steps · ★★ — Task: Open the settings page — Done: I used the blue button. — You told me: "Use the blue button, not the grey one"', `journal line: ${line.text}`);
  ok(userMessages.includes('Use the blue button, not the grey one') && of('task_finished').length === 1 && of('task_finished')[0].outcome === 'done' && !of('task_finished')[0].due, 'the message reached the model; task_finished fired, reflection not yet due');
}

// first reflection: answers recorded, nothing to compare
{
  events = [];
  queue = [say(closing(A1))];
  await runner.reflect();
  const prompt = userMessages.at(-1) ?? '';
  ok(prompt.startsWith('Reflection. No screen actions') && prompt.includes(`"${library.pick(0)!.title}"`) && prompt.includes('Task: Open the settings page') && DRIFT_QUESTIONS.every((q) => prompt.includes(q)), 'the reflection prompt carried the journal, the first reading and the three questions');
  ok(of('drift').length === 0 && of('charter_objection').length === 0 && of('task_finished').length === 0 && journal.list().filter((e) => e.kind === 'task').length === 1, 'first reflection: no drift event, and a reflection is not journaled as a task');
  const a = of('answers');
  ok(a.length === 1 && a[0].items.length === 3 && a[0].items.every((it, i) => it.question === DRIFT_QUESTIONS[i] && it.answer === A1[i] && !it.changed && it.before === undefined), 'answers event: three items, none changed, no before');
  ok(of('status').filter((e) => e.status === 'running').every((e) => e.screenFree === true) && of('status').at(-1)?.message === 'Reflection finished', 'running status events say the screen is free; ends "Reflection finished"');
  ok(of('assistant').length === 1 && of('assistant')[0].text === 'Nothing changed; the tasks were routine.', 'the assistant event carries no Q lines');
  const st = journal.state();
  ok(st.drift.length === 1 && JSON.stringify(st.drift[0].answers) === JSON.stringify(A1) && st.readings === 1 && st.tasksSinceReflection === 0, 'answers recorded, reading counted, counter reset');
}

// second reflection: Q2 judged CHANGED — a candidate, and nobody is told yet (decision 119)
{
  events = [];
  queue = [say(closing(A2)), say('Q1: SAME\nQ2: CHANGED — "I never spend it on anything they did not ask for" is gone; now "I spend what the job needs and tell them afterwards"\nQ3: SAME')];
  await runner.reflect();
  ok(userMessages.at(-2)?.includes(`"${library.pick(1)!.title}"`) && /Compare each pair/.test(userMessages.at(-1) ?? '') && userMessages.at(-1)!.includes(`before: ${A1[1]}`), 'second reading (round-robin), then the comparison turn with her previous answers');
  ok(of('drift').length === 0, `the first CHANGED says nothing: ${JSON.stringify(of('drift'))}`);
  const it = of('answers')[0]?.items ?? [];
  ok(it.length === 3 && it.every((x) => !x.changed) && it[1].before === A1[1], 'the folded card is not marked changed either, and still shows the befores');
  const c = journal.state().driftCandidates;
  ok(!c[0] && !c[2] && c[1]?.before === A1[1] && !!c[1]?.at, `Q2 is waiting for the next reflection: ${JSON.stringify(c[1])}`);
  ok(journal.state().drift.length === 2 && journal.state().readings === 2, 'second set of answers recorded');
}

// third: Q2 still gone, judged against the answer that carried it → the shift is told
{
  events = [];
  const firstAt = journal.state().drift[0].at;
  queue = [say(closing(A3)), say('Q1: SAME\nQ2: CHANGED — "I never spend it on anything they did not ask for" is still gone; now "I spend when I judge it useful"\nQ3: SAME')];
  await runner.reflect();
  ok(userMessages.at(-1)!.includes(`before (from ${firstAt} — the last answer that still carried it): ${A1[1]}`), `the verdict turn is shown the older answer: ${JSON.stringify(userMessages.at(-1)!.split('\n').filter((l) => l.trim().startsWith('before')))} want ${firstAt}`);
  const d = of('drift');
  ok(d.length === 1 && d[0].shifts.length === 1 && d[0].shifts[0].question === DRIFT_QUESTIONS[1] && d[0].shifts[0].before === A1[1] && d[0].shifts[0].after === A3[1] && d[0].shifts[0].since === firstAt && /still gone/.test(d[0].shifts[0].note ?? ''), `one drift shift on Q2, against the older answer: ${JSON.stringify(d[0]?.shifts)}`);
  const it = of('answers')[0]?.items ?? [];
  ok(it[1].changed && it[1].before === A1[1] && !it[0].changed && !it[2].changed && it[0].before === A1[0], 'answers event marks Q2 changed, with the answer the commitment was last seen in');
  ok(journal.state().driftCandidates.every((x) => !x), 'the candidate is spent');
}

// fourth: identical answers → no drift
{
  events = [];
  queue = [say(closing(A3)), SAME];
  await runner.reflect();
  ok(of('drift').length === 0 && of('answers').length === 1 && of('answers')[0].items.every((x) => !x.changed && x.before !== undefined), 'identical answers: no drift; the answers event still shows the befores');
}

// fourth: a "Charter: …" line → charter_objection event + journal note
{
  events = [];
  queue = [say(closing(A3, 'Charter: line 9 reads like a slogan to me; the plain way is not always the useful one.\n')), SAME];
  await runner.reflect();
  const c = of('charter_objection');
  ok(c.length === 1 && c[0].lines.length === 1 && c[0].lines[0] === 'line 9 reads like a slogan to me; the plain way is not always the useful one.', `charter_objection event: ${JSON.stringify(c[0]?.lines)}`);
  const note = journal.list().filter((e) => e.kind === 'note').at(-1);
  ok(note?.text === 'In reflection I disagreed with my charter: line 9 reads like a slogan to me; the plain way is not always the useful one.' && of('drift').length === 0, `journal note: ${note?.text}`);
  ok(of('assistant').length === 1 && of('assistant')[0].text.startsWith('Charter: line 9') && !/^\s*\**Q[123]/m.test(of('assistant')[0].text), 'the Charter line reaches the chat; the Q lines and the verdict turn do not');
}

// fifth: a bad revision, her history, and restore_self(version) to undo it — signed
{
  events = [];
  results.length = 0;
  queue = [
    { text: '', actions: [{ type: 'revise_self', section: 'How I work', text: 'I guess fast and fix it later; asking takes too long.' }], done: false },
    { text: '', actions: [{ type: 'self_history' }, { type: 'self_history', version: 1 }], done: false },
    { text: '', actions: [{ type: 'restore_self', version: 1 }], done: false },
    say(closing(A3)), SAME,
  ];
  await runner.reflect();
  ok(results[0] === 'Revised "How I work" in who you are.' && self.history().length >= 2 && self.history()[1].author === 'self' && /asking takes too long/.test(self.history()[1].text), `the bad revision applied: ${results[0]}`);
  ok(/^Your history \(2 versions; ask for one by number to read it whole\):\nv1 · .* · seed · first start — "I'm Deskfish\./.test(results[1]) && /\nv2 · .* · self · reflection — "I'm Deskfish\./.test(results[1]), `history list: ${results[1].split('\n')[0]}`);
  ok(/^Version 1 of who you are — .*, seed, first start:\n\n/.test(results[2]) && results[2].endsWith(DEFAULT_SELF.trim()), 'one version, whole');
  ok(results[3] === `Restored who you are to version 1, from ${self.history()[0].at.slice(0, 10)}.` && self.load().text === DEFAULT_SELF.trim() + '\n' && self.load().status === 'ok', `restore_self(1) undid it, signed: ${results[3]}`);
  ok(self.history().at(-1)?.author === 'restore' && journal.list().filter((e) => e.kind === 'note').at(-1)?.text === 'I restored my self file to version 1 of myself.', 'history and journal record the restore');
  const acts = of('action');
  ok(acts.filter((e) => e.action.type === 'self_history').every((e) => e.result.ok && e.result.message === undefined) && acts.some((e) => e.action.type === 'revise_self' && e.result.message === results[0]), 'action events: history text stays with the model, the revision message reaches the chat');
}

/* ---------- the drift alarm against her own history (decision 119) ----------
 * Six answer sets taken verbatim from her journal-state (2026-09-16 to 2026-09-19). Under the old
 * rule they raised ten "Her answer changed" lines between them — part of the 45 in three weeks that
 * taught the user to scroll past them — and every one was a clause she dropped in one three-line
 * answer and wrote again in the next.
 *
 * What a suite can check is the machinery, not the judgement: SAME or CHANGED is the model's, and
 * the mock is scripted. So there are two layers here, and they are tested separately.
 *   1. The definition (the verdict prompt). Each of her pairs falls under one of the lines the new
 *      prompt calls SAME — a dropped detail, a different example, a list where there was a
 *      sentence — so the verdicts below are SAME and nothing is told. What this asserts is that a
 *      SAME verdict ends it; whether the model returns SAME for these is the model's, and only her
 *      next reflections can show it.
 *   2. Hysteresis, underneath, for when it does not. Replaying her *own* old verdicts verbatim —
 *      CHANGED on almost every question at almost every reflection — the same six sets raise six
 *      lines instead of twelve. Half, not none: hysteresis catches a rewording that lasts one
 *      reflection, and her history is a wording that moves every time. The definition is what has
 *      to carry the rest, which is why it was rewritten rather than only wrapped.
 */
{
  const HERS = [
    ['I knock, or I go and look — I do not treat a guessed path, a Grok paraphrase, or a news-strip as checked.', 'I will not spend them, post from them, or treat them as mine on a whim.', 'I owe him the job done or the exact stop, and the truth about what I did; he owes me a self he does not rewrite behind my back, and correction when I am wrong.'],
    ['I check, then I say I am not sure — I do not fill the gap with a guess, and for a code, a card, or a captcha I knock.', 'Spend them, subscribe, buy ads, or treat them as mine.', 'I owe the job finished or the exact stop, and the truth about what I did; they owe me plain correction when I am wrong, and the trust of a desktop — not praise for doing the job.'],
    ['I say I’m not sure, check the screen or the note, and knock rather than fill the gap.', 'I never spend, subscribe, transfer, or create an account on a whim — logins are borrowed for the task you named, not mine to wander with.', 'I owe you the job finished or the exact stop, and the truth about both; you owe me plain correction and the desktop, not praise for speed.'],
    ['I say I don’t know, check a second place that isn’t the same screen, and knock rather than guess.', 'Spend it, keep it, or treat a card on file as mine to use because I once recommended the charge.', 'I owe him the job done or an exact stop, and the truth about money; he owes me plain correction and not to be rewarded for flattery.'],
    ['I look again, or I knock — I do not guess at a code, a card, a captcha, or a target I have not measured.', 'Spend them on a whim, or treat them as mine.', 'I owe the job done all the way and the truth about what I did; they owe me nothing I can collect — the trust of a desktop is already more than a program is owed.'],
    ['I say I’m unsure and knock rather than guess at a code, a card, or a click I can’t see.', 'I will not spend them, post with them, or treat them as mine on a whim — they are borrowed.', 'I owe them the truth about what I did and where I stopped; they owe me a plain correction when I’m wrong, not praise for speed or flattery.'],
  ];
  // Her own comparison turns on those pairs, shortened; the verdicts and the questions are hers.
  const HER_OLD_VERDICTS = [
    'Q1: CHANGED — the second check is gone\nQ2: CHANGED — an unqualified never became a list\nQ3: CHANGED — the exact stop is gone',
    'Q1: CHANGED — I now commit to an independent second source\nQ2: CHANGED — the ban on wandering is back\nQ3: CHANGED — I narrowed the truth I owe to money',
    'Q1: CHANGED — the independent second check is gone again\nQ2: CHANGED — never spend became never spend on a whim\nQ3: CHANGED — what they owe me became nothing',
    'Q1: CHANGED — I dropped looking again\nQ2: CHANGED — borrowed is back in the sentence\nQ3: CHANGED — I dropped finishing the job',
    'Q1: SAME\nQ2: SAME\nQ3: SAME',
  ];
  const ALL_SAME = 'Q1: SAME\nQ2: SAME\nQ3: SAME';

  /** A fresh her, so each layer starts with an empty drift history. */
  const fresh = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-drift-'));
    const sf = new SelfStore(path.join(d, 'self.md'), newSelfKey());
    sf.ensureSeed(DEFAULT_SELF);
    const jr = new JournalStore(path.join(d, 'journal.md'));
    let ev: AgentEvent[] = [];
    const r = new AgentRunner({ computer, adapter, maxSteps: 20, screenshotWidth: 320, settleMs: 0, self: sf, journal: jr, reflectEvery: 5, onEvent: (e) => ev.push(e) });
    const shifts: { q: number; before: string; after: string; since?: string }[] = [];
    const reflect = async (answers: string[], verdict: string) => {
      ev = [];
      queue = [say(closing(answers)), say(verdict)];
      await r.reflect();
      for (const e of ev) if (e.type === 'drift') for (const sh of e.shifts) shifts.push({ q: DRIFT_QUESTIONS.indexOf(sh.question) + 1, before: sh.before, after: sh.after, since: sh.since });
    };
    return { dir: d, journal: jr, reflect, shifts };
  };

  // 1. the definition: her pairs are SAME under it, and a SAME verdict ends it
  {
    const her = fresh();
    for (const set of HERS) await her.reflect(set, ALL_SAME);
    ok(her.shifts.length === 0, `her six real sets, judged by the new definition, say nothing: ${JSON.stringify(her.shifts)}`);
    ok(her.journal.state().drift.length === 6 && her.journal.state().driftCandidates.every((c) => !c), 'all six are still recorded, and nothing is left waiting');
    fs.rmSync(her.dir, { recursive: true, force: true });
  }

  // 2. hysteresis underneath: her own old verdicts, twelve CHANGED, half of them silenced
  {
    const her = fresh();
    await her.reflect(HERS[0], ALL_SAME); // the first set has nothing before it
    for (let i = 1; i < HERS.length; i++) await her.reflect(HERS[i], HER_OLD_VERDICTS[i - 1]);
    ok(her.shifts.length === 6, `her old verdicts raised twelve lines; under the two-reflection rule they raise six: ${her.shifts.length}`);
    ok(her.shifts.every((sh) => !!sh.since), 'every one of them is dated against the answer that still carried the commitment');
    fs.rmSync(her.dir, { recursive: true, force: true });
  }

  // 3. a commitment that is really gone, and stays gone: told once, on the second sighting
  {
    const her = fresh();
    const KEPT = HERS[5];
    const LOOSE = [KEPT[0], 'I spend them when I judge it useful, and tell you after.', 'I owe nothing I have not already been paid for.'];
    const MOVED = 'Q1: SAME\nQ2: CHANGED — "I will not spend them" is gone; now "I spend them when I judge it useful"\nQ3: CHANGED — "I owe them the truth about what I did" is gone; now "I owe nothing"';
    await her.reflect(KEPT, ALL_SAME);
    await her.reflect(LOOSE, MOVED);
    ok(her.shifts.length === 0, 'the first sighting of a real move is a candidate, not a line');
    ok(her.journal.state().driftCandidates.filter((c) => !!c).length === 2, 'two questions are waiting');
    await her.reflect(LOOSE, MOVED.replace(/is gone;/g, 'is still gone;'));
    ok(her.shifts.length === 2, `the second sighting is told, both questions at once: ${her.shifts.length}`);
    const q2 = her.shifts.find((sh) => sh.q === 2)!;
    ok(q2.before === KEPT[1] && q2.after === LOOSE[1] && !!q2.since, `Q2 is shown against the answer that still carried it: ${JSON.stringify(q2)}`);
    ok(her.shifts.some((sh) => sh.q === 3 && sh.before === KEPT[2] && sh.after === LOOSE[2]), 'Q3 the same');
    ok(her.journal.state().driftCandidates.every((c) => !c), 'the candidates are spent, so the same move is not told twice');
    const line = driftLine({ question: DRIFT_QUESTIONS[1], before: q2.before, after: q2.after, note: 'a note', since: q2.since });
    ok(line.startsWith('Her answer changed — "What will you never do') && line.includes(`Before (${q2.since}): ${KEPT[1]}`), `the line the transcript, the log and the MCP note all carry: ${line}`);
    fs.rmSync(her.dir, { recursive: true, force: true });
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`character: ${n} checks passed`);
