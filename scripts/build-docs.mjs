#!/usr/bin/env node
// Renders docs/*.md into docs/site/index.html: one self-contained page (works from file://, no
// network) with a sidebar, an on-this-page outline, search, and light/dark themes.
//
// The markdown files are the source of truth: the bot reads the very same files through its
// read_docs tool, so a change to a page updates both the site and what the bot knows.
//
//   node scripts/build-docs.mjs        (also runs as part of `npm run build`)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const OUT_FILE = path.join(DOCS_DIR, 'site', 'index.html');
const SECTION_ORDER = ['Start here', 'Using Deskfish', 'Under the hood', 'Reference', 'Help'];

// ---------------------------------------------------------------- markdown → html
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (s) => s.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const stripTags = (html) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

export function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  if (!m) return { meta, body: raw };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

function link(text, href, page) {
  if (/^(https?:|mailto:)/.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  const [slug, anchor] = href.split('#');
  const target = slug ? `#${slug}${anchor ? '/' + anchor : ''}` : `#${page.slug}/${anchor}`;
  return `<a href="${target}">${text}</a>`;
}

const IMAGES_DIR = path.join(DOCS_DIR, 'images');
function imageTag(alt, file) {
  const p = path.join(IMAGES_DIR, file);
  if (!fs.existsSync(p)) return `<em>[missing image ${esc(file)}]</em>`;
  const mime = file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'image/jpeg' : 'image/svg+xml';
  return `<img src="data:${mime};base64,${fs.readFileSync(p).toString('base64')}" alt="${esc(alt)}" loading="lazy">`;
}

function inline(s, page) {
  let t = esc(s);
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0001${codes.length - 1}\u0001`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, file) => imageTag(alt, file));
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => link(text, href, page));
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[Number(i)]);
  return t;
}

const isFence = (l) => /^```/.test(l);
const isHeading = (l) => /^#{1,4}\s/.test(l);
const isHr = (l) => /^-{3,}\s*$/.test(l);
const isQuote = (l) => /^>/.test(l);
const isList = (l) => /^\s*(?:[-*]|\d+\.)\s+/.test(l);
const isTable = (lines, i) => /^\|/.test(lines[i]) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1]);
const startsBlock = (lines, i) => isFence(lines[i]) || isHeading(lines[i]) || isHr(lines[i]) || isQuote(lines[i]) || isList(lines[i]) || isTable(lines, i);

function splitRow(line) {
  const cells = [];
  let cur = '';
  let inCode = false;
  for (const ch of line) {
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((c) => c.trim());
}

function list(buf, ctx) {
  const items = [];
  for (const raw of buf) {
    const m = raw.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (m) items.push({ level: m[1].length >= 2 ? 1 : 0, ordered: /\d/.test(m[2]), text: m[3] });
    else if (items.length) items[items.length - 1].text += ' ' + raw.trim();
  }
  let html = '';
  const open = [];
  const openTag = (ordered) => {
    const t = ordered ? 'ol' : 'ul';
    open.push(t);
    html += `<${t}>`;
  };
  const closeTag = () => (html += `</${open.pop()}>`);
  let prev = -1;
  for (const it of items) {
    if (prev === -1 || it.level > prev) openTag(it.ordered);
    else if (it.level < prev) {
      html += '</li>';
      closeTag();
      html += '</li>';
    } else html += '</li>';
    html += `<li>${inline(it.text, ctx.page)}`;
    prev = it.level;
  }
  html += '</li>';
  while (open.length > 1) {
    closeTag();
    html += '</li>';
  }
  closeTag();
  return html;
}

function blocks(lines, ctx) {
  const out = [];
  const addText = (html) => (ctx.sections[ctx.sections.length - 1].text += ' ' + stripTags(html));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (isFence(line)) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) buf.push(lines[i++]);
      i++;
      const code = esc(buf.join('\n'));
      out.push(
        `<figure class="code"${lang && lang !== 'text' ? ` data-lang="${esc(lang)}"` : ''}><pre><code>${code}</code></pre><button class="copy" type="button">Copy</button></figure>`,
      );
      addText(code);
      continue;
    }
    if (isHeading(line)) {
      const m = line.match(/^(#{1,4})\s+(.*)$/);
      const level = m[1].length;
      const text = m[2].trim();
      const id = slugify(text);
      ctx.headings.push({ level, text, id });
      ctx.sections.push({ heading: text, id, text: '' });
      out.push(`<h${level} id="${id}">${inline(text, ctx.page)}<a class="anchor" href="#${ctx.page.slug}/${id}" aria-label="Link to this section">#</a></h${level}>`);
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (isTable(lines, i)) {
      const header = splitRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      let t = '<div class="table"><table><thead><tr>' + header.map((c) => `<th>${inline(c, ctx.page)}</th>`).join('') + '</tr></thead><tbody>';
      for (const r of rows) t += '<tr>' + r.map((c) => `<td>${inline(c, ctx.page)}</td>`).join('') + '</tr>';
      t += '</tbody></table></div>';
      out.push(t);
      addText(t);
      continue;
    }
    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      let kind = 'note';
      const k = buf[0] && buf[0].match(/^\[!(\w+)\]\s*$/);
      if (k) {
        kind = k[1].toLowerCase();
        buf.shift();
      }
      const label = { note: 'Note', tip: 'Tip', warning: 'Warning' }[kind] ?? kind;
      out.push(`<aside class="callout ${kind}"><p class="callout-label">${label}</p>${blocks(buf, ctx)}</aside>`);
      continue;
    }
    if (isList(line)) {
      const buf = [];
      while (i < lines.length && (isList(lines[i]) || /^\s{2,}\S/.test(lines[i]))) buf.push(lines[i++]);
      const html = list(buf, ctx);
      out.push(html);
      addText(html);
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) buf.push(lines[i++]);
    const html = inline(buf.join(' '), ctx.page);
    if (/^<img [^>]*>$/.test(html)) {
      out.push(`<figure class="shot">${html}</figure>`);
      continue;
    }
    out.push(`<p>${html}</p>`);
    addText(html);
  }
  return out.join('\n');
}

