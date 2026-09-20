#!/usr/bin/env node
// A fake desktop daemon for development: speaks the same POST /computer-use/computer protocol and renders
// a synthetic 1920x1080 "desktop" that reacts to clicks and typing, so the agent loop, the daemon
// client and the VS Code UI can be exercised without Docker or an API key.
//
//   MOCK_PORT=9990 node scripts/mock-daemon.mjs
import http from 'node:http';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const PORT = Number(process.env.MOCK_PORT || 9990);
const W = 1920;
const H = 1080;

const state = {
  cursor: { x: W / 2, y: H / 2 },
  windowOpen: false,
  typed: '',
  scroll: 0,
  actions: 0,
  /** The canned page's own state: which element scroll_to brought into view, which option the dropdown holds. */
  scrolledTo: '',
  selected: 0,
};

const ICON = { x: 40, y: 280, w: 72, h: 72 };

function fill(png, x0, y0, w, h, [r, g, b]) {
  const x1 = Math.min(W, x0 + w);
  const y1 = Math.min(H, y0 + h);
  for (let y = Math.max(0, y0); y < y1; y++) {
    let i = (y * W + Math.max(0, x0)) * 4;
    for (let x = Math.max(0, x0); x < x1; x++) {
      png.data[i++] = r;
      png.data[i++] = g;
      png.data[i++] = b;
      png.data[i++] = 255;
    }
  }
}

