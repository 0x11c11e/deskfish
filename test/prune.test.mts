// Screenshot pruning in batches: images build up to maxImages + 5 and then drop back to maxImages,
// so the cached prefix is rewritten at most once every five requests instead of on every step.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicAdapter } from '../src/agent/adapters/anthropic';
import type { Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

// ---------- fake Anthropic API: every turn clicks, the 14th ends ----------
const TURNS = 14;
const bodies: any[] = [];
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    bodies.push(JSON.parse(data));
    const i = bodies.length - 1;
    const last = i === TURNS - 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `msg_${i}`, type: 'message', role: 'assistant', model: 'm', stop_sequence: null,
      content: last
        ? [{ type: 'text', text: 'done' }]
        : [{ type: 'text', text: `step ${i}` }, { type: 'tool_use', id: `tu_${i}`, name: 'computer', input: { action: 'left_click', coordinate: [10 + i, 20] } }],
      stop_reason: last ? 'end_turn' : 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
    }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

// A different JPEG per turn so a screenshot can never be mistaken for another.
const obs = (i: number, results: Observation['results']): Observation => ({ image: { jpeg: Buffer.from(`ffd8${i.toString(16).padStart(4, '0')}ffd9`, 'hex'), width: 640, height: 400 }, results });

// ---------- helpers ----------
const countImages = (blocks: any[]): number => blocks.reduce((s, b) => s + (b.type === 'image' ? 1 : b.type === 'tool_result' && Array.isArray(b.content) ? countImages(b.content) : 0), 0);
const imagesIn = (body: any) => body.messages.reduce((s: number, m: any) => s + (m.role === 'user' && Array.isArray(m.content) ? countImages(m.content) : 0), 0);
const stripMarks = (v: any): any => {
  if (Array.isArray(v)) return v.map(stripMarks);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'cache_control').map(([k, x]) => [k, stripMarks(x)]));
  return v;
};
const omitted = (body: any) => JSON.stringify(body.messages).split('[earlier screenshot omitted]').length - 1;

try {
  const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'claude-test', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'dummy', refusalFallback: false });
  adapter.start('prune me', { width: 640, height: 400 });
  let turn = await adapter.step(obs(0, []));
  for (let i = 1; i < TURNS; i++) turn = await adapter.step(obs(i, turn.actions.map(() => ({ ok: true }))));
  assert.equal(bodies.length, TURNS, `${TURNS} requests`);
  assert.equal(turn.done, true, 'the last turn ended the task');

  // 3 ≤ images ≤ 8 in every request (the first two requests cannot have three yet: one screenshot per turn).
  for (let i = 0; i < TURNS; i++) {
    const imgs = imagesIn(bodies[i]);
    ok(imgs >= Math.min(3, i + 1) && imgs <= 8, `request ${i}: ${imgs} images (expected ${Math.min(3, i + 1)}…8)`);
  }

  // The prefix is byte-identical to the previous request except at batch prunes, at most one per five requests.
  const prunes: number[] = [];
  for (let i = 1; i < TURNS; i++) {
    const prev = stripMarks(bodies[i - 1].messages);
    const cur = stripMarks(bodies[i].messages).slice(0, prev.length);
    if (JSON.stringify(cur) !== JSON.stringify(prev)) prunes.push(i);
  }
  const spaced = prunes.every((p, k) => k === 0 || p - prunes[k - 1] >= 5);
  const dropped = prunes.every((p) => imagesIn(bodies[p]) === 3 && imagesIn(bodies[p - 1]) === 8 && omitted(bodies[p]) === imagesIn(bodies[p - 1]) + 1 - 3);
  ok(prunes.length >= 1 && prunes.length <= Math.ceil(TURNS / 5) && spaced && dropped, `prefix rewritten only at batch prunes (at requests ${prunes.join(', ')}; images per request ${bodies.map(imagesIn).join(' ')})`);
} finally {
  server.close();
}

console.log(`prune: ${n} checks passed`);