function render(md, page) {
  const ctx = { page, headings: [], sections: [{ heading: '', id: '', text: '' }] };
  const html = blocks(md.split(/\r?\n/), ctx);
  return { html, headings: ctx.headings, sections: ctx.sections.filter((s) => s.text.trim()) };
}

// ---------------------------------------------------------------- pages
export function loadPages(dir = DOCS_DIR) {
  const pages = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'));
    pages.push({
      slug: file.replace(/\.md$/, ''),
      title: meta.title ?? file,
      description: meta.description ?? '',
      section: meta.section ?? 'Other',
      order: Number(meta.order ?? 99),
      tagline: meta.tagline ?? '',
      hero: meta.hero === 'true',
      body,
    });
  }
  const rank = (s) => {
    const i = SECTION_ORDER.indexOf(s);
    return i === -1 ? SECTION_ORDER.length : i;
  };
  return pages.sort((a, b) => rank(a.section) - rank(b.section) || a.order - b.order || a.title.localeCompare(b.title));
}

const FISH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M6.5 10c1.4-1.9 3.3-2.7 4.9-2.4 1.7.3 2.9 1.4 3.4 2.4-.5 1-1.7 2.1-3.4 2.4-1.6.3-3.5-.5-4.9-2.4z"/><path d="M14.8 10l2.9-1.9v3.8z"/><circle cx="8.7" cy="9.6" r=".9" fill="currentColor" stroke="none"/></svg>`;
const ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;
const ICON_SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
const ICON_MENU = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`;

const CSS = `
:root {
  color-scheme: light;
  /* Palette and type follow the deskfish.sh website: warm paper, deep green ink, DM Sans. */
  --sans: "DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --serif: "Instrument Serif", Georgia, "Times New Roman", serif;
  --mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --bg: #eeeae1; --bg-2: #f4f0e7; --bg-3: #e7ebdf;
  --fg: #20342b; --fg-2: #53685b; --fg-3: #7e9084;
  --line: #c4cdbf; --line-2: #b2bdac;
  --accent: #256b54; --accent-bg: #e2e6da; --accent-line: #a9c1b2;
  --warn: #8a5a00; --warn-bg: #f7efd9; --warn-line: #e4d2a0;
  --code-bg: #f4f0e7; --mark: #f1e6a6; --sheen: rgba(255,255,255,.45);
  --topbar: 56px;
}
:root:not([data-theme="light"]) { }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #111c18; --bg-2: #1c2e26; --bg-3: #263c30;
    --fg: #edf2e8; --fg-2: #b0c0b3; --fg-3: #7f948a;
    --line: #3a5144; --line-2: #4a6355;
    --accent: #8ddcba; --accent-bg: #192923; --accent-line: #3a5144;
    --warn: #f0b64a; --warn-bg: #231a07; --warn-line: #4a3812;
    --code-bg: #1c2e26; --mark: #4d4300; --sheen: rgba(255,255,255,.07);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #111c18; --bg-2: #1c2e26; --bg-3: #263c30;
  --fg: #edf2e8; --fg-2: #b0c0b3; --fg-3: #7f948a;
  --line: #3a5144; --line-2: #4a6355;
  --accent: #8ddcba; --accent-bg: #192923; --accent-line: #3a5144;
  --warn: #f0b64a; --warn-bg: #231a07; --warn-line: #4a3812;
  --code-bg: #1c2e26; --mark: #4d4300; --sheen: rgba(255,255,255,.07);
}
* { box-sizing: border-box; }
html { scroll-padding-top: calc(var(--topbar) + 24px); }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15.5px/1.65 var(--sans); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
a { color: inherit; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
kbd { font: 11px/1 var(--mono); color: var(--fg-2); border: 1px solid var(--line-2); border-bottom-width: 2px; border-radius: 5px; padding: 3px 5px; background: var(--bg); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.skip { position: absolute; left: -999px; top: 8px; background: var(--bg); padding: 8px 12px; border: 1px solid var(--line); z-index: 100; }
.skip:focus { left: 8px; }

/* top bar */
.topbar { position: sticky; top: 0; z-index: 20; height: var(--topbar); display: flex; align-items: center; gap: 14px; padding: 0 20px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: saturate(160%) blur(10px); -webkit-backdrop-filter: saturate(160%) blur(10px); }
.menu { display: none; width: 36px; height: 36px; border-radius: 8px; align-items: center; justify-content: center; }
.menu svg { width: 20px; height: 20px; }
.brand { display: flex; align-items: center; gap: 9px; text-decoration: none; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; }
.brand svg { width: 22px; height: 22px; color: var(--accent); }
.brand .docs { color: var(--fg-2); font-weight: 500; }
.brand .docs::before { content: "/"; color: var(--line-2); margin-right: 9px; font-weight: 400; }
.spacer { flex: 1; }
.search { position: relative; width: min(360px, 40vw); }
.search svg { position: absolute; left: 10px; top: 50%; width: 16px; height: 16px; transform: translateY(-50%); color: var(--fg-3); pointer-events: none; }
.search input { width: 100%; height: 36px; padding: 0 64px 0 34px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-2); color: var(--fg); font: 14px var(--sans); outline: none; }
.search input::placeholder { color: var(--fg-3); }
.search input:focus { border-color: var(--line-2); background: var(--bg); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.search input::-webkit-search-cancel-button { display: none; }
.search kbd { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); pointer-events: none; }
.results { position: absolute; top: calc(100% + 6px); left: 0; right: 0; max-height: min(60vh, 460px); overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.14); padding: 6px; z-index: 30; }
.results a { display: block; padding: 8px 10px; border-radius: 6px; text-decoration: none; }
.results a.active, .results a:hover { background: var(--bg-2); }
.results .where { font-size: 12px; color: var(--fg-2); }
.results .where strong { color: var(--fg); font-weight: 600; }
.results .snip { font-size: 13px; color: var(--fg-2); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.results .empty { padding: 10px; font-size: 13px; color: var(--fg-2); }
mark { background: var(--mark); color: inherit; border-radius: 2px; padding: 0 1px; }
.version { font: 12px var(--mono); color: var(--fg-3); white-space: nowrap; }
.theme { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--fg-2); border: 1px solid var(--line); }
.theme:hover { color: var(--fg); background: var(--bg-2); }
.theme svg { width: 17px; height: 17px; }
.theme .moon, :root[data-theme="dark"] .theme .sun { display: none; }
:root[data-theme="dark"] .theme .moon { display: block; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .theme .sun { display: none; } :root:not([data-theme="light"]) .theme .moon { display: block; } }

