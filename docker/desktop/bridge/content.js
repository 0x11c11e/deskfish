// Deskfish page bridge — content script. Runs in every frame of every http(s) page.
//
// Answers two requests from the background script: `find` (elements matching a query, best
// first) and `read` (what is on the page: interactive elements in page order, or the text).
// Coordinates are screen pixels (the X display), computed from the frame's own screen origin, so
// they are right inside iframes too. Nothing here changes the page.
(function () {
  'use strict';
  if (window.__deskfishBridge) return;
  window.__deskfishBridge = true;

  const S = globalThis.DeskfishScore;

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

  function place(el, o) {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Click point: centre of the part inside the viewport when partly visible, else the centre.
    const ix0 = Math.max(0, r.left);
    const iy0 = Math.max(0, r.top);
    const ix1 = Math.min(vw, r.right);
    const iy1 = Math.min(vh, r.bottom);
    const inView = ix1 > ix0 && iy1 > iy0;
    const cx = inView ? (ix0 + ix1) / 2 : r.left + r.width / 2;
    const cy = inView ? (iy0 + iy1) / 2 : r.top + r.height / 2;
    let covered = false;
    if (inView) {
      const top = document.elementFromPoint(cx, cy);
      covered = !!top && top !== el && !el.contains(top) && !top.contains(el);
    }
    return {
      x: Math.round((o.x + cx) * o.dpr),
      y: Math.round((o.y + cy) * o.dpr),
      w: Math.round(r.width * o.dpr),
      h: Math.round(r.height * o.dpr),
      visible: inView && !covered,
      covered,
      // How far outside the viewport, in screen pixels (positive = below/right).
      below: !inView && r.top >= vh ? Math.round((r.top - vh) * o.dpr) : 0,
      above: !inView && r.bottom <= 0 ? Math.round(-r.bottom * o.dpr) : 0,
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

  function find(args) {
    const o = ORIGIN();
    const query = String((args && args.query) || '');
    const limit = Math.max(1, Math.min(20, Number(args && args.limit) || 8));
    const elements = [];
    for (const el of collect(`${INTERACTIVE},${HEADINGS},img[alt]`, 3000)) {
      const d = describe(el, o, true);
      if (d) elements.push(d);
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
      elements.push({ role: 'text', name: t, state: '', hint: '', href: '', ids: clean(`${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`), disabled: false, ...place(el, o) });
    }
    const ranked = S.rank(query, elements, limit);
    return {
      viewport: viewportInfo(o),
      elements: ranked.map(slim),
      total: elements.length,
    };
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

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return undefined;
    try {
      if (msg.op === 'find') return Promise.resolve(find(msg.args));
      if (msg.op === 'read') return Promise.resolve(read(msg.args));
      if (msg.op === 'ping') return Promise.resolve({ ok: true });
    } catch (err) {
      return Promise.resolve({ error: String((err && err.message) || err) });
    }
    return undefined;
  });
})();
