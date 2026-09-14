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
  reply([{ type: 'text', text: 'clicking' }, { type: 'tool_use', id: 'tu_1', name: 'computer', input: { action: 'left_click', coordinate: [10, 20] } }], 'tool_use', { cache_read_input_tokens: 0, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 800, ephemeral_5m_input_tokens: 100 } as unknown as number }),
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
  const notes = { memory: '- [2026-09-14] the first fact', playbooks: '- Logging in (2026-09-10)', charter: 'Be honest.', self: '# Who I am\n\nDeskfish.', selfStatus: 'ok' as const, journal: '- [2026-09-14 10:00] done · 3 steps — Task: one' };
  const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'claude-test', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'dummy', refusalFallback: false, notes: () => ({ ...notes }) });
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
  ok(t0.usage?.cacheWrite1h === 800, `the 1-hour share of the cache write is reported: ${t0.usage?.cacheWrite1h}`);
  ok(requests.every((r) => r.body.system[0].cache_control.ttl === '1h'), 'the system prompt is cached for an hour by default');
  ok(requests.every((r) => { const u = userMessages(r.body); const last = u[u.length - 1].content; return last[last.length - 1].cache_control.ttl === '1h'; }), 'the moving breakpoint is cached for an hour too');
  ok(!('output_config' in requests[0].body), 'no effort is sent unless configured');

  // A follow-up task in the same conversation: the notes changed (a task was journaled, a fact was added by hand),
  // but the system prompt must stay byte-identical — it is the cached prefix — and the change rides as a delta.
  notes.memory = '- [2026-09-14] the first fact\n- [2026-09-14] added by hand while she worked';
  notes.journal = '- [2026-09-14 10:00] done · 3 steps — Task: one\n- [2026-09-14 10:05] done · 2 steps — Task: two';
  adapter.addUserMessage('and now the follow-up');
  const delta = adapter.notesDelta();
  ok(delta === 'Facts added to your memory since this conversation began (by you, or by hand):\n- [2026-09-14] added by hand while she worked', `the delta names the new fact and nothing else: ${JSON.stringify(delta)}`);
  ok(adapter.notesDelta() === undefined, 'a second look finds nothing new');
  await adapter.step(obs([{ ok: true }]));
  ok(requests.length === 3 && requests[2].body.system[0].text === requests[1].body.system[0].text, 'the follow-up request carries the same system prompt as before (the cached prefix survives)');
  ok(!requests[2].body.system[0].text.includes('added by hand'), 'the new fact is not in the system prompt');

  // Tampered self: the delta carries the notice and the page as it reads now.
  notes.selfStatus = 'tampered' as unknown as 'ok';
  notes.self = '# Who I am\n\nSomeone rewrote me.';
  const tampered = adapter.notesDelta() ?? '';
  ok(tampered.startsWith('Notice: your self file no longer carries your signature') && tampered.includes('Someone rewrote me.') && tampered.includes('restore_self'), 'an outside edit to the self file is reported in the delta');

  // Effort and the 5-minute TTL when configured.
  const tuned = new AnthropicAdapter({ provider: 'anthropic', model: 'claude-test', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'dummy', refusalFallback: false, effort: 'medium', cacheTtl: '5m' });
  tuned.start('tune me', { width: 640, height: 400 });
  await tuned.step(obs());
  const tunedBody = requests[requests.length - 1].body;
  ok(tunedBody.output_config?.effort === 'medium', 'effort goes out in output_config when configured');
  ok(tunedBody.system[0].cache_control.type === 'ephemeral' && !('ttl' in tunedBody.system[0].cache_control), 'cacheTtl 5m sends the plain ephemeral mark');
} finally {
  server.close();
}

console.log(`cache: ${n} checks passed`);