/* shell */
.shell { display: grid; grid-template-columns: 264px minmax(0, 1fr) 232px; max-width: 1360px; margin: 0 auto; }
.sidebar { position: sticky; top: var(--topbar); height: calc(100vh - var(--topbar)); overflow-y: auto; padding: 28px 14px 40px 20px; border-right: 1px solid var(--line); scrollbar-width: thin; }
.group + .group { margin-top: 22px; }
.group-title { margin: 0 0 6px 10px; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3); }
.sidebar a { display: block; position: relative; padding: 6px 10px; border-radius: 6px; font-size: 14px; color: var(--fg-2); text-decoration: none; line-height: 1.35; }
.sidebar a:hover { color: var(--fg); background: var(--bg-2); }
.sidebar a.active { color: var(--fg); font-weight: 500; background: var(--bg-2); }
.sidebar a.active::before { content: ""; position: absolute; left: 0; top: 7px; bottom: 7px; width: 2px; border-radius: 2px; background: var(--accent); }
main { padding: 44px 56px 96px; min-width: 0; }
.page { max-width: 740px; }
.toc { position: sticky; top: var(--topbar); height: calc(100vh - var(--topbar)); overflow-y: auto; padding: 44px 20px 40px 16px; font-size: 13px; }
.toc-title { margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3); }
.toc ul { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--line); }
.toc li a { display: block; padding: 4px 0 4px 12px; margin-left: -1px; border-left: 1px solid transparent; color: var(--fg-2); text-decoration: none; line-height: 1.4; }
.toc li.h3 a { padding-left: 24px; }
.toc li a:hover { color: var(--fg); }
.toc li a.active { color: var(--fg); border-left-color: var(--accent); }

