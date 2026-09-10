// Small Markdown renderer adapted from the project’s own documentation renderer.
// Local documentation only; raw HTML is escaped. No filesystem writes.
// ---------------------------------------------------------------- markdown → html
const esc = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const stripTags = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

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

function link(text, href) {
  if (/^(https?:|mailto:)/.test(href))
    return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  if (href.startsWith('/')) return `<a href="${href}">${text}</a>`;
  const [slug, anchor] = href.split('#');
  const target = slug
    ? `/docs/${slug}/${anchor ? '#' + anchor : ''}`
    : `#${anchor}`;
  return `<a href="${target}">${text}</a>`;
}

function imageTag(alt, file) {
  return `<img src="/assets/${esc(file)}" alt="${esc(alt)}" loading="lazy">`;
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
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, file) =>
    imageTag(alt, file),
  );
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) =>
    link(text, href, page),
  );
  // oxlint-disable-next-line no-control-regex -- Private sentinels preserve inline code while formatting Markdown.
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[Number(i)]);
  return t;
}

const isFence = (l) => l.startsWith('```');
const isHeading = (l) => /^#{1,4}\s/.test(l);
const isHr = (l) => /^-{3,}\s*$/.test(l);
const isQuote = (l) => l.startsWith('>');
const isList = (l) => /^\s*(?:[-*]|\d+\.)\s+/.test(l);
const isTable = (lines, i) =>
  lines[i].startsWith('|') &&
  i + 1 < lines.length &&
  /^\|?\s*:?-{2,}/.test(lines[i + 1]);
const startsBlock = (lines, i) =>
  isFence(lines[i]) ||
  isHeading(lines[i]) ||
  isHr(lines[i]) ||
  isQuote(lines[i]) ||
  isList(lines[i]) ||
  isTable(lines, i);

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
    if (m)
      items.push({
        level: m[1].length >= 2 ? 1 : 0,
        ordered: /\d/.test(m[2]),
        text: m[3],
      });
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
  const addText = (html) =>
    (ctx.sections[ctx.sections.length - 1].text += ' ' + stripTags(html));
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
        `<figure class="code"${lang && lang !== 'text' ? ` data-lang="${esc(lang)}"` : ''}><pre><code>${code}</code></pre><button class="copy" type="button" aria-label="Copy code block">Copy</button></figure>`,
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
      out.push(
        `<h${level} id="${id}">${inline(text, ctx.page)}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`,
      );
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
      while (i < lines.length && lines[i].startsWith('|'))
        rows.push(splitRow(lines[i++]));
      let t =
        '<div class="table"><table><thead><tr>' +
        header.map((c) => `<th>${inline(c, ctx.page)}</th>`).join('') +
        '</tr></thead><tbody>';
      for (const r of rows)
        t +=
          '<tr>' +
          r.map((c) => `<td>${inline(c, ctx.page)}</td>`).join('') +
          '</tr>';
      t += '</tbody></table></div>';
      out.push(t);
      addText(t);
      continue;
    }
    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i]))
        buf.push(lines[i++].replace(/^>\s?/, ''));
      let kind = 'note';
      const k = buf[0] && buf[0].match(/^\[!(\w+)\]\s*$/);
      if (k) {
        kind = k[1].toLowerCase();
        buf.shift();
      }
      const label =
        { note: 'Note', tip: 'Tip', warning: 'Warning' }[kind] ?? kind;
      out.push(
        `<aside class="callout ${kind}"><p class="callout-label">${label}</p>${blocks(buf, ctx)}</aside>`,
      );
      continue;
    }
    if (isList(line)) {
      const buf = [];
      while (
        i < lines.length &&
        (isList(lines[i]) || /^\s{2,}\S/.test(lines[i]))
      )
        buf.push(lines[i++]);
      const html = list(buf, ctx);
      out.push(html);
      addText(html);
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i))
      buf.push(lines[i++]);
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
  const ctx = {
    page,
    headings: [],
    sections: [{ heading: '', id: '', text: '' }],
  };
  const html = blocks(md.split(/\r?\n/), ctx);
  return {
    html,
    headings: ctx.headings,
    sections: ctx.sections.filter((s) => s.text.trim()),
  };
}

export { render };
