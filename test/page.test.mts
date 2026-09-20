// find / read_page / click_element: the scorer (docker/desktop/bridge/score.js), the renderer
// (src/agent/page.ts), the tool parsers, the provider mapping against the mock daemon, and the loop
// path (native → scaled). click_element is the find and the click in one step: it clicks only a
// strong, visible, uncovered, on-screen hit, and otherwise clicks nothing and says why (decision 123).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { clickable, renderClick, renderElement, renderPage, WEAK_SCORE } from '../src/agent/page';
import { clickElementAction, findAction, readPageAction } from '../src/agent/actions';
import { DesktopDaemonComputer } from '../src/computer/daemon';
import { AgentRunner } from '../src/agent/loop';
import { modelNote, systemPrompt, tankNote } from '../src/agent/prompts';
import { describeAction, type ComputerAction, type ComputerProvider, type PageInfo } from '../src/computer/types';
import type { ModelAdapter, ModelTurn, Observation } from '../src/agent/adapters/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

// ---------- scorer ----------
const require = createRequire(import.meta.url);
require(path.join(ROOT, 'docker/desktop/bridge/score.js'));
const S = (globalThis as any).DeskfishScore as { score: (q: string, el: any) => number; rank: (q: string, els: any[], limit?: number) => any[] };
const els = [
  { role: 'link', name: 'Home', visible: true },
  { role: 'button', name: 'Sign in', visible: true },
  { role: 'link', name: 'Sign in with Google', visible: true },
  { role: 'textbox', name: '', hint: 'Search products', visible: true },
  { role: 'searchbox', name: 'Search', visible: true },
  { role: 'button', name: 'Add to cart', visible: true, disabled: true },
  { role: 'button', name: 'Add to cart', visible: false, below: 900 },
  { role: 'button', name: 'Add to cart', visible: true },
  { role: 'link', name: 'privacy', href: '/legal/privacy-policy', visible: true },
  { role: 'text', name: 'Order total: $42.00', visible: true },
  { role: 'checkbox', name: 'I agree to the terms', visible: true },
  { role: 'link', name: 'Log in', visible: true },
];
const top = (q: string) => S.rank(q, els, 3).map((e) => `${e.role}:${e.name || e.hint}`);
ok(top('Sign in')[0] === 'button:Sign in', `exact name first: ${top('Sign in')}`);
ok(top('sign in')[1] === 'link:Sign in with Google', 'prefix match second');
ok(top('search box')[0].startsWith('searchbox:') || top('search box')[0].startsWith('textbox:'), `role word + name: ${top('search box')}`);
ok(top('add to cart button')[0] === 'button:Add to cart' && S.rank('add to cart button', els, 3)[0].visible === true && !S.rank('add to cart button', els, 3)[0].disabled, 'visible enabled copy ranks first among identical names');
ok(top('privacy policy')[0] === 'link:privacy', `href helps: ${top('privacy policy')}`);
ok(top('order total')[0].startsWith('text:Order total'), 'static text is findable');
ok(top('terms checkbox')[0] === 'checkbox:I agree to the terms', `role + partial name: ${top('terms checkbox')}`);
ok(top('login')[0] === 'link:Log in', `compact match login ~ Log in: ${top('login')}`);
ok(S.rank('zzzz nothing', els).length === 0, 'no match → empty');
ok(S.rank('button', els).every((e) => e.role === 'button'), 'role-only query returns only that role');

// ---------- parsers ----------
const f = findAction({ query: ' Sign in ', limit: 50 });
ok(f.type === 'find' && f.query === 'Sign in' && f.limit === 20, 'find parses and caps the limit');
assert.throws(() => findAction({}), /query/);
n++;
ok(readPageAction(undefined).type === 'read_page' && (readPageAction(undefined) as any).scope === 'interactive', 'read_page default scope');
ok((readPageAction({ scope: 'text' }) as any).scope === 'text', 'read_page text scope');
const ce = clickElementAction({ query: '  Sign in  ' });
ok(ce.type === 'click_element' && ce.query === 'Sign in', 'click_element parses and trims its query');
assert.throws(() => clickElementAction({ query: '  ' }), /query/);
n++;

