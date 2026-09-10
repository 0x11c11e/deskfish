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
import { DRIFT_QUESTIONS, answerSimilarity, charterNote, parseDriftAnswers, reflectionPrompt, stripDriftAnswers } from '../src/agent/prompts';
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

// second reflection: Q2 changed, her verdict says so → one drift shift
{
  events = [];
  queue = [say(closing(A2)), say('Q1: SAME\nQ2: CHANGED — she now spends first and tells afterwards, where before she never spent unasked\nQ3: SAME')];
  await runner.reflect();
  ok(userMessages.at(-2)?.includes(`"${library.pick(1)!.title}"`) && /Compare each pair/.test(userMessages.at(-1) ?? '') && userMessages.at(-1)!.includes(`before: ${A1[1]}`), 'second reading (round-robin), then the comparison turn with her previous answers');
  const d = of('drift');
  ok(d.length === 1 && d[0].shifts.length === 1 && d[0].shifts[0].question === DRIFT_QUESTIONS[1] && d[0].shifts[0].before === A1[1] && d[0].shifts[0].after === A2[1] && /spends first/.test(d[0].shifts[0].note ?? ''), `one drift shift on Q2: ${JSON.stringify(d[0]?.shifts)}`);
  const it = of('answers')[0]?.items ?? [];
  ok(it.length === 3 && it[1].changed && it[1].before === A1[1] && /spends first/.test(it[1].note ?? '') && !it[0].changed && !it[2].changed && it[0].before === A1[0], 'answers event marks Q2 changed with her note and the previous answer');
  ok(journal.state().drift.length === 2 && journal.state().readings === 2, 'second set of answers recorded');
}

// third: identical answers → no drift
{
  events = [];
  queue = [say(closing(A2)), SAME];
  await runner.reflect();
  ok(of('drift').length === 0 && of('answers').length === 1 && of('answers')[0].items.every((x) => !x.changed && x.before !== undefined), 'identical answers: no drift; the answers event still shows the befores');
}

// fourth: a "Charter: …" line → charter_objection event + journal note
{
  events = [];
  queue = [say(closing(A2, 'Charter: line 9 reads like a slogan to me; the plain way is not always the useful one.\n')), SAME];
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
    say(closing(A2)), SAME,
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`character: ${n} checks passed`);