/* article */
.eyebrow { margin: 0 0 10px; font-size: 13px; font-weight: 500; color: var(--accent); }
h1 { margin: 0; font-size: 38px; line-height: 1.15; font-weight: 600; letter-spacing: -0.02em; }
h1 em, .hero em { font-family: var(--serif); font-style: italic; font-weight: 400; color: var(--accent); }
.lede { margin: 12px 0 0; font-size: 17.5px; line-height: 1.55; color: var(--fg-2); }
.prose { margin-top: 32px; }
.prose > :first-child { margin-top: 0; }
h2 { margin: 52px 0 14px; font-size: 24px; line-height: 1.25; font-weight: 600; letter-spacing: -0.02em; padding-top: 0; }
h3 { margin: 32px 0 10px; font-size: 17.5px; font-weight: 600; letter-spacing: -0.01em; }
h4 { margin: 24px 0 8px; font-size: 15.5px; font-weight: 600; }
h2 .anchor, h3 .anchor, h4 .anchor { margin-left: 8px; color: var(--fg-3); text-decoration: none; opacity: 0; font-weight: 400; }
h2:hover .anchor, h3:hover .anchor, h4:hover .anchor, .anchor:focus-visible { opacity: 1; }
p { margin: 0 0 18px; }
.prose a { color: var(--accent); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent); text-underline-offset: 3px; }
.prose a:hover { text-decoration-color: var(--accent); }
strong { font-weight: 600; }
ul, ol { margin: 0 0 18px; padding-left: 24px; }
li { margin: 6px 0; }
li > ul, li > ol { margin: 6px 0 0; }
hr { border: 0; border-top: 1px solid var(--line); margin: 40px 0; }
code { font: 0.86em/1.5 var(--mono); background: var(--bg-3); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; }
.code { position: relative; margin: 0 0 22px; border: 1px solid var(--line); border-radius: 10px; background: var(--code-bg); overflow: hidden; }
.code[data-lang]::before { content: attr(data-lang); position: absolute; top: 8px; left: 14px; font: 11px var(--mono); color: var(--fg-3); }
.code pre { margin: 0; padding: 30px 16px 16px; overflow-x: auto; }
.code:not([data-lang]) pre { padding-top: 16px; }
.code code { display: block; background: none; border: 0; padding: 0; font-size: 13px; line-height: 1.6; }
.code .copy { position: absolute; top: 6px; right: 8px; font-size: 12px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg-2); opacity: 0; transition: opacity .15s; }
.code:hover .copy, .code .copy:focus-visible { opacity: 1; }
.code .copy:hover { color: var(--fg); }
.table { margin: 0 0 22px; overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 500; color: var(--fg-2); background: var(--bg-2); padding: 9px 14px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td code { white-space: nowrap; }
.callout { margin: 0 0 22px; padding: 14px 16px 2px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg-2); }
.callout-label { margin: 0 0 6px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--fg-2); }
.callout.tip { background: var(--accent-bg); border-color: var(--accent-line); }
.callout.tip .callout-label { color: var(--accent); }
.callout.warning { background: var(--warn-bg); border-color: var(--warn-line); }
.callout.warning .callout-label { color: var(--warn); }
.callout p:last-child { margin-bottom: 12px; }