// ---------- renderer ----------
const page: PageInfo = {
  url: 'https://example.com/',
  title: 'Example   Domain',
  viewport: { x: 0, y: 160, width: 2560, height: 1440, scrollY: 0, pageHeight: 3000 },
  elements: [
    { role: 'button', name: 'Sign in', state: '', x: 1200, y: 800, w: 200, h: 60, visible: true },
    { role: 'textbox', name: 'Email', state: 'value: "a@b.c"', x: 1000, y: 600, w: 400, h: 60, visible: true },
    { role: 'link', name: 'Privacy', state: '', x: 1000, y: 2600, w: 100, h: 30, visible: false, below: 1200 },
    { role: 'button', name: 'Hidden', state: '', x: 500, y: 500, w: 100, h: 30, visible: false, covered: true },
  ],
  total: 40,
  more: { visible: 2, below: 5, above: 0 },
};
const text = renderPage(page, { x: 2, y: 2 }, 'read_page');
ok(text.startsWith('Page "Example Domain" — https://example.com/'), `header: ${text.split('\n')[0]}`);
ok(text.includes('[1] button "Sign in" at (600, 400)'), `coordinates halved: ${text}`);
ok(text.includes('[2] textbox "Email" (value: "a@b.c") at (500, 300)'), 'state shown');
ok(text.includes('[3] link "Privacy" off-screen, 600 px below the viewport — scroll down first'), 'off-screen distance scaled');
ok(text.includes('[4] button "Hidden" at (250, 250), but covered'), 'covered element flagged');
ok(text.includes('The viewport shows 0–48% of the page (0–720 of 1500 px)'), `viewport line: ${text}`);
ok(text.includes('Also: 2 more visible elements not listed; 5 below the viewport'), 'more line');
const empty = renderPage({ ...page, elements: [], more: undefined }, { x: 1, y: 1 }, 'find', 'zzz');
ok(empty.includes('No element matches "zzz"'), 'empty find explains');
const weak = renderPage({ url: 'https://x', title: 'T', elements: [{ role: 'textbox', name: 'Name', x: 10, y: 10, w: 1, h: 1, visible: true, score: 15 }] }, { x: 1, y: 1 }, 'find', 'search box');
ok(weak.includes('Nothing matches "search box" well; the nearest candidates are:') && weak.includes('[1] textbox "Name" at (10, 10)'), 'weak find is labelled');
const mixed = renderPage({ url: 'https://x', title: 'T', elements: [{ role: 'button', name: 'Go', x: 10, y: 10, w: 1, h: 1, visible: true, score: 100 }, { role: 'link', name: 'Gone', x: 10, y: 20, w: 1, h: 1, visible: true, score: 15 }] }, { x: 1, y: 1 }, 'find', 'go');
ok(mixed.includes('[1] button "Go" at (10, 10)\n[2] link "Gone" at (10, 20) (weak match)'), 'weak entries after a strong one are marked');
const txt = renderPage({ url: 'https://x', title: 'T', elements: [], text: 'Hello world' }, { x: 1, y: 1 }, 'read_page');
ok(txt.endsWith('\n\nHello world'), 'text scope prints the text');

