/**
 * Minimal markdown for her replies and her files: **bold**, `code`, # headings and links. Escapes
 * `& < >` first, then injects only <strong>, <code> and <a> around already-escaped text, so model
 * output can never smuggle markup into the view. A link is `[text](http…)` or a bare `http(s)://…`;
 * its href must start with http:// or https:// (anything else stays text) and has its quotes escaped.
 * Newlines survive through the element's `white-space: pre-wrap`. Pure: the tests import it.
 */

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (text: string) => text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A bare URL in escaped text: up to a space, a quote or an escaped `<`/`>`. */
const BARE = String.raw`https?:\/\/(?:(?!&lt;|&gt;)[^\s"'<>])+`;
/** Code spans, markdown links and bare URLs in one pass, so a link inside code stays code and no output is scanned twice. */
const INLINE = new RegExp(String.raw`\`([^\`\n]+)\`|\[([^\]\n]+)\]\((https?:\/\/[^\s)"'<>]+)\)|(${BARE})`, 'g');

function anchor(href: string, label: string): string {
  if (!/^https?:\/\//.test(href)) return label;
  return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

export function mdLite(text: string): string {
  // Code and links become placeholders first, so bold and headings never reach inside a tag or an href.
  const tokens: string[] = [];
  const hold = (html: string) => `\u0000${tokens.push(html) - 1}\u0000`;
  return escapeHtml(text.replace(/\u0000/g, ''))
    .replace(INLINE, (whole, code?: string, label?: string, href?: string, bare?: string) => {
      if (code !== undefined) return hold(`<code>${code}</code>`);
      if (label !== undefined && href !== undefined) return hold(anchor(href, label));
      if (bare === undefined) return whole;
      // Sentence punctuation (and markdown emphasis) right after a URL is not part of it.
      const url = bare.replace(/[.,;:!?)\]*_]+$/, '');
      return hold(anchor(url, url)) + bare.slice(url.length);
    })
    .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,4} (.+)$/gm, '<strong>$1</strong>')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => tokens[Number(i)]);
}
