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
    case 'page_read': {
      // A canned page, so the loop's find/read_page path can be exercised without Firefox.
      log(action === 'page_find' ? JSON.stringify(body.query) : body.scope ?? 'interactive');
      const elements = [
        { role: 'heading', name: 'Example Domain', state: '', x: 640, y: 200, w: 400, h: 40, visible: true },
        { role: 'link', name: 'More information...', state: '', x: 640, y: 320, w: 160, h: 20, visible: true },
        { role: 'textbox', name: 'Email', state: 'empty', x: 640, y: 420, w: 300, h: 32, visible: true },
        { role: 'button', name: 'Sign in', state: '', x: 640, y: 480, w: 120, h: 36, visible: true },
        { role: 'link', name: 'Privacy policy', state: '', x: 640, y: 1400, w: 100, h: 20, visible: false, below: 600 },
      ];
      const q = String(body.query ?? '').toLowerCase();
      const page = { url: 'https://example.com/', title: 'Example Domain', viewport: { x: 0, y: 80, width: 1280, height: 720, scrollY: 0, pageHeight: 1500 } };
      if (action === 'page_read') {
        if (body.scope === 'text') return { success: true, data: { ...page, elements: [], text: 'Example Domain\nThis domain is for use in illustrative examples in documents.' } };
        return { success: true, data: { ...page, elements: elements.filter((e) => e.visible), total: elements.length, more: { visible: 0, below: 1, above: 0 } } };
      }
      const hits = elements.filter((e) => e.name.toLowerCase().includes(q) || e.role === q).map((e, i) => ({ ...e, score: 100 - i }));
      return { success: true, data: { ...page, elements: hits, total: elements.length } };
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