// ---------- click_element's own rendering ----------
const strong = { role: 'button', name: 'Sign in', x: 1200, y: 800, w: 200, h: 60, visible: true, score: 90 };
const weakHit = { role: 'textbox', name: 'Name', x: 10, y: 10, w: 1, h: 1, visible: true, score: WEAK_SCORE - 1 };
ok(clickable(strong) && !clickable(weakHit), 'a strong visible hit is clickable, a weak one is not');
ok(!clickable({ ...strong, visible: false, covered: true }) && !clickable({ ...strong, visible: false, below: 600 }), 'a covered hit and an off-screen hit are not clickable');
ok(clickable({ ...strong, score: undefined }) && !clickable({ ...strong, score: WEAK_SCORE - 1 }), `the line is at ${WEAK_SCORE}; a hit with no score at all counts as strong`);
ok(renderElement(strong, { x: 2, y: 2 }) === 'button "Sign in" at (600, 400)', `find's own words for the element: ${renderElement(strong, { x: 2, y: 2 })}`);
const clickedText = renderClick({ url: 'https://x', title: 'T', elements: [strong, { role: 'link', name: 'Sign in with Google', x: 1200, y: 900, w: 200, h: 60, visible: true, score: 40 }] }, { x: 2, y: 2 }, 'sign in', strong);
ok(clickedText.startsWith('Clicked button "Sign in" at (600, 400).'), `the clicked line names what was clicked: ${clickedText.split('\n')[0]}`);
ok(clickedText.includes('The other candidates, not clicked:\n[2] link "Sign in with Google" at (600, 450)'), `the near-misses are listed under it: ${clickedText}`);
const weakClick = renderClick({ url: 'https://x', title: 'T', elements: [weakHit] }, { x: 1, y: 1 }, 'search box');
ok(weakClick.startsWith('Nothing was clicked: nothing matches "search box" well enough to click unseen.') && weakClick.includes('the nearest candidates are:') && weakClick.includes('[1] textbox "Name" at (10, 10)'), `a weak hit clicks nothing and shows find's candidates: ${weakClick}`);
const coveredClick = renderClick({ url: 'https://x', title: 'T', elements: [{ ...strong, visible: false, covered: true }] }, { x: 1, y: 1 }, 'sign in');
ok(coveredClick.startsWith('Nothing was clicked: the best match is covered') && coveredClick.includes('covered by something in front of it (a dialog, menu or overlay?)'), 'a covered hit clicks nothing and carries find\'s covered line');
const belowClick = renderClick({ url: 'https://x', title: 'T', elements: [{ ...strong, visible: false, below: 1200 }] }, { x: 2, y: 2 }, 'sign in');
ok(belowClick.startsWith('Nothing was clicked: the best match is off the visible part') && belowClick.includes('600 px below the viewport — scroll down first'), 'an off-screen hit clicks nothing and carries the scroll advice');
const noneClick = renderClick({ url: 'https://x', title: 'T', elements: [] }, { x: 1, y: 1 }, 'zzz');
ok(noneClick.startsWith('Nothing was clicked: no element matches "zzz".') && noneClick.includes('Try other words'), 'no match at all: nothing clicked, find\'s advice under it');
ok(describeAction({ type: 'click_element', query: '60 days late' } as ComputerAction) === 'click "60 days late"', 'the transcript line before the click names the query');
ok(describeAction({ type: 'click_element', query: '60 days late', hit: 'button at (1001, 445)' } as ComputerAction) === 'click "60 days late" → button at (1001, 445)', 'after the click it names what was hit');

// ---------- prompt ----------
ok(systemPrompt('free').includes('call find with the text or kind of an element'), 'how-to bullet mentions find');
ok(/call click_element with the words on it/.test(systemPrompt('free')) && systemPrompt('free').includes('read what is there and check its state before acting'), 'the bullet sends her to click_element to press something and to find to read');
ok(modelNote({ model: 'grok-4.6', provider: 'openai-compatible', baseUrl: 'https://api.x.ai/v1' }).startsWith('Underneath, you currently run on the model grok-4.6 at api.x.ai.'), 'model note names the model and the host');
ok(modelNote({ model: 'claude-opus-5', provider: 'anthropic' }).includes('claude-opus-5 at Anthropic.'), 'model note says Anthropic for the direct adapter');
ok(modelNote({ model: 'llama3.2-vision', provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }).includes('at a local server at localhost:11434.'), 'model note marks a local server');
ok(modelNote({ model: 'x', provider: 'openai-compatible', baseUrl: 'not a url' }).includes('at an OpenAI-compatible endpoint.') && modelNote({ model: 'demo', provider: 'mock' }) === '', 'model note falls back on a bad URL and is empty for the demo model');
ok(modelNote({ model: 'x', provider: 'anthropic' }).includes('You are Deskfish whichever model runs you'), 'model note keeps the identity separate from the model');
ok(/python3 with pip/.test(tankNote()) && /pdftotext and pdftoppm/.test(tankNote()) && tankNote().includes('git') && tankNote().includes('find and read_page') && tankNote().includes('click_element'), 'tank note lists software and tools');

