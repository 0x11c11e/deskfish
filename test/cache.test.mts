// Prompt caching on the Anthropic wire: one moving breakpoint on the newest user message, the
// system prompt cached, older breakpoints stripped, usage mapped from the cache counters, and
// server-side compaction requested on every call (context_management + its beta header).
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
const reply = (content: unknown[], stop_reason: string, usage: Record<string, number>) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 10, ...usage },
});
const script = [
  reply([{ type: 'text', text: 'clicking' }, { type: 'tool_use', id: 'tu_1', name: 'computer', input: { action: 'left_click', coordinate: [10, 20] } }], 'tool_use', { cache_read_input_tokens: 0, cache_creation_input_tokens: 900 }),
  reply([{ type: 'text', text: 'done' }], 'end_turn', { cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }),
];
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    requests.push({ headers: req.headers, body: JSON.parse(data) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(script[requests.length - 1] ?? script[script.length - 1]));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

const jpeg = Buffer.from('ffd8ffd9', 'hex');
const obs = (results: Observation['results'] = []): Observation => ({ image: { jpeg, width: 640, height: 400 }, results });

// ---------- helpers over a recorded body ----------
const marks = (blocks: any[]) => blocks.filter((b) => b && b.cache_control).length;
const userMessages = (body: any) => body.messages.filter((m: any) => m.role === 'user');
const totalMarks = (body: any) => marks(body.system) + body.messages.reduce((s: number, m: any) => s + (Array.isArray(m.content) ? marks(m.content) : 0), 0);
const newestUserHasOneMarkOnLastBlock = (body: any) => {
  const users = userMessages(body);
  const last = users[users.length - 1].content;
  return marks(last) === 1 && last[last.length - 1].cache_control?.type === 'ephemeral';
};

try {
  const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'claude-test', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'dummy', refusalFallback: false });
  adapter.start('cache me', { width: 640, height: 400 });
  const t0 = await adapter.step(obs());
  const t1 = await adapter.step(obs([{ ok: true }]));
  assert.equal(requests.length, 2, 'two requests');
  assert.equal(t0.actions[0]?.type, 'click', 'turn 0 parsed the click');
  assert.equal(t1.done, true, 'turn 1 ended');

  ok(newestUserHasOneMarkOnLastBlock(requests[0].body), 'request 0: one breakpoint, on the last block of the newest user message');
  ok(newestUserHasOneMarkOnLastBlock(requests[1].body), 'request 1: the breakpoint moved to the new user message');
  ok(marks(userMessages(requests[1].body)[0].content) === 0, 'request 1: the older user message lost its breakpoint');
  ok(requests.every((r) => totalMarks(r.body) <= 4), `never more than 4 breakpoints (${requests.map((r) => totalMarks(r.body))})`);
  ok(requests.every((r) => r.body.system?.[0]?.cache_control?.type === 'ephemeral'), 'the system prompt stays cached on every request');
  ok(t0.usage?.input === 100 && t0.usage.output === 10 && t0.usage.cacheRead === 0 && t0.usage.cacheWrite === 900, `turn 0 usage from cache_creation_input_tokens: ${JSON.stringify(t0.usage)}`);
  ok(t1.usage?.cacheRead === 1000 && t1.usage.cacheWrite === 50, `turn 1 usage from cache_read_input_tokens: ${JSON.stringify(t1.usage)}`);
  ok(requests.every((r) => r.body.context_management?.edits?.[0]?.type === 'compact_20260112'), 'every request asks for server-side compaction');
  ok(requests.every((r) => String(r.headers['anthropic-beta']).includes('compact-2026-01-12')), `anthropic-beta carries the compaction beta: ${requests[0].headers['anthropic-beta']}`);
} finally {
  server.close();
}

console.log(`cache: ${n} checks passed`);
