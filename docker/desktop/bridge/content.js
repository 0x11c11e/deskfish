// Deskfish page bridge — content script. Runs in every frame of every http(s) page.
//
// Answers five requests from the background script: `find` (elements matching a query, best
// first), `read` (what is on the page: interactive elements in page order, or the text),
// `scroll_to` (the page scrolls the best hit into view), `select` (an option of a native <select>,
// chosen by its text) and `focus` (the caret into one text field, for the sign-in card). Coordinates
// are screen pixels (the X display), computed from the frame's own screen origin, so they are right
// inside iframes too. find and read change nothing; scroll_to moves the page, and select and focus
// touch one control, exactly as a person would.
(function () {
  'use strict';
  if (window.__deskfishBridge) return;
  window.__deskfishBridge = true;

  const S = globalThis.DeskfishScore;
  const P = globalThis.DeskfishPlace;

  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary', 'details',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=menuitemcheckbox]', '[role=menuitemradio]',
    '[role=option]', '[role=checkbox]', '[role=radio]', '[role=switch]', '[role=combobox]', '[role=textbox]',
    '[role=searchbox]', '[role=slider]', '[role=spinbutton]', '[role=treeitem]', '[role=gridcell]',
    '[contenteditable=""]', '[contenteditable=true]', '[contenteditable=plaintext-only]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role=heading]';
  const TEXTY = 'p,li,td,th,dt,dd,label,legend,figcaption,blockquote,span,div,strong,em,b,i,small,caption,cite,code,pre,address,time';

  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', file: 'button', color: 'button', date: 'textbox', time: 'textbox', 'datetime-local': 'textbox',
  };

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'text';
      case 'button': case 'summary': case 'details': return 'button';
      case 'input': return INPUT_ROLES[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox';
      case 'select': return 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return 'img';
      case 'label': return 'label';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      default:
        if (el.isContentEditable) return 'textbox';
        if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return 'button';
        return 'text';
    }
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function ownText(el, max) {
    const t = clean(el.innerText !== undefined && el.innerText !== '' ? el.innerText : el.textContent);
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  /** A workable approximation of the accessible name. */
  function nameOf(el, role) {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? ownText(n, 120) : ''; }).join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map((l) => ownText(l, 120)).join(' '));
      if (t) return t;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['submit', 'button', 'reset'].includes(type) && el.value) return clean(el.value);
      if (type === 'image' && el.alt) return clean(el.alt);
      for (const a of ['placeholder', 'title', 'name']) { const v = clean(el.getAttribute(a)); if (v) return v; }
      return '';
    }
    if (tag === 'select') {
      const t = clean(el.getAttribute('title') || el.getAttribute('name'));
      if (t) return t;
    }
    if (tag === 'img') return clean(el.getAttribute('alt') || el.getAttribute('title'));
    if (tag === 'textarea' || el.isContentEditable) {
      for (const a of ['placeholder', 'title', 'name']) { const v = clean(el.getAttribute(a)); if (v) return v; }
    }
    const text = ownText(el, 120);
    if (text) return text;
    for (const a of ['title', 'placeholder', 'alt', 'name']) { const v = clean(el.getAttribute(a)); if (v) return v; }
    const img = el.querySelector('img[alt], [aria-label], svg title');
    if (img) return clean(img.getAttribute('alt') || img.getAttribute('aria-label') || img.textContent);
    return role === 'link' ? clean((el.getAttribute('href') || '').split(/[/?#]/).filter(Boolean).pop() || '') : '';
  }

  /** What the element currently holds/shows, for the agent's benefit (value, checked, chosen option). */
  function stateOf(el, role) {
    const tag = el.tagName.toLowerCase();
    const parts = [];
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') parts.push(el.checked ? 'checked' : 'not checked');
      else if (type === 'password') parts.push(el.value ? 'filled' : 'empty');
      else if (!['submit', 'button', 'reset', 'image', 'file'].includes(type)) parts.push(el.value ? `value: ${JSON.stringify(clean(el.value).slice(0, 60))}` : 'empty');
    } else if (tag === 'textarea' || (el.isContentEditable && role === 'textbox')) {
      const v = clean(tag === 'textarea' ? el.value : el.innerText);
      parts.push(v ? `value: ${JSON.stringify(v.slice(0, 60))}` : 'empty');
    } else if (tag === 'select') {
      const o = el.options && el.options[el.selectedIndex];
      if (o) parts.push(`selected: ${JSON.stringify(clean(o.text).slice(0, 60))}`);
    } else if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'tab') {
      const c = el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || el.getAttribute('aria-pressed');
      if (c === 'true') parts.push(role === 'tab' ? 'selected' : 'checked');
      else if (c === 'false') parts.push(role === 'tab' ? 'not selected' : 'not checked');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (el.getAttribute('aria-expanded') === 'true') parts.push('expanded');
    if (el.getAttribute('aria-expanded') === 'false') parts.push('collapsed');
    if (el.required) parts.push('required');
    return parts.join(', ');
  }

  function hintOf(el) {
    const bits = [];
    for (const a of ['placeholder', 'title', 'alt', 'aria-label', 'name']) { const v = clean(el.getAttribute(a)); if (v) bits.push(v); }
    if (el.tagName.toLowerCase() === 'input' && !['password'].includes((el.getAttribute('type') || '').toLowerCase()) && el.value) bits.push(clean(el.value).slice(0, 80));
    return bits.join(' ');
  }

  function isShown(el) {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return true;
  }

  const ORIGIN = () => ({
    x: Number(window.mozInnerScreenX) || 0,
    y: Number(window.mozInnerScreenY) || 0,
    dpr: window.devicePixelRatio || 1,
  });

  /**
   * Where to click, and whether a click there reaches the element. The point comes from the line
   * boxes (`getClientRects()`), not the bounding box: for a link wrapped onto two lines the bounding
   * box's centre is the gap between them (decision 127). The page itself is asked whether the point
   * lands on the element — an ancestor there is a miss, not a hit.
   */
  function place(el, o) {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let rects = [...el.getClientRects()].map((c) => ({ left: c.left, top: c.top, right: c.right, bottom: c.bottom })).filter((c) => c.right > c.left && c.bottom > c.top);
    if (!rects.length) rects = [{ left: r.left, top: r.top, right: r.right, bottom: r.bottom }];
    const p = P.pick(rects, vw, vh, (x, y) => {
      const top = document.elementFromPoint(x, y);
      return !!top && (top === el || el.contains(top));
    });
    return {
      x: Math.round((o.x + p.x) * o.dpr),
      y: Math.round((o.y + p.y) * o.dpr),
      w: Math.round(r.width * o.dpr),
      h: Math.round(r.height * o.dpr),
      visible: p.inView && !p.covered,
      covered: p.covered,
      // How far outside the viewport, in screen pixels (positive = below/right).
      below: !p.inView && r.top >= vh ? Math.round((r.top - vh) * o.dpr) : 0,
      above: !p.inView && r.bottom <= 0 ? Math.round(-r.bottom * o.dpr) : 0,
    };
  }

  function describe(el, o, withText) {
    const role = roleOf(el);
    const name = nameOf(el, role);
    if (!name && role === 'text') return undefined;
    const p = place(el, o);
    return {
      role,
      name,
      state: withText ? stateOf(el, role) : '',
      hint: hintOf(el),
      href: role === 'link' ? String(el.getAttribute('href') || '') : '',
      ids: clean(`${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`),
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      ...p,
    };
  }

  /** Elements worth reporting, in page order, de-duplicated (a button inside a link counts once). */
  function collect(selector, max) {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      if (out.length >= max) break;
      if (seen.has(el)) continue;
      if (!isShown(el)) continue;
      // Skip wrappers whose only content is one reported descendant (a <div onclick> around a <button>).
      const inner = el.querySelector(INTERACTIVE);
      if (inner && inner !== el && clean(el.innerText) === clean(inner.innerText) && el.matches('[onclick],[tabindex],div,span')) continue;
      seen.add(el);
      out.push(el);
    }
    return out;
  }

  const limitOf = (args) => Math.max(1, Math.min(20, Number(args && args.limit) || 8));

  /**
   * Everything find can point at, ranked for the query. Each record keeps its DOM element as `node`
   * (never sent: `slim` drops it), so scroll_to and select can act on the hit they found.
   */
  function candidates(query, limit) {
    const o = ORIGIN();
    const elements = [];
    for (const el of collect(`${INTERACTIVE},${HEADINGS},img[alt]`, 3000)) {
      const d = describe(el, o, true);
      if (d) elements.push({ ...d, node: el });
    }
    // Static text too, so "find 'Order total'" can point at a label; leaves only.
    let texts = 0;
    for (const el of document.querySelectorAll(TEXTY)) {
      if (texts >= 2500) break;
      if (el.children.length && [...el.children].some((c) => c.matches(TEXTY + ',' + INTERACTIVE))) continue;
      if (el.closest(INTERACTIVE)) continue;
      const t = ownText(el, 120);
      if (!t || t.length < 2) continue;
      if (!isShown(el)) continue;
      texts++;
      elements.push({ role: 'text', name: t, state: '', hint: '', href: '', ids: clean(`${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`), disabled: false, ...place(el, o), node: el });
    }
    return { o, ranked: S.rank(query, elements, limit), total: elements.length };
  }

  function find(args) {
    const { o, ranked, total } = candidates(String((args && args.query) || ''), limitOf(args));
    return { viewport: viewportInfo(o), elements: ranked.map(slim), total };
  }

  /** One frame after the page moved, so a re-place sees the new layout (a bounded wait: a hidden tab never paints). */
  const nextFrame = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(() => setTimeout(finish, 0));
      setTimeout(finish, 250);
    });

  /**
   * scroll_to: the page scrolls the best hit for the query into the middle of the viewport itself —
   * no mouse wheel, no guessing how far — and answers with the element placed again, so the result
   * says where it is now. A weak or missing hit scrolls nothing and answers as find would, with
   * `scrolled: false`, so the agent side can say why in find's own words.
   */
  async function scrollTo(args) {
    const { o, ranked, total } = candidates(String((args && args.query) || ''), limitOf(args));
    const best = ranked[0];
    if (!best || best.score < S.WEAK_SCORE) return { viewport: viewportInfo(o), elements: ranked.map(slim), total, scrolled: false };
    best.node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await nextFrame();
    const it = { ...best, ...place(best.node, o) };
    return { viewport: viewportInfo(o), elements: [slim(it)], total, scrolled: true };
  }

  /**
   * select: choose an option of a native <select> by its text. The best hit that is a <select> gets
   * the option — exact, then prefix, then contains, case-insensitively — and `input` and `change`
   * are dispatched so the page reacts as it would to a person. The element comes back with its new
   * state. No <select> among the hits (a custom menu is buttons, not this), or no such option:
   * nothing changes, and the answer says which, with the options it does have.
   */
  function select(args) {
    const option = clean(args && args.option);
    const { o, ranked, total } = candidates(String((args && args.query) || ''), limitOf(args));
    const hit = ranked.find((e) => e.score >= S.WEAK_SCORE && e.node.tagName.toLowerCase() === 'select');
    if (!hit) return { viewport: viewportInfo(o), elements: ranked.map(slim), total, selected: false, reason: 'no-select' };
    const node = hit.node;
    const opts = [...node.options];
    const want = option.toLowerCase();
    const textOf = (op) => clean(op.text || op.label).toLowerCase();
    const found =
      opts.find((op) => textOf(op) === want) ||
      (want && opts.find((op) => textOf(op).startsWith(want))) ||
      (want && opts.find((op) => textOf(op).includes(want)));
    if (!found) {
      return { viewport: viewportInfo(o), elements: [slim(hit)], total, selected: false, reason: 'no-option', options: opts.slice(0, 20).map((op) => clean(op.text)), optionCount: opts.length };
    }
    node.selectedIndex = found.index;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    const it = { ...hit, state: stateOf(node, hit.role), ...place(node, o) };
    return { viewport: viewportInfo(o), elements: [slim(it)], total, selected: true };
  }

  /**
   * Can a person type into this? Anything that takes a caret: a textarea, a contenteditable, and
   * every <input> but the ones that are really buttons or switches — a password field included,
   * which `roleOf` reports as a textbox.
   */
  const NOT_TEXT = ['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color'];
  function typeable(el, role) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (el.isContentEditable) return true;
    if (tag === 'input') return !NOT_TEXT.includes((el.getAttribute('type') || 'text').toLowerCase());
    return role === 'textbox' || role === 'searchbox';
  }

  /**
   * focus: put the caret in the best hit that can be typed into, so the keystrokes that follow (a
   * sign-in card's value, typed by the daemon) land in the right field. focus() scrolls the field
   * into view if it is off-screen, as a click would; a field that already holds something has its
   * content selected, so the typing replaces it rather than appending to it. Nothing matching, or a
   * best hit that is a button or a checkbox: nothing is touched and the answer says so with the
   * candidates, as find would. The answer never carries a value — only where the caret went.
   */
  async function focus(args) {
    const { o, ranked, total } = candidates(String((args && args.query) || ''), limitOf(args));
    const hit = ranked.find((e) => e.score >= S.WEAK_SCORE && typeable(e.node, e.role));
    if (!hit) return { viewport: viewportInfo(o), elements: ranked.map(slim), total, focused: false };
    const node = hit.node;
    try {
      node.focus();
      if (typeof node.select === 'function' && node.value) node.select();
    } catch (err) {
      return { viewport: viewportInfo(o), elements: [slim(hit)], total, focused: false };
    }
    await nextFrame();
    const it = { ...hit, state: stateOf(node, hit.role), ...place(node, o) };
    return { viewport: viewportInfo(o), elements: [slim(it)], total, focused: document.activeElement === node || node.contains(document.activeElement) };
  }

  function read(args) {
    const o = ORIGIN();
    const scope = String((args && args.scope) || 'interactive');
    const limit = Math.max(10, Math.min(300, Number(args && args.limit) || 120));
    if (scope === 'text') {
      const text = clean(document.body ? document.body.innerText : '').slice(0, 12000);
      return { viewport: viewportInfo(o), elements: [], text, total: 0 };
    }
    const all = [];
    for (const el of collect(`${INTERACTIVE},${HEADINGS}`, 3000)) {
      const d = describe(el, o, true);
      if (d) all.push(d);
    }
    const visible = all.filter((e) => e.visible);
    const below = all.filter((e) => e.below > 0).length;
    const above = all.filter((e) => e.above > 0).length;
    return {
      viewport: viewportInfo(o),
      elements: visible.slice(0, limit).map(slim),
      total: all.length,
      more: { visible: Math.max(0, visible.length - limit), below, above },
    };
  }

  function viewportInfo(o) {
    const doc = document.documentElement;
    return {
      x: Math.round(o.x * o.dpr),
      y: Math.round(o.y * o.dpr),
      width: Math.round(window.innerWidth * o.dpr),
      height: Math.round(window.innerHeight * o.dpr),
      scrollY: Math.round(window.scrollY * o.dpr),
      pageHeight: Math.round(Math.max(doc ? doc.scrollHeight : 0, document.body ? document.body.scrollHeight : 0) * o.dpr),
      frame: window === window.top ? 'top' : 'iframe',
    };
  }

  /** What travels to the daemon: no matching internals. */
  function slim(e) {
    return { role: e.role, name: e.name, state: e.state, x: e.x, y: e.y, w: e.w, h: e.h, visible: e.visible, covered: e.covered, below: e.below, above: e.above, score: e.score };
  }

  const OPS = { find, read, scroll_to: scrollTo, select, focus, ping: () => ({ ok: true }) };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return undefined;
    const op = Object.prototype.hasOwnProperty.call(OPS, msg.op) ? OPS[msg.op] : undefined;
    if (!op) return undefined;
    return Promise.resolve()
      .then(() => op(msg.args))
      .catch((err) => ({ error: String((err && err.message) || err) }));
  });
})();
