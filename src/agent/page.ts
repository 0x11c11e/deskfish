import type { PageElement, PageInfo } from '../computer/types';

/** Native-pixels-per-screenshot-pixel, as the loop keeps it. */
export interface Scale {
  x: number;
  y: number;
}

/**
 * Below this a match is "weak": the right role but none of the words, or one word of several.
 * `find` labels such a hit so the model does not click the nearest thing as if it were the target,
 * and `click_element` refuses to click one at all.
 */
export const WEAK_SCORE = 30;

/**
 * Turn what the page bridge reported (native screen coordinates) into the text the model reads,
 * with every coordinate converted to screenshot pixels — the only coordinate space the model uses.
 */
export function renderPage(page: PageInfo, scale: Scale, kind: 'find' | 'read_page', query?: string): string {
  const sx = (v: number) => Math.round(v / (scale.x || 1));
  const sy = (v: number) => Math.round(v / (scale.y || 1));
  const lines: string[] = [];
  lines.push(`Page ${page.title ? JSON.stringify(trim(page.title, 100)) : '(untitled)'} — ${page.url || '?'}`);
  const vp = page.viewport;
  if (vp && vp.pageHeight > vp.height + 4) {
    const bottom = Math.min(vp.pageHeight, vp.scrollY + vp.height);
    lines.push(
      `The viewport shows ${Math.round((100 * vp.scrollY) / vp.pageHeight)}–${Math.round((100 * bottom) / vp.pageHeight)}% of the page ` +
        `(${sy(vp.scrollY)}–${sy(bottom)} of ${sy(vp.pageHeight)} px).`,
    );
  }
  if (kind === 'read_page' && page.text !== undefined && !page.elements.length) {
    lines.push('', page.text.trim() || '(the page has no text)');
    return lines.join('\n');
  }
  if (!page.elements.length) {
    lines.push(
      kind === 'find'
        ? `No element matches ${JSON.stringify(query ?? '')}. Try other words (the visible text, a placeholder, the kind of control), scroll, or read_page to see what is there.`
        : 'No interactive elements are visible in the viewport.',
    );
  }
  // A find whose best hit only matched weakly (the right role but none of the words, or one word
  // of several) is labelled so the model does not click the nearest thing as if it were the target.
  const weak = kind === 'find' && page.elements.length > 0 && page.elements.every((e) => (e.score ?? 100) < WEAK_SCORE);
  if (weak) lines.push(`Nothing matches ${JSON.stringify(query ?? '')} well; the nearest candidates are:`);
  page.elements.forEach((e, i) => lines.push(`[${i + 1}] ${describeElement(e, sx, sy)}${kind === 'find' && !weak && (e.score ?? 100) < WEAK_SCORE ? ' (weak match)' : ''}`));
  const more = page.more;
  if (more) {
    const bits: string[] = [];
    if (more.visible) bits.push(`${more.visible} more visible element${more.visible === 1 ? '' : 's'} not listed`);
    if (more.below) bits.push(`${more.below} below the viewport (scroll down to reach them)`);
    if (more.above) bits.push(`${more.above} above it (scroll up)`);
    if (bits.length) lines.push(`Also: ${bits.join('; ')}.`);
  }
  return lines.join('\n');
}

/** One element in find's own words ("button \"Sign in\" at (600, 400)"), for click_element's result. */
export function renderElement(e: PageElement, scale: Scale): string {
  return describeElement(
    e,
    (v) => Math.round(v / (scale.x || 1)),
    (v) => Math.round(v / (scale.y || 1)),
  );
}

/**
 * Is this hit safe to click without a look first? Strong enough that the words really matched, and
 * in a place where a click at (x, y) reaches it: inside the viewport, nothing in front of it.
 */
export function clickable(e: PageElement): boolean {
  return (e.score ?? 100) >= WEAK_SCORE && e.visible && !e.covered;
}

/**
 * What `click_element` tells her. Clicked: find's words for the element it hit, then the other
 * candidates, so a near-miss is visible in the same message. Not clicked: why not, and find's own
 * rendering underneath — the weak-candidates line, the "scroll N px" line, the "covered" line — so
 * the next move is in the result rather than left to guesswork (the shape of decision 109).
 */
export function renderClick(page: PageInfo, scale: Scale, query: string, clicked?: PageElement): string {
  if (clicked) {
    const lines = [`Clicked ${renderElement(clicked, scale)}.`];
    const others = page.elements.filter((e) => e !== clicked);
    if (others.length) {
      lines.push('The other candidates, not clicked:');
      others.forEach((e, i) => lines.push(`[${i + 2}] ${renderElement(e, scale)}`));
    }
    return lines.join('\n');
  }
  const best = page.elements[0];
  let why: string;
  if (!best) why = `Nothing was clicked: no element matches ${JSON.stringify(query)}.`;
  else if (best.covered) why = 'Nothing was clicked: the best match is covered by something in front of it, so a click there would hit that instead.';
  else if (!best.visible) why = 'Nothing was clicked: the best match is off the visible part of the page. Scroll it into view first with scroll_to, then click_element again.';
  else why = `Nothing was clicked: nothing matches ${JSON.stringify(query)} well enough to click unseen. Look, or find with other words.`;
  return `${why}\n${renderPage(page, scale, 'find', query)}`;
}