.shot { margin: 0 0 22px; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--bg-2); }
.shot img { display: block; width: 100%; height: auto; }

/* the tank: the one flourish */
.tank { margin: 30px 0 0; }
.glass { position: relative; overflow: hidden; border: 1px solid var(--accent-line); border-radius: 18px; padding: 44px 28px 40px; text-align: center; background: radial-gradient(120% 120% at 0% 0%, var(--accent-bg) 0%, var(--bg) 62%); }
.glass::after { content: ""; position: absolute; z-index: 0; top: -60%; right: -10%; width: 55%; height: 220%; background: linear-gradient(115deg, transparent 42%, var(--sheen) 50%, transparent 58%); transform: rotate(6deg); pointer-events: none; }
.glass > svg, .glass > .tagline { position: relative; z-index: 1; }
.glass svg { width: 92px; height: 92px; color: var(--accent); display: block; margin: 0 auto 18px; }
.glass .tagline { margin: 0; font-size: 22px; line-height: 1.3; font-weight: 600; letter-spacing: -0.015em; }
.bubble { position: absolute; bottom: -12px; width: 7px; height: 7px; border-radius: 50%; border: 1px solid var(--accent); opacity: 0; }
.bubble:nth-child(1) { left: 14%; animation: rise 11s linear 0s infinite; }
.bubble:nth-child(2) { left: 22%; width: 4px; height: 4px; animation: rise 9s linear 3s infinite; }
.bubble:nth-child(3) { left: 82%; animation: rise 13s linear 6s infinite; }
@keyframes rise { 0% { transform: translateY(0); opacity: 0; } 12% { opacity: .5; } 90% { opacity: .35; } 100% { transform: translateY(-260px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .bubble { display: none; } }

/* pager */
.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 64px; padding-top: 28px; border-top: 1px solid var(--line); }
.pager a { display: flex; flex-direction: column; gap: 3px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 10px; text-decoration: none; }
.pager a:hover { border-color: var(--accent-line); background: var(--bg-2); }
.pager .next { text-align: right; grid-column: 2; }
.pager span { font-size: 12px; color: var(--fg-2); }
.pager strong { font-weight: 500; }
.pager .next strong::after { content: " →"; color: var(--fg-3); }
.pager .prev strong::before { content: "← "; color: var(--fg-3); }
.foot { margin-top: 56px; font-size: 13px; color: var(--fg-3); }

/* responsive */
@media (max-width: 1180px) { .shell { grid-template-columns: 250px minmax(0, 1fr); } .toc { display: none; } main { padding: 40px 40px 80px; } }
@media (max-width: 860px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .menu { display: flex; }
  .sidebar { position: fixed; left: 0; top: var(--topbar); width: min(320px, 86vw); background: var(--bg); transform: translateX(-100%); transition: transform .2s ease; z-index: 25; box-shadow: none; }
  body.nav-open .sidebar { transform: none; box-shadow: 0 0 0 100vw rgba(0,0,0,.35); }
  main { padding: 28px 20px 64px; }
  h1 { font-size: 31px; }
  .search { width: 100%; }
  .search kbd, .version { display: none; }
  .brand .docs { display: none; }
  .pager { grid-template-columns: 1fr; }
  .pager .next { grid-column: auto; }
}
@media (prefers-reduced-motion: reduce) { .sidebar { transition: none; } }
`;

const CLIENT_JS = `
(function () {
  var root = document.documentElement;
  var pages = window.__PAGES__, index = window.__INDEX__;
  var bySlug = {}; pages.forEach(function (p) { bySlug[p.slug] = p; });
  var articles = {}; Array.prototype.forEach.call(document.querySelectorAll('article.page'), function (a) { articles[a.dataset.slug] = a; });
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.sidebar a'));
  var tocList = document.getElementById('tocList');
  var observer = null;

  function parseHash() {
    var h = decodeURIComponent(location.hash.replace(/^#\\/?/, ''));
    var parts = h.split('/');
    return { slug: parts[0] || pages[0].slug, anchor: parts.slice(1).join('/') };
  }
  function buildToc(article) {
    if (observer) { observer.disconnect(); observer = null; }
    tocList.innerHTML = '';
    var heads = Array.prototype.slice.call(article.querySelectorAll('h2, h3'));
    heads.forEach(function (h) {
      var li = document.createElement('li'); li.className = h.tagName.toLowerCase();
      var a = document.createElement('a'); a.href = '#' + article.dataset.slug + '/' + h.id; a.textContent = h.firstChild.textContent || h.textContent;
      li.appendChild(a); tocList.appendChild(li);
    });
    document.getElementById('toc').hidden = heads.length === 0;
    if (!heads.length || !('IntersectionObserver' in window)) return;
    var current = null;
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) current = e.target.id; });
      if (!current) return;
      Array.prototype.forEach.call(tocList.querySelectorAll('a'), function (a) { a.classList.toggle('active', a.getAttribute('href').split('/').pop() === current); });
    }, { rootMargin: '-64px 0px -70% 0px', threshold: 0 });
    heads.forEach(function (h) { observer.observe(h); });
  }
  function route() {
    var r = parseHash();
    var page = bySlug[r.slug] || pages[0];
    Object.keys(articles).forEach(function (s) { articles[s].hidden = s !== page.slug; });
    navLinks.forEach(function (a) { a.classList.toggle('active', a.dataset.slug === page.slug); });
    document.title = page.title + ' · Deskfish Docs';
    document.body.classList.remove('nav-open');
    buildToc(articles[page.slug]);
    if (r.anchor) { var el = document.getElementById(r.anchor); if (el) { el.scrollIntoView(); return; } }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  route();

  // sidebar on small screens
  document.getElementById('menu').addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
  document.addEventListener('click', function (e) {
    if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar') && !e.target.closest('#menu')) document.body.classList.remove('nav-open');
  });

  // theme
  var THEME_KEY = 'deskfish-docs-theme';
  try { var saved = localStorage.getItem(THEME_KEY); if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved); } catch (e) {}
  document.getElementById('theme').addEventListener('click', function () {
    var dark = root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var next = dark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  });

  // copy buttons
  Array.prototype.forEach.call(document.querySelectorAll('.code .copy'), function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.parentNode.querySelector('code').textContent;
      var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1400); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done); else done();
    });
  });

  // search
  var q = document.getElementById('q'), results = document.getElementById('results');
  var active = -1, hits = [];
  function escapeHtml(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function snippet(text, tokens) {
    var low = text.toLowerCase(), at = -1;
    for (var i = 0; i < tokens.length && at < 0; i++) at = low.indexOf(tokens[i]);
    var start = Math.max(0, at - 50), s = text.slice(start, start + 150);
    var html = escapeHtml(s);
    tokens.forEach(function (t) { if (t.length > 1) html = html.replace(new RegExp('(' + t.replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\\\$&') + ')', 'ig'), '<mark>$1</mark>'); });
    return (start > 0 ? '…' : '') + html;
  }
  function search() {
    var raw = q.value.trim().toLowerCase();
    var tokens = raw.split(/\\s+/).filter(Boolean);
    if (!tokens.length) { results.hidden = true; results.innerHTML = ''; hits = []; return; }
    hits = [];
    index.forEach(function (e) {
      var title = e.p.toLowerCase(), head = e.h.toLowerCase(), text = e.t.toLowerCase();
      var score = 0;
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (title.indexOf(t) >= 0) score += 5; else if (head.indexOf(t) >= 0) score += 3; else if (text.indexOf(t) >= 0) score += 1; else { score = 0; break; }
      }
      if (score) hits.push({ e: e, score: score });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    hits = hits.slice(0, 8);
    active = -1;
    if (!hits.length) { results.innerHTML = '<div class="empty">No results for “' + escapeHtml(q.value.trim()) + '”</div>'; results.hidden = false; return; }
    results.innerHTML = hits.map(function (h) {
      var e = h.e;
      return '<a href="#' + e.s + (e.id ? '/' + e.id : '') + '"><div class="where"><strong>' + escapeHtml(e.p) + '</strong>' + (e.h ? ' › ' + escapeHtml(e.h) : '') + '</div><div class="snip">' + snippet(e.t, tokens) + '</div></a>';
    }).join('');
    results.hidden = false;
  }
  function close() { results.hidden = true; }
  q.addEventListener('input', search);
  q.addEventListener('focus', function () { if (q.value.trim()) search(); });
  q.addEventListener('keydown', function (e) {
    var links = results.querySelectorAll('a');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!links.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
      Array.prototype.forEach.call(links, function (a, i) { a.classList.toggle('active', i === active); });
      links[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      var pick = links[active >= 0 ? active : 0];
      if (pick) { location.hash = pick.getAttribute('href'); close(); q.blur(); }
    } else if (e.key === 'Escape') { close(); q.blur(); }
  });
  results.addEventListener('click', function () { close(); });
  document.addEventListener('click', function (e) { if (!e.target.closest('.search')) close(); });
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); q.focus(); q.select(); }
    else if (e.key === '/' && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
  });
})();
`;

// ---------------------------------------------------------------- site
export function buildDocs({ docsDir = DOCS_DIR, outFile = OUT_FILE, log = console.log } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const pages = loadPages(docsDir);
  const rendered = pages.map((p) => ({ page: p, ...render(p.body, p) }));
  const searchIndex = [];
  for (const { page, sections } of rendered) {
    for (const s of sections) searchIndex.push({ s: page.slug, p: page.title, h: s.heading, id: s.id, t: s.text.slice(0, 600) });
  }

  const sections = [];
  for (const p of pages) if (!sections.includes(p.section)) sections.push(p.section);
  const sidebar = sections
    .map(
      (sec) =>
        `<div class="group"><p class="group-title">${esc(sec)}</p>${pages
          .filter((p) => p.section === sec)
          .map((p) => `<a href="#${p.slug}" data-slug="${p.slug}">${esc(p.title)}</a>`)
          .join('')}</div>`,
    )
    .join('');

  const articles = rendered
    .map(({ page, html }, i) => {
      const prev = pages[i - 1];
      const next = pages[i + 1];
      const hero = page.hero
        ? `<figure class="tank" aria-hidden="true"><div class="glass"><span class="bubble"></span><span class="bubble"></span><span class="bubble"></span>${FISH}<p class="tagline">${esc(page.tagline).replace(/\s*\|\s*/g, '<br>')}</p></div></figure>`
        : '';
      const pager =
        `<nav class="pager" aria-label="Previous and next">` +
        (prev ? `<a class="prev" href="#${prev.slug}"><span>Previous</span><strong>${esc(prev.title)}</strong></a>` : '') +
        (next ? `<a class="next" href="#${next.slug}"><span>Next</span><strong>${esc(next.title)}</strong></a>` : '') +
        `</nav>`;
      return `<article class="page" data-slug="${page.slug}" hidden><p class="eyebrow">${esc(page.section)}</p><h1>${esc(page.title)}</h1><p class="lede">${esc(page.description)}</p>${hero}<div class="prose">${html}</div>${pager}</article>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deskfish Docs</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&family=Instrument+Serif:ital@0;1&display=swap">