function render() {
  const png = new PNG({ width: W, height: H });
  fill(png, 0, 0, W, H, [34, 40, 60]); // wallpaper
  fill(png, 0, H - 48, W, 48, [24, 24, 24]); // taskbar
  fill(png, ICON.x, ICON.y, ICON.w, ICON.h, [240, 130, 40]); // "browser" desktop icon
  if (state.windowOpen) {
    fill(png, 200, 80 - state.scroll * 0, 1520, 920, [245, 245, 245]); // window
    fill(png, 200, 80, 1520, 40, [70, 70, 70]); // title bar
    fill(png, 240, 140, 1440, 40, [225, 225, 225]); // address bar
    // typed text as a bar whose length tracks the text
    const lines = state.typed.split('\n');
    fill(png, 250, 150, Math.min(1420, lines[0].length * 14), 20, [40, 40, 40]);
    // page content moves with scroll
    for (let i = 0; i < 12; i++) {
      const y = 240 + i * 60 - state.scroll * 40;
      if (y > 200 && y < 980) fill(png, 260, y, 900 + (i % 3) * 150, 24, [200, 200, 210]);
    }
    if (lines.length > 1) fill(png, 260, 220, 1400, 4, [60, 120, 240]); // "navigated" indicator
  }
  // cursor crosshair
  const { x, y } = state.cursor;
  fill(png, Math.round(x) - 12, Math.round(y) - 1, 24, 3, [255, 40, 40]);
  fill(png, Math.round(x) - 1, Math.round(y) - 12, 3, 24, [255, 40, 40]);
  return PNG.sync.write(png);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(body) {
  state.actions++;
  const { action } = body;
  const log = (extra = '') => console.log(`#${state.actions} ${action} ${extra}`.trim());
  switch (action) {
    case 'screenshot':
      log();
      return { success: true, data: { image: render().toString('base64') } };
    case 'cursor_position':
      log();
      return { success: true, data: { x: state.cursor.x, y: state.cursor.y } };
    case 'move_mouse':
      state.cursor = { ...body.coordinates };
      log(`→ (${state.cursor.x}, ${state.cursor.y})`);
      return { success: true };
    case 'click_mouse': {
      if (body.coordinates) state.cursor = { ...body.coordinates };
      const { x, y } = state.cursor;
      const onIcon = x >= ICON.x && x <= ICON.x + ICON.w && y >= ICON.y && y <= ICON.y + ICON.h;
      if (onIcon && (body.clickCount ?? 1) >= 2) state.windowOpen = true;
      log(`${body.button} ×${body.clickCount ?? 1} at (${x}, ${y})${onIcon ? ' [browser icon]' : ''}`);
      return { success: true };
    }
    case 'drag_mouse':
      state.cursor = { ...body.path[body.path.length - 1] };
      log(`${JSON.stringify(body.path)}`);
      return { success: true };
    case 'type_text':
      state.typed += String(body.text ?? '');
      log(JSON.stringify(body.text));
      return { success: true };
    case 'paste_text':
      state.typed += String(body.text ?? '');
      log(JSON.stringify(body.text));
      return { success: true };
    case 'press_keys':
    case 'type_keys': {
      const keys = (body.keys ?? []).map((k) => String(k).toLowerCase());
      if (body.press !== 'up' && keys.includes('enter')) state.typed += '\n';
      if (body.press !== 'up' && keys.includes('ctrl') && keys.includes('l')) state.typed = '';
      log(`${keys.join('+')} ${body.press ?? ''}`);
      return { success: true };
    }
    case 'scroll':
      state.scroll += (body.direction === 'down' ? 1 : body.direction === 'up' ? -1 : 0) * (body.scrollCount ?? 1);
      log(`${body.direction} ×${body.scrollCount}`);
      return { success: true };
    case 'wait':
      log(`${body.duration}ms`);
      await sleep(Math.min(5000, Number(body.duration) || 0));
      return { success: true };
    case 'application':
      state.windowOpen = true;
      log(body.application);
      return { success: true };
    case 'release_input':
      log();
      return { success: true, data: { released: [], blind: false } };
    case 'input_state':
      return { success: true, data: { keys: [], buttons: [] } };
    case 'page_find':
    case 'page_read':
    case 'page_scroll_to':
    case 'page_select': {
      // A canned page, so the loop's page-bridge paths can be exercised without Firefox. scroll_to
      // brings the off-screen "Privacy policy" link into the viewport; select sets the one dropdown.
      log(action === 'page_read' ? body.scope ?? 'interactive' : action === 'page_select' ? `${JSON.stringify(body.query)} → ${JSON.stringify(body.option)}` : JSON.stringify(body.query));
      const OPTIONS = ['Open this select menu', 'One', 'Two', 'Three'];
      const elements = [
        { role: 'heading', name: 'Example Domain', state: '', x: 640, y: 200, w: 400, h: 40, visible: true },
        { role: 'link', name: 'More information...', state: '', x: 640, y: 320, w: 160, h: 20, visible: true },
        { role: 'textbox', name: 'Email', state: 'empty', x: 640, y: 420, w: 300, h: 32, visible: true },
        { role: 'button', name: 'Sign in', state: '', x: 640, y: 480, w: 120, h: 36, visible: true },
        { role: 'combobox', name: 'Dropdown (select)', state: `selected: ${JSON.stringify(OPTIONS[state.selected])}`, x: 640, y: 560, w: 200, h: 32, visible: true },
        state.scrolledTo === 'Privacy policy'
          ? { role: 'link', name: 'Privacy policy', state: '', x: 640, y: 440, w: 100, h: 20, visible: true }
          : { role: 'link', name: 'Privacy policy', state: '', x: 640, y: 1400, w: 100, h: 20, visible: false, below: 600 },
        { role: 'button', name: 'Close dialog', state: '', x: 900, y: 300, w: 60, h: 24, visible: false, covered: true },
      ];
      const q = String(body.query ?? '').toLowerCase();
      const scrollY = state.scrolledTo ? 760 : 0;
      const page = { url: 'https://example.com/', title: 'Example Domain', viewport: { x: 0, y: 80, width: 1280, height: 720, scrollY, pageHeight: 1500 } };
      if (action === 'page_read') {
        if (body.scope === 'text') return { success: true, data: { ...page, elements: [], text: 'Example Domain\nThis domain is for use in illustrative examples in documents.' } };
        return { success: true, data: { ...page, elements: elements.filter((e) => e.visible), total: elements.length, more: { visible: 0, below: state.scrolledTo ? 0 : 1, above: 0 } } };
      }
      // A query that only names a role matches nothing by its words: that is what a weak hit is, and
      // it is how a test drives click_element's "clicked nothing, here is why" answer.
      const hits = elements
        .filter((e) => e.name.toLowerCase().includes(q) || e.role === q)
        .map((e, i) => ({ ...e, score: e.name.toLowerCase().includes(q) ? 100 - i : 10 }));
      if (action === 'page_find') return { success: true, data: { ...page, elements: hits, total: elements.length } };
      const best = hits[0];
      if (action === 'page_scroll_to') {
        if (!best || best.score < 30) return { success: true, data: { ...page, elements: hits, total: elements.length, scrolled: false } };
        state.scrolledTo = best.name;
        const moved = best.name === 'Privacy policy' ? { ...best, x: 640, y: 440, visible: true, below: 0 } : best;
        return { success: true, data: { ...page, viewport: { ...page.viewport, scrollY: 760 }, elements: [moved], total: elements.length, scrolled: true } };
      }
      const combo = hits.find((e) => e.score >= 30 && e.role === 'combobox');
      if (!combo) return { success: true, data: { ...page, elements: hits, total: elements.length, selected: false, reason: 'no-select' } };
      const want = String(body.option ?? '').trim().toLowerCase();
      const idx = OPTIONS.findIndex((o) => o.toLowerCase() === want);
      const found = idx >= 0 ? idx : OPTIONS.findIndex((o) => want && o.toLowerCase().startsWith(want));
      const chosen = found >= 0 ? found : OPTIONS.findIndex((o) => want && o.toLowerCase().includes(want));
      if (chosen < 0) return { success: true, data: { ...page, elements: [combo], total: elements.length, selected: false, reason: 'no-option', options: OPTIONS, optionCount: OPTIONS.length } };
      state.selected = chosen;
      return { success: true, data: { ...page, elements: [{ ...combo, state: `selected: ${JSON.stringify(OPTIONS[chosen])}` }], total: elements.length, selected: true } };
    }
    case 'run_command': {
      // A canned terminal, so the loop's run_command path can be exercised without a shell:
      // echoes the command; "fail" in it → exit 127 with stderr; "sleep" in it → timed out.
      const command = String(body.command ?? '');
      log(JSON.stringify(command.slice(0, 60)));
      if (!command.trim()) return { success: false, error: 'run_command needs a command' };
      if (/\bfail\b/.test(command)) return { success: true, data: { stdout: '', stderr: `bash: ${command}: command not found`, exit: 127, timedOut: false, ms: 4 } };
      if (/\bsleep\b/.test(command)) return { success: true, data: { stdout: '', stderr: '', exit: null, timedOut: true, ms: 1000 } };
      return { success: true, data: { stdout: `mock output of: ${command}\n`, stderr: '', exit: 0, timedOut: false, ms: 3 } };
    }
    default:
      log('(unsupported)');
      return { success: false, error: `mock daemon does not implement ${action}` };
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`mock desktop daemon — ${state.actions} actions so far\n`);
    return;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/computer-use')) {
    res.writeHead(404);
    res.end();
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let result;
    try {
      result = await handle(JSON.parse(raw || '{}'));
    } catch (err) {
      result = { success: false, error: String(err) };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock desktop daemon listening on http://127.0.0.1:${PORT} (${W}x${H})`));
