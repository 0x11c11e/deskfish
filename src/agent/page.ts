import type { PageElement, PageInfo } from '../computer/types';

/** Native-pixels-per-screenshot-pixel, as the loop keeps it. */
export interface Scale {
  x: number;
  y: number;
}

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
  const weak = kind === 'find' && page.elements.length > 0 && page.elements.every((e) => (e.score ?? 100) < 30);
  if (weak) lines.push(`Nothing matches ${JSON.stringify(query ?? '')} well; the nearest candidates are:`);
  page.elements.forEach((e, i) => lines.push(`[${i + 1}] ${describeElement(e, sx, sy)}${kind === 'find' && !weak && (e.score ?? 100) < 30 ? ' (weak match)' : ''}`));
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