<meta name="description" content="Deskfish documentation: give your AI its own computer and watch it work through the glass.">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FISH.replace('currentColor', '#0b7285').replace(/currentColor/g, '#0b7285'))}">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <button class="menu" id="menu" aria-label="Open navigation">${ICON_MENU}</button>
  <a class="brand" href="#${pages[0].slug}">${FISH}<span>Deskfish</span><span class="docs">Docs</span></a>
  <span class="spacer"></span>
  <div class="search" role="search">
    ${ICON_SEARCH}
    <input id="q" type="search" placeholder="Search the docs…" autocomplete="off" spellcheck="false" aria-label="Search the docs">
    <kbd>Ctrl K</kbd>
    <div class="results" id="results" hidden></div>
  </div>
  <span class="version">v${esc(version)}</span>
  <button class="theme" id="theme" aria-label="Switch light and dark theme"><span class="sun">${ICON_SUN}</span><span class="moon">${ICON_MOON}</span></button>
</header>
<div class="shell">
  <nav class="sidebar" id="sidebar" aria-label="Documentation">${sidebar}</nav>
  <main id="main">${articles}<p class="foot">Deskfish ${esc(version)} · Give your AI its own computer. Watch it work through the glass.</p></main>
  <aside class="toc" id="toc"><p class="toc-title">On this page</p><ul id="tocList"></ul></aside>
</div>
<script>window.__PAGES__=${JSON.stringify(pages.map((p) => ({ slug: p.slug, title: p.title })))};window.__INDEX__=${JSON.stringify(searchIndex).replace(/</g, '\\u003c')};</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html);
  log(`docs: ${pages.length} pages → ${path.relative(ROOT, outFile)} (${Math.round(html.length / 1024)} KB)`);
  return { pages, outFile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildDocs();
