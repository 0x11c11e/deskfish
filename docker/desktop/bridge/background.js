// Deskfish page bridge — background script.
//
// Long-polls the Deskfish daemon (same container, 127.0.0.1) for page requests, asks the content
// script of the active tab to answer them (every frame for a find or a read; for a scroll, a
// selection or a focus, every frame finds and the one holding the best hit acts), and posts the
// answer back.
// The daemon's port and token arrive through managed storage (policies.json → 3rdparty), written
// by the tank's entrypoint.
'use strict';

const EXTENSION_ID = 'deskfish-bridge@deskfish.sh';
let base = 'http://127.0.0.1:9990';
let token = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadConfig() {
  try {
    const m = await browser.storage.managed.get();
    if (m && m.port) base = `http://127.0.0.1:${Number(m.port)}`;
    if (m && typeof m.token === 'string') token = m.token;
  } catch {
    // no managed storage: defaults
  }
}

function headers(extra) {
  const h = { ...(extra || {}) };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** Merge the answers of every frame of the tab into one page description. */
function merge(frames, op, args) {
  frames.sort((a, b) => a.frameId - b.frameId);
  const top = frames.find((f) => f.frameId === 0) || frames[0];
  let elements = frames.flatMap((f) => f.elements || []);
  if (op === 'find') {
    const limit = Math.max(1, Math.min(20, Number(args && args.limit) || 8));
    elements.sort((a, b) => (b.score || 0) - (a.score || 0));
    elements = elements.slice(0, limit);
  }
  const more = frames.reduce((acc, f) => {
    const m = f.more || {};
    return { visible: acc.visible + (m.visible || 0), below: acc.below + (m.below || 0), above: acc.above + (m.above || 0) };
  }, { visible: 0, below: 0, above: 0 });
  const text = frames.map((f) => f.text).filter(Boolean).join('\n\n');
  return { viewport: top.viewport, elements, text, total: frames.reduce((n, f) => n + (f.total || 0), 0), more };
}

/** The daemon's names for the content script's ops. */
const OPS = { page_find: 'find', find: 'find', page_read: 'read', read: 'read', page_scroll_to: 'scroll_to', scroll_to: 'scroll_to', page_select: 'select', select: 'select', page_focus: 'focus', focus: 'focus' };
/** Ops that act on the page: found in every frame first, then done in the one frame that holds the best hit. */
const ACTS = new Set(['scroll_to', 'select', 'focus']);

async function perform(job) {
  const op = OPS[job.op];
  if (!op) return { ok: false, error: `unknown page op "${job.op}"` };
  let tab;
  try {
    [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true });
  } catch (err) {
    return { ok: false, error: `cannot list tabs: ${err && err.message}` };
  }
  if (!tab) return { ok: false, error: 'Firefox has no active tab' };
  const url = tab.url || '';
  if (!/^https?:/i.test(url)) return { ok: false, error: `the current tab is not a web page (${url || 'empty tab'}); this only works on http(s) pages` };

  let frames = [];
  try {
    frames = await browser.webNavigation.getAllFrames({ tabId: tab.id });
  } catch {
    frames = [{ frameId: 0 }];
  }
  if (!frames || !frames.length) frames = [{ frameId: 0 }];
  // One frame, one op: undefined when it has no content script (still loading, or a restricted
  // page) or does not answer in time.
  const ask = (frameId, what) =>
    Promise.race([
      browser.tabs.sendMessage(tab.id, { op: what, args: job.args || {} }, { frameId }),
      sleep(4000).then(() => undefined),
    ]).catch(() => undefined);
  const NO_ANSWER = 'the page did not answer (still loading, or a page Firefox does not let extensions read); wait a moment and try again, or use the screenshot';

  // Phase 1: every frame answers — the op itself for find and read, a find for the ops that act.
  const answers = [];
  await Promise.all(frames.map(async (f) => {
    if (f.url && !/^https?:/i.test(f.url)) return;
    const r = await ask(f.frameId, ACTS.has(op) ? 'find' : op);
    if (r && !r.error) answers.push({ frameId: f.frameId, ...r });
  }));
  if (!answers.length) return { ok: false, error: NO_ANSWER };
  const title = tab.title || '';
  if (!ACTS.has(op)) return { ok: true, data: { url, title, ...merge(answers, op, job.args) } };

  // Phase 2: the frame whose best hit scores highest does it, alone — a scroll or a selection must
  // happen once, in the frame that holds the element. The content script finds again in that frame
  // and refuses a weak hit itself; a refusal carries every frame's candidates, as find would.
  const best = answers.reduce((a, f) => {
    const s = f.elements && f.elements[0] ? f.elements[0].score || 0 : -1;
    return !a || s > a.s ? { f, s } : a;
  }, undefined);
  const r = await ask(best.f.frameId, op);
  if (!r) return { ok: false, error: NO_ANSWER };
  if (r.error) return { ok: false, error: r.error };
  const done = op === 'scroll_to' ? r.scrolled : op === 'focus' ? r.focused : r.selected;
  if (!done && r.reason !== 'no-option') r.elements = merge(answers, 'find', job.args).elements;
  return { ok: true, data: { url, title, ...r } };
}

async function main() {
  await loadConfig();
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${base}/bridge/next`, { headers: headers(), cache: 'no-store' });
      if (res.status === 401) {
        await loadConfig();
        await sleep(3000);
        continue;
      }
      if (!res.ok) throw new Error(`daemon answered ${res.status}`);
      failures = 0;
      const job = await res.json();
      if (!job || !job.id) continue; // poll timed out, nothing to do
      let result;
      try {
        result = await perform(job);
      } catch (err) {
        result = { ok: false, error: String((err && err.message) || err) };
      }
      await fetch(`${base}/bridge/result`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ id: job.id, ...result }),
      });
    } catch {
      failures++;
      await sleep(Math.min(10000, 1000 * failures));
      if (failures % 5 === 0) await loadConfig();
    }
  }
}

main();