/**
 * What `scroll_to` tells her. Scrolled: the element in find's words with where it is now, then
 * find's rendering under it (the viewport line says which part of the page shows). Not scrolled:
 * why, and the candidates the page had, in find's words — the next move is in the result.
 */
export function renderScroll(page: PageInfo, scale: Scale, query: string): string {
  const best = page.elements[0];
  if (page.scrolled && best) {
    const sx = Math.round(best.x / (scale.x || 1));
    const sy = Math.round(best.y / (scale.y || 1));
    const name = best.name ? JSON.stringify(trim(best.name, 80)) : '(unnamed)';
    return `Scrolled to ${best.role} ${name}${best.state ? ` (${best.state})` : ''}, now at (${sx}, ${sy}).\n${renderPage(page, scale, 'find', query)}`;
  }
  const why = best
    ? `Nothing was scrolled: nothing matches ${JSON.stringify(query)} well enough to scroll to unseen. Look, or find with other words.`
    : `Nothing was scrolled: no element matches ${JSON.stringify(query)}.`;
  return `${why}\n${renderPage(page, scale, 'find', query)}`;
}

/**
 * What `select_option` tells her. Selected: the dropdown in find's words, its state now showing the
 * choice. Not selected: no native dropdown matched (a custom menu is buttons, for click_element),
 * with the candidates; or the dropdown has no such option, with the options it does have, so the
 * next call can name one exactly.
 */
export function renderSelect(page: PageInfo, scale: Scale, query: string, option: string): string {
  const best = page.elements[0];
  if (page.selected && best) return `Selected ${JSON.stringify(option)}: ${renderElement(best, scale)}.`;
  if (page.reason === 'no-option' && best) {
    const listed = (page.options ?? []).map((o) => JSON.stringify(o)).join(', ');
    const count = page.optionCount ?? page.options?.length ?? 0;
    const more = count > (page.options?.length ?? 0) ? ` (the first ${page.options?.length} of ${count})` : '';
    return `Nothing was selected: ${renderElement(best, scale)} has no option matching ${JSON.stringify(option)}. Its options are${more}: ${listed || '(none)'}.`;
  }
  const why = best
    ? `Nothing was selected: no native dropdown matches ${JSON.stringify(query)} — the nearest elements are below. A custom menu is buttons: open it with click_element and click the option.`
    : `Nothing was selected: no element matches ${JSON.stringify(query)}.`;
  return `${why}\n${renderPage(page, scale, 'find', query)}`;
}

/**
 * What a `focus` reports back inside `ask_fill` — never to a tool of hers, so it is deliberately
 * thinner than find's: role, name and place, and no `state`. A field's state is its current value,
 * and the one thing this whole path exists to guarantee is that no value travels with it; the
 * candidates listed after a failure are the page's own controls, and she can read their state with
 * `find` if she wants it.
 */
export function renderFocus(page: PageInfo, scale: Scale, query: string, label: string): string {
  const sx = (v: number) => Math.round(v / (scale.x || 1));
  const sy = (v: number) => Math.round(v / (scale.y || 1));
  const where = (e: PageElement) => `${e.role} ${e.name ? JSON.stringify(trim(e.name, 80)) : '(unnamed)'} at (${sx(e.x)}, ${sy(e.y)})`;
  const best = page.elements[0];
  if (page.focused && best) return `${label}: ${where(best)}`;
  const why = best
    ? `${label}: nothing matching ${JSON.stringify(query)} is a field that can be typed into.`
    : `${label}: no element matches ${JSON.stringify(query)}.`;
  const near = page.elements.slice(0, 5).map((e, i) => `[${i + 1}] ${where(e)}`);
  return near.length ? `${why} The nearest controls are: ${near.join('; ')}.` : why;
}

function describeElement(e: PageElement, sx: (v: number) => number, sy: (v: number) => number): string {
  const name = e.name ? JSON.stringify(trim(e.name, 80)) : '(unnamed)';
  const state = e.state ? ` (${e.state})` : '';
  let where: string;
  if (e.visible) where = `at (${sx(e.x)}, ${sy(e.y)})`;
  else if (e.covered) where = `at (${sx(e.x)}, ${sy(e.y)}), but covered by something in front of it (a dialog, menu or overlay?)`;
  else if (e.below) where = `off-screen, ${sy(e.below)} px below the viewport — scroll down first`;
  else if (e.above) where = `off-screen, ${sy(e.above)} px above the viewport — scroll up first`;
  else where = `at (${sx(e.x)}, ${sy(e.y)}), not currently visible`;
  return `${e.role} ${name}${state} ${where}`;
}

function trim(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
