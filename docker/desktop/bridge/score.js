// Deskfish page bridge — the matcher behind the agent's `find` tool.
//
// Pure functions, no DOM: loaded by the content script (as a plain script) and by the unit tests
// (as a CommonJS module). Everything hangs off `DeskfishScore` on the global object.
(function (root) {
  'use strict';

  /** Words the agent may use for a kind of control, mapped to the role the page reports. */
  const ROLE_WORDS = {
    button: 'button', btn: 'button',
    link: 'link',
    field: 'textbox', input: 'textbox', box: 'textbox', textbox: 'textbox', textarea: 'textbox', text: 'textbox',
    search: 'searchbox', searchbox: 'searchbox',
    checkbox: 'checkbox', check: 'checkbox', tick: 'checkbox',
    radio: 'radio',
    dropdown: 'combobox', select: 'combobox', combobox: 'combobox', menu: 'menuitem', option: 'option',
    tab: 'tab', switch: 'switch', toggle: 'switch', slider: 'slider',
    heading: 'heading', title: 'heading', header: 'heading',
    image: 'img', img: 'img', picture: 'img', icon: 'img',
  };

  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[‘’“”]/g, "'")
      .replace(/[^\p{L}\p{N}@.\-']+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(s) {
    return normalize(s).split(' ').filter((t) => t.length > 0);
  }

  /**
   * How well a page element matches the agent's query. 0 = no match. Higher is better; ~100 is an
   * exact name. `el` is a plain record: { role, name, hint (placeholder/title/value…), href, ids (id
   * and class words), visible, disabled }.
   */
  function score(query, el) {
    const q = normalize(query);
    if (!q) return 0;
    const qTokens = tokens(query);
    const name = normalize(el.name);
    const hint = normalize(el.hint);
    const href = normalize(el.href);
    const ids = normalize(el.ids);
    const role = normalize(el.role);

    // Role words in the query ("search box", "login button") count for the role, not the name.
    const roleWanted = new Set();
    const nameTokens = [];
    for (const t of qTokens) {
      const r = ROLE_WORDS[t];
      if (r) roleWanted.add(r);
      else nameTokens.push(t);
    }
    // "text" and "search" are also ordinary words; keep them as name tokens too.
    for (const t of qTokens) if ((t === 'text' || t === 'search' || t === 'title' || t === 'menu') && !nameTokens.includes(t)) nameTokens.push(t);
    const nameQuery = nameTokens.join(' ');

    let s = 0;
    if (nameQuery) {
      const compactName = name.replace(/[ \-]/g, '');
      const compactQuery = nameQuery.replace(/[ \-]/g, '');
      if (name === nameQuery) s = 100;
      else if (compactName && compactName === compactQuery) s = 95; // "login" ~ "Log in", "signup" ~ "Sign-up"
      else if (name && name.startsWith(nameQuery + ' ')) s = 82;
      else if (name && name.includes(nameQuery)) s = 70 + Math.round(10 * Math.min(1, nameQuery.length / name.length));
      else if (compactName && compactQuery.length > 3 && compactName.includes(compactQuery)) s = 62;
      else {
        const present = nameTokens.filter((t) => name.split(' ').some((w) => w === t || (t.length > 3 && w.startsWith(t))));
        if (present.length === nameTokens.length && nameTokens.length) s = 60;
        else if (present.length) s = Math.round((40 * present.length) / nameTokens.length);
      }
      // Other texts of the element: placeholder, title, current value, alt.
      if (hint) {
        if (hint === nameQuery) s = Math.max(s, 90);
        else if (hint.includes(nameQuery)) s = Math.max(s, 65);
        else {
          const present = nameTokens.filter((t) => hint.split(' ').includes(t));
          if (present.length) s = Math.max(s, Math.round((35 * present.length) / nameTokens.length));
        }
      }
      if (href && s < 50) {
        const present = nameTokens.filter((t) => href.includes(t));
        if (present.length === nameTokens.length) s = Math.max(s, 45);
        else if (present.length) s = Math.max(s, Math.round((25 * present.length) / nameTokens.length));
      }
      if (ids && s < 40) {
        const present = nameTokens.filter((t) => ids.split(' ').includes(t));
        if (present.length) s = Math.max(s, Math.round((20 * present.length) / nameTokens.length));
      }
    }

    if (roleWanted.size) {
      const wanted = [...roleWanted];
      const roleMatches = wanted.some((r) => r === role || (r === 'textbox' && (role === 'searchbox' || role === 'combobox')) || (r === 'searchbox' && role === 'textbox'));
      if (!nameQuery) s = roleMatches ? 50 : 0; // "the search box": role alone decides
      else if (roleMatches) s += 12;
      else if (s > 0) s = Math.max(1, s - 25);
    }

    if (s <= 0) return 0;
    if (el.visible) s += 3;
    if (el.disabled) s -= 8;
    return Math.max(1, Math.min(120, s));
  }

  /** Top `limit` elements by score (stable on ties: page order). */
  function rank(query, elements, limit) {
    const scored = [];
    elements.forEach((el, i) => {
      const s = score(query, el);
      if (s > 0) scored.push({ el, s, i });
    });
    scored.sort((a, b) => b.s - a.s || a.i - b.i);
    return scored.slice(0, limit || 8).map((x) => ({ ...x.el, score: x.s }));
  }

  root.DeskfishScore = { normalize, tokens, score, rank, ROLE_WORDS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