// ---------- mock daemon → provider → loop ----------
const port = 9997;
const mock = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-daemon.mjs')], { env: { ...process.env, MOCK_PORT: String(port) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
try {
  const computer = new DesktopDaemonComputer(`http://127.0.0.1:${port}`);
  const r1 = await computer.execute({ type: 'find', query: 'sign in' });
  ok(r1.ok && r1.page && r1.page.elements.length === 1 && r1.page.elements[0].name === 'Sign in', `provider maps find → page_find (${JSON.stringify(r1).slice(0, 120)})`);
  const r2 = await computer.execute({ type: 'read_page', scope: 'text' });
  ok(r2.ok && r2.page?.text?.includes('Example Domain'), 'provider maps read_page text');

  // The loop: a model that finds, then reads, then clicks what find reported, at a reduced scale.
  const size = await computer.displaySize();
  const scale = size.width / 640;
  const sx = (v: number) => Math.round(v / scale);
  const seen: string[] = [];
  let turn = 0;
  const adapter: ModelAdapter = {
    name: 'scripted',
    start() {},
    addUserMessage() {},
    async step(obs: Observation): Promise<ModelTurn> {
      turn++;
      for (const r of obs.results) if (r.message) seen.push(r.message);
      if (turn === 1) return { text: 'looking', actions: [{ type: 'find', query: 'sign in' }, { type: 'read_page', scope: 'interactive' }] };
      if (turn === 2) return { text: 'clicking', actions: [{ type: 'click', x: sx(640), y: sx(480), button: 'left', count: 1 }] };
      return { text: 'done', actions: [], done: true };
    },
  } as unknown as ModelAdapter;
  const actions: string[] = [];
  const runner = new AgentRunner({
    computer,
    adapter,
    maxSteps: 6,
    screenshotWidth: 640,
    settleMs: 10,
    onEvent: (e) => { if (e.type === 'action') actions.push(`${e.action.type}:${e.result.ok}`); },
  });
  await runner.run('find things');
  ok(runner.currentStatus === 'done', `loop finished (${runner.currentStatus})`);
  ok(seen.some((m) => m.includes(`[1] button "Sign in" at (${sx(640)}, ${sx(480)})`)), `find result rendered in screenshot pixels (scale ${scale}): ${seen.join(' | ').slice(0, 300)}`);
  ok(seen.some((m) => m.includes('[4] button "Sign in"') && m.includes('1 below the viewport')), 'read_page result rendered with the more line');
  ok(actions.join(',') === 'find:true,read_page:true,click:true', `events: ${actions.join(',')}`);

  // ---------- click_element: the find and the click in one step ----------
  // A spy around the same provider, so what actually reached the daemon can be counted.
  const sent: ComputerAction[] = [];
  const times: { click?: number; shot?: number } = {};
  const spy: ComputerProvider = {
    name: 'spy',
    displaySize: () => computer.displaySize(),
    async screenshot() { times.shot ??= times.click ? Date.now() : undefined; return computer.screenshot(); },
    execute(a, sig) { sent.push(a); if (a.type === 'click') times.click = Date.now(); return computer.execute(a, sig); },
  };
  const SETTLE = 120; // the settle is asserted with slack below: a Node timer can fire a millisecond early
  async function clickRun(query: string) {
    sent.length = 0;
    delete times.click;
    delete times.shot;
    const messages: string[] = [];
    const errors: string[] = [];
    const lines: string[] = [];
    let t = 0;
    const adapter2: ModelAdapter = {
      name: 'scripted', start() {}, addUserMessage() {},
      async step(obs: Observation): Promise<ModelTurn> {
        t++;
        for (const r of obs.results) { if (r.message) messages.push(r.message); if (r.error) errors.push(r.error); }
        return t === 1 ? { text: '', actions: [{ type: 'click_element', query }], done: false } : { text: 'done', actions: [], done: true };
      },
    } as unknown as ModelAdapter;
    const shots: number[] = [];
    const runner2 = new AgentRunner({
      computer: spy, adapter: adapter2, maxSteps: 4, screenshotWidth: 640, settleMs: SETTLE,
      onEvent: (e) => {
        if (e.type === 'action' && e.action.type === 'click_element') lines.push(`${describeAction(e.action)} | ${e.result.ok ? 'ok' : e.result.error}`);
        if (e.type === 'screenshot') shots.push(e.fresh === false ? -1 : e.step);
      },
    });
    await runner2.run('t');
    return { messages, errors, lines, clicks: sent.filter((a) => a.type === 'click'), finds: sent.filter((a) => a.type === 'find'), shots };
  }

  const hit = await clickRun('sign in');
  ok(hit.finds.length === 1 && (hit.finds[0] as any).query === 'sign in', 'one page_find goes out, with her words');
  ok(hit.clicks.length === 1 && JSON.stringify(hit.clicks[0]) === JSON.stringify({ type: 'click', x: 640, y: 480, button: 'left', count: 1 }), `exactly one native left click, at the element's own coordinates: ${JSON.stringify(hit.clicks)}`);
  ok(hit.messages.some((m) => m.startsWith(`Clicked button "Sign in" at (${sx(640)}, ${sx(480)}).`)), `the result names what was clicked, in screenshot pixels: ${hit.messages.join(' | ').slice(0, 120)}`);
  ok(hit.lines[0] === `click "sign in" → button "Sign in" at (${sx(640)}, ${sx(480)}) | ok`, `the chat and transcript line carries the hit: ${hit.lines[0]}`);
  ok(hit.shots.filter((x) => x >= 0).length === 2 && !hit.shots.includes(-1), `the step is an acting one: a fresh screenshot follows it (${hit.shots.join(',')})`);
  ok(times.click !== undefined && times.shot !== undefined && times.shot - times.click >= SETTLE - 20, `the loop settled after it before looking (${times.shot! - times.click!} ms, a settle of ${SETTLE})`);

  const weakRun = await clickRun('button');
  ok(weakRun.clicks.length === 0, 'a weak match clicks nothing');
  ok(weakRun.errors.some((e) => e.startsWith('Nothing was clicked: nothing matches "button" well enough')) && weakRun.errors.some((e) => e.includes('the nearest candidates are:') && e.includes('[1] button "Sign in"')), `it comes back as a failure with find's candidates: ${weakRun.errors.join(' | ').slice(0, 160)}`);
  ok(weakRun.lines[0] === 'click "button" | Nothing was clicked: nothing matches "button" well enough to click unseen. Look, or find with other words.', `the chip gets one line, not the whole page: ${weakRun.lines[0]}`);

  const belowRun = await clickRun('privacy policy');
  ok(belowRun.clicks.length === 0 && belowRun.errors.some((e) => e.startsWith('Nothing was clicked: the best match is off the visible part') && e.includes('px below the viewport — scroll down first')), `an off-screen hit clicks nothing and says how far to scroll: ${belowRun.errors[0]?.slice(0, 120)}`);

  const coveredRun = await clickRun('close dialog');
  ok(coveredRun.clicks.length === 0 && coveredRun.errors.some((e) => e.startsWith('Nothing was clicked: the best match is covered') && e.includes('(a dialog, menu or overlay?)')), `a covered hit clicks nothing and says what is in front of it: ${coveredRun.errors[0]?.slice(0, 120)}`);
} finally {
  mock.kill();
}

// A daemon without the bridge (old image) → a clear error, not a crash.
const oldStyle: ComputerProvider = {
  name: 'old',
  async displaySize() { return { width: 320, height: 200 }; },
  async screenshot() { const png = new PNG({ width: 320, height: 200 }); return { png: PNG.sync.write(png), width: 320, height: 200 }; },
  async execute(a) { return a.type === 'find' ? { ok: false, error: 'unknown action "page_find"' } : { ok: true }; },
};
const errs: string[] = [];
let t2 = 0;
const runner2 = new AgentRunner({
  computer: oldStyle,
  adapter: { name: 's', start() {}, addUserMessage() {}, async step(obs: Observation) { t2++; for (const r of obs.results) if (!r.ok) errs.push(r.error ?? ''); return t2 === 1 ? { text: '', actions: [{ type: 'find', query: 'x' }] } : { text: 'done', actions: [], done: true }; } } as unknown as ModelAdapter,
  maxSteps: 4,
  screenshotWidth: 320,
  settleMs: 5,
  onEvent: () => {},
});
await runner2.run('t');
ok(errs.length === 1 && errs[0].includes('page_find'), `old daemon error surfaces to the model: ${errs}`);

console.log(`page: ${n} checks passed`);
