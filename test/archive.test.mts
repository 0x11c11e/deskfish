// Reflection room: the reflection prompt states the page's size per section; archive_story moves a
// paragraph of "My story" to the journal (signed, kept, findable); the size error points at it;
// mid-task archiving is refused.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { AgentRunner } from '../src/agent/loop';
import { SelfStore, newSelfKey, MAX_SELF_CHARS } from '../src/agent/self';
import { JournalStore } from '../src/agent/journal';
import { reflectionPrompt } from '../src/agent/prompts';
import { archiveStoryAction } from '../src/agent/actions';
import type { ComputerProvider } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-archive-'));
const self = new SelfStore(path.join(dir, 'self.md'), newSelfKey());
const journal = new JournalStore(path.join(dir, 'journal.md'));
const story = ['On day one I learned to knock on the glass.', 'On day two I read the dull line twice.', 'On day three I checked the inbox after "Message sent".'];
self.ensureSeed(`I am a test fish.\n\n## How I work\n\n- carefully.\n\n## My story\n\n${story.join('\n\n')}\n\n## People\n\n**Iman** — made me.`);

// sizes
const sz = self.sizes();
ok(sz.max === MAX_SELF_CHARS && sz.sections.some((s) => s.heading === 'My story' && s.chars > 100) && sz.total === self.load().text.length, `sizes per section: ${JSON.stringify(sz.sections)}`);
ok(reflectionPrompt({ entries: '', pending: '', tasks: 1, sizes: '3,900 of 4,000 characters (My story 1,900).' }).includes('Room on your page: 3,900 of 4,000 characters') && reflectionPrompt({ entries: '', pending: '', tasks: 1 }).includes('Your story is a page, not a diary'), 'reflection prompt carries the room and the page-not-diary rule');

// parser
const a = archiveStoryAction({ starts_with: 'On day one' }) as any;
ok(a.type === 'archive_story' && a.section === 'My story' && a.startsWith === 'On day one', 'parser defaults the section');
assert.throws(() => archiveStoryAction({}), /starts_with/);
n++;

// archiveParagraph: by prefix, oldest, errors, signed history
{
  const r = self.archiveParagraph('My story', 'on day two', 'test');
  ok(r.ok && r.text === story[1] && /Your page is now \d+ of 4000 characters/.test(r.message ?? ''), `moved by prefix: ${r.ok ? r.message : r.error}`);
  ok(!self.load().text.includes(story[1]) && self.load().status === 'ok', 'paragraph gone from the page, page still signed');
  const r3 = self.archiveParagraph('My story', 'zzz nothing here');
  ok(!r3.ok && /no paragraph/.test(r3.error ?? ''), 'unknown prefix → error');
  const r2 = self.archiveParagraph('My story', 'oldest');
  ok(r2.ok && r2.text === story[0], 'oldest');
  const r4 = self.archiveParagraph('My story', 'On day three');
  ok(!r4.ok && /only one paragraph/.test(r4.error ?? ''), 'the last paragraph is not archivable');
  ok(!self.archiveParagraph('Nope', 'oldest').ok && !self.archiveParagraph('My story', 'short').ok, 'unknown section and too-short prefix refused');
  ok(self.history().filter((h) => /archived a paragraph/.test(h.reason ?? '')).length === 2, 'history records the archives');
}
// the size error points at the tool
{
  const r = self.revise('How I work', 'x'.repeat(MAX_SELF_CHARS));
  ok(!r.ok && /archive_story/.test(r.error ?? '') && /cut at least/.test(r.error ?? ''), `size error mentions archive_story: ${r.error?.slice(0, 80)}`);
}

// loop: refused mid-task; in a reflection it moves the paragraph into the journal and the prompt carried the sizes
{
  const png = PNG.sync.write(new PNG({ width: 320, height: 200 }));
  const computer: ComputerProvider = {
    name: 'fake',
    async displaySize() { return { width: 320, height: 200 }; },
    async screenshot() { return { png, width: 320, height: 200 }; },
    async execute(a) { return a.type === 'cursor_position' ? { ok: true, cursor: { x: 1, y: 1 } } : { ok: true }; },
  };
  self.revise('My story', `${story[2]}\n\nOn day four I stood by instead of spending steps.`, 'test');
  const results: string[] = [];
  const prompts: string[] = [];
  let turn = 0;
  const adapter = {
    name: 'scripted',
    start(task: string) { prompts.push(task); },
    addUserMessage(t: string) { prompts.push(t); }, // a reflection continues the conversation: its prompt arrives here
    async step(obs: Observation): Promise<ModelTurn> {
      turn++;
      for (const r of obs.results) results.push(r.ok ? `ok:${r.message}` : `err:${r.error}`);
      if (turn === 1) return { text: '', actions: [{ type: 'archive_story', section: 'My story', startsWith: 'On day three' }] };
      return { text: 'done', actions: [], done: true };
    },
  } as unknown as ModelAdapter;
  const runner = new AgentRunner({ computer, adapter, self, journal, maxSteps: 5, screenshotWidth: 320, settleMs: 0, onEvent: () => {} });
  await runner.run('a task');
  ok(results.some((r) => r.startsWith('err:') && /only when you reflect/.test(r)), `mid-task archive refused: ${results.join(' | ')}`);
  turn = 0;
  results.length = 0;
  await runner.reflect();
  ok(prompts.at(-1)?.includes('Room on your page:') && /My story \d+/.test(prompts.at(-1) ?? ''), 'reflection prompt carried the sizes');
  ok(results.some((r) => r.startsWith('ok:Moved that paragraph')), `archived during reflection: ${results.join(' | ')}`);
  ok(!self.load().text.includes(story[2]) && self.load().text.includes('On day four'), 'the older paragraph left, the newer stayed');
  const j = fs.readFileSync(path.join(dir, 'journal.md'), 'utf8');
  ok(j.includes(`Archived from my page, "My story": ${story[2]}`), 'the paragraph landed in the journal');
  ok(journal.recall('Message sent').ok, 'recall finds it');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`archive: ${n} checks passed`);
