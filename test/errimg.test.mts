// Failed tool results on the Anthropic wire: the API rejects an `is_error` tool_result that carries
// anything but text, so the screenshot (and a failed zoom's magnified view) follow the results as
// plain user content in the same message. Batches whose LAST tool fails: remember, zoom, a parse error.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicAdapter } from '../src/agent/adapters/anthropic';
import type { Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

// ---------- fake Anthropic API ----------
const bodies: any[] = [];
const tool = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const click = (id: string) => tool(id, 'computer', { action: 'left_click', coordinate: [10, 20] });
const reply = (content: unknown[], stop_reason = 'tool_use') => ({ id: 'msg', type: 'message', role: 'assistant', model: 'm', content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
const script = [
  reply([click('tu_1'), tool('tu_2', 'remember', { text: 'x'.repeat(700) })]),
  reply([click('tu_3'), tool('tu_4', 'zoom', { coordinate: [5000, 5000] })]),
  reply([click('tu_5'), tool('tu_6', 'computer', { action: 'fly', coordinate: [1, 1] })]),
  reply([{ type: 'text', text: 'done' }], 'end_turn'),
];
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    bodies.push(JSON.parse(data));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(script[bodies.length - 1] ?? script[script.length - 1]));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

const jpeg = Buffer.from('ffd8ffd9', 'hex');
const zoomJpeg = Buffer.from('ffd8ffe0ffd9', 'hex');
const obs = (results: Observation['results']): Observation => ({ image: { jpeg, width: 640, height: 400 }, results });

// ---------- helpers ----------
const newestUser = (body: any): any[] => { const u = body.messages.filter((m: any) => m.role === 'user'); return u[u.length - 1].content; };
const textOnly = (r: any) => typeof r.content === 'string' || (Array.isArray(r.content) && r.content.every((b: any) => b.type === 'text'));
const errorResults = (blocks: any[]) => blocks.filter((b) => b.type === 'tool_result' && b.is_error);
const lastResultIndex = (blocks: any[]) => blocks.map((b) => b.type).lastIndexOf('tool_result');
const imageIndexes = (blocks: any[]) => blocks.map((b, i) => (b.type === 'image' ? i : -1)).filter((i) => i >= 0);
const imageData = (blocks: any[]) => blocks.filter((b) => b.type === 'image').map((b) => b.source.data);

try {
  const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'claude-test', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'dummy', refusalFallback: false, notes: () => ({ memory: '' }) });
  adapter.start('fail well', { width: 640, height: 400 });

  // Batch 1: click ok, remember (700 chars, over the 600 cap) fails.
  const t0 = await adapter.step(obs([]));
  ok(t0.actions.length === 2 && t0.actions[0].type === 'click' && t0.actions[1].type === 'remember' && (t0.actions[1] as { text: string }).text.length === 700, 'batch 1 parsed: click + a 700-char remember');
  const t1 = await adapter.step(obs([{ ok: true }, { ok: false, error: 'memory is full' }]));
  const m1 = newestUser(bodies[1]);
  ok(errorResults(m1).length === 1 && errorResults(m1).every(textOnly), 'batch 1: the failed remember is an is_error tool_result carrying only text');
  ok(errorResults(m1)[0].tool_use_id === 'tu_2' && String(errorResults(m1)[0].content).includes('memory is full'), 'batch 1: the error text names the failure');
  ok(m1.find((b: any) => b.tool_use_id === 'tu_1')?.is_error === undefined, 'batch 1: the successful click stays a normal tool_result');
  ok(imageIndexes(m1).length === 1 && imageIndexes(m1)[0] > lastResultIndex(m1), 'batch 1: the screenshot follows the failed result in the same user message');

  // Batch 2: click ok, zoom off-screen fails but brings its magnified view.
  ok(t1.actions.length === 2 && t1.actions[0].type === 'click' && t1.actions[1].type === 'zoom', 'batch 2 parsed: click + zoom');
  const t2 = await adapter.step(obs([{ ok: true }, { ok: false, error: 'off-screen', image: { jpeg: zoomJpeg, width: 200, height: 200 } }]));
  const m2 = newestUser(bodies[2]);
  ok(errorResults(m2).length === 1 && errorResults(m2).every(textOnly) && errorResults(m2)[0].tool_use_id === 'tu_4', 'batch 2: the failed zoom is a text-only is_error result');
  ok(imageData(m2).includes(zoomJpeg.toString('base64')), 'batch 2: the failed zoom keeps its magnified view');
  ok(imageData(m2).includes(jpeg.toString('base64')) && imageIndexes(m2).length === 2 && imageIndexes(m2).every((i) => i > lastResultIndex(m2)), 'batch 2: view and screenshot both follow the results');

  // Batch 3: click ok, a computer call with an unknown action → parse error (placeholder screenshot action).
  ok(t2.actions.length === 2 && t2.actions[0].type === 'click' && t2.actions[1].type === 'screenshot', 'batch 3: the unparseable call became a placeholder screenshot action');
  const t3 = await adapter.step(obs([{ ok: true }, { ok: true }]));
  const m3 = newestUser(bodies[3]);
  const parseErr = errorResults(m3).find((b) => b.tool_use_id === 'tu_6');
  ok(parseErr && textOnly(parseErr) && /unknown action "fly"/.test(String(parseErr.content)), `batch 3: the parse-error result is present and text-only (${JSON.stringify(parseErr?.content).slice(0, 80)})`);
  ok(imageIndexes(m3).length === 1 && imageIndexes(m3)[0] > lastResultIndex(m3), 'batch 3: the screenshot still follows the parse-error result');
  ok(t3.done && bodies.every((b) => b.messages.filter((m: any) => m.role === 'user').every((m: any) => errorResults(m.content).every(textOnly))), 'every is_error tool_result in every request is text-only, and the task ended');
} finally {
  server.close();
}

console.log(`errimg: ${n} checks passed`);
