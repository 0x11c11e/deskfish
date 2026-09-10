// The `fallbacks` retry: a model that rejects the refusal-fallback parameter (Sonnet 5) answers
// 400 "does not support the 'fallbacks' parameter"; the adapter re-sends the same request without
// the parameter and its beta header, remembers for the conversation, and a plain 400 is surfaced.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicAdapter } from '../src/agent/adapters/anthropic';
import type { Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

// ---------- fake Anthropic API ----------
type Recorded = { headers: http.IncomingHttpHeaders; body: any };
const requests: Recorded[] = [];
let plain400: string | undefined; // when set, every request fails with this message
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const body = JSON.parse(data);
    requests.push({ headers: req.headers, body });
    const rejectWith = plain400 ?? (body.fallbacks !== undefined ? `${body.model} does not support the 'fallbacks' parameter` : undefined);
    if (rejectWith) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: rejectWith } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: body.model, stop_sequence: null, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: `tu_${requests.length}`, name: 'computer', input: { action: 'left_click', coordinate: [1, 1] } }] }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

const jpeg = Buffer.from('ffd8ffd9', 'hex');
const obs = (results: Observation['results'] = []): Observation => ({ image: { jpeg, width: 640, height: 400 }, results });
const hasFallback = (r: Recorded) => r.body.fallbacks !== undefined || String(r.headers['anthropic-beta']).includes('server-side-fallback');
const stripMarks = (v: any): any => (Array.isArray(v) ? v.map(stripMarks) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'cache_control').map(([k, x]) => [k, stripMarks(x)])) : v);

try {
  const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'dummy' });
  adapter.start('retry without fallbacks', { width: 640, height: 400 });
  const t0 = await adapter.step(obs());
  ok(
    requests.length === 2 && hasFallback(requests[0]) && requests[0].body.fallbacks === 'default' && !hasFallback(requests[1]) && !String(requests[1].headers['anthropic-beta']).includes('server-side-fallback'),
    `the 400 mentioning fallbacks is retried without the parameter and its beta (${requests.map((r) => r.headers['anthropic-beta']).join(' | ')})`,
  );
  ok(
    JSON.stringify(stripMarks(requests[1].body.messages)) === JSON.stringify(stripMarks(requests[0].body.messages)) && requests[1].body.model === requests[0].body.model && requests[1].body.context_management?.edits?.[0]?.type === 'compact_20260112' && t0.actions[0]?.type === 'click',
    'the retry is the same request (messages, model, compaction) and the step succeeds',
  );
  await adapter.step(obs([{ ok: true }]));
  ok(requests.length === 3 && !hasFallback(requests[2]), 'the conversation remembers: the next request goes out once, without fallbacks');

  // A plain 400 (nothing about fallbacks) is not retried and is surfaced with the server's words.
  plain400 = 'messages: roles must alternate between "user" and "assistant"';
  const before = requests.length;
  const err = await adapter.step(obs([{ ok: true }])).then(() => undefined, (e: unknown) => e as Error);
  ok(err instanceof Error && /roles must alternate/.test(err.message) && requests.length === before + 1, `a plain 400 surfaces as an error with the server's message, sent once: ${err?.message}`);
} finally {
  server.close();
}

console.log(`fallback: ${n} checks passed`);
