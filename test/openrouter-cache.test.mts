// Prompt caching on the OpenAI-compatible path: `promptCaching` auto/on/off decides whether the
// request copy carries Anthropic-style cache_control marks (system + newest user text), OpenRouter
// alone gets `usage: {include: true}` and its cost/cached tokens map to usage, max_tokens is 8000,
// and an empty length-cut reply is asked once more. The fake endpoint is a local HTTP server; fetch
// is monkeypatched so any host (openrouter.ai, api.x.ai) lands on it.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatAdapter } from '../src/agent/adapters/openaiCompat';
import type { AdapterConfig, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

// ---------- fake chat/completions endpoint ----------
type Recorded = { url: string; body: any };
const requests: Recorded[] = [];
let script: any[] = [];
const click = (id: string) => ({ id, type: 'function', function: { name: 'computer', arguments: JSON.stringify({ action: 'left_click', coordinate: [10, 20] }) } });
const reply = (message: any, finish_reason = 'tool_calls', usage: any = { prompt_tokens: 1000, completion_tokens: 20 }) => ({ id: 'cmpl', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }], usage });
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    requests.push({ url: String(req.headers['x-original-url']), body: JSON.parse(data) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(script.shift() ?? reply({ content: null, tool_calls: [click(`call_${requests.length}`)] })));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init: RequestInit) => realFetch(String(url).replace(/^https?:\/\/[^/]+/, local), { ...init, headers: { ...(init.headers as Record<string, string>), 'x-original-url': String(url) } })) as typeof fetch;

const jpeg = Buffer.from('ffd8ffd9', 'hex');
const obs = (results: Observation['results'] = []): Observation => ({ image: { jpeg, width: 640, height: 400 }, results });
const marksIn = (body: any) => JSON.stringify(body.messages).split('"cache_control"').length - 1;
const systemMarked = (body: any) => Array.isArray(body.messages[0].content) && body.messages[0].role === 'system' && body.messages[0].content[0].cache_control?.type === 'ephemeral';
const userMarks = (body: any) => body.messages.filter((m: any) => m.role === 'user').map((m: any) => (Array.isArray(m.content) ? m.content.filter((p: any) => p.cache_control).length : 0));
const lastTextMarked = (body: any) => { const u = body.messages.filter((m: any) => m.role === 'user'); const parts = u[u.length - 1].content; const texts = parts.filter((p: any) => p.type === 'text'); return texts[texts.length - 1].cache_control?.type === 'ephemeral'; };
const run = async (cfg: Partial<AdapterConfig>, steps = 1) => {
  const first = requests.length;
  const adapter = new OpenAICompatAdapter({ provider: 'openai-compatible', model: 'anthropic/claude-test', apiKey: 'dummy', ...cfg } as AdapterConfig);
  adapter.start('cache me', { width: 640, height: 400 });
  let turn = await adapter.step(obs());
  for (let i = 1; i < steps; i++) turn = await adapter.step(obs(turn.actions.map(() => ({ ok: true }))));
  return { adapter, turn, sent: requests.slice(first) };
};

try {
  // auto + openrouter.ai: marks on the system prompt and the newest user text, usage.include, cost and cached tokens mapped.
  script = [reply({ content: null, tool_calls: [click('c1')] }, 'tool_calls', { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 }, cost: 0.0123 })];
  const or = await run({ baseUrl: 'https://openrouter.ai/api/v1', promptCaching: 'auto' }, 2);
  const [r0, r1] = or.sent;
  ok(r0.url === 'https://openrouter.ai/api/v1/chat/completions' && systemMarked(r0.body), 'auto + openrouter.ai: the system prompt is a marked text part');
  ok(lastTextMarked(r0.body) && marksIn(r0.body) === 2, `auto + openrouter.ai: one mark on the newest user text, two in total (${marksIn(r0.body)})`);
  ok(r0.body.usage?.include === true, 'auto + openrouter.ai: usage.include is requested');
  ok(userMarks(r1.body).join(',') === '0,1' && lastTextMarked(r1.body) && marksIn(r1.body) === 2, `request 2: the breakpoint moved to the newest user message (${userMarks(r1.body)})`);
  ok(!JSON.stringify((or.adapter as any).messages).includes('cache_control'), 'the stored conversation stays unmarked');
  ok(or.turn.usage?.costUsd === undefined && or.turn.usage?.cacheRead === 0 && or.turn.usage.input === 1000, `a reply without cost or cached tokens: no costUsd, cacheRead 0 (${JSON.stringify(or.turn.usage)})`);
  script = [reply({ content: null, tool_calls: [click('c2')] }, 'tool_calls', { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 }, cost: 0.0123 })];
  const priced = await run({ baseUrl: 'https://openrouter.ai/api/v1' });
  ok(priced.turn.usage?.costUsd === 0.0123, `usage.cost → costUsd (${JSON.stringify(priced.turn.usage)})`);
  ok(priced.turn.usage?.cacheRead === 800 && priced.turn.usage.input === 200 && priced.turn.usage.output === 20, `cached tokens → cacheRead, input is the uncached rest (${JSON.stringify(priced.turn.usage)})`);
  ok(requests.every((r) => r.body.max_tokens === 8000), 'max_tokens is 8000');

  // auto + another host: nothing added.
  const xai = await run({ baseUrl: 'https://api.x.ai/v1', promptCaching: 'auto' });
  ok(marksIn(xai.sent[0].body) === 0 && typeof xai.sent[0].body.messages[0].content === 'string', 'auto + api.x.ai: no cache_control, the system prompt stays a string');
  ok(xai.sent[0].body.usage === undefined, 'auto + api.x.ai: no usage.include');
  // on + another host: marks, but still no usage.include.
  const lite = await run({ baseUrl: 'http://localhost:4000/v1', promptCaching: 'on' });
  ok(systemMarked(lite.sent[0].body) && lastTextMarked(lite.sent[0].body) && marksIn(lite.sent[0].body) === 2, 'on + localhost: marks on system and newest user text');
  ok(lite.sent[0].body.usage === undefined, 'on + localhost: usage.include stays OpenRouter-only');
  // off + openrouter: no marks, usage.include still on.
  const off = await run({ baseUrl: 'https://openrouter.ai/api/v1', promptCaching: 'off' });
  ok(marksIn(off.sent[0].body) === 0 && off.sent[0].body.usage?.include === true, 'off + openrouter.ai: no marks, usage.include kept');

  // A length cut with nothing said: one continuation request, then the real answer is used.
  script = [reply({ content: '' }, 'length'), reply({ content: null, tool_calls: [click('c3')] })];
  const cut = await run({ baseUrl: 'https://openrouter.ai/api/v1' });
  const cont = cut.sent[1]?.body.messages.at(-1);
  ok(cut.sent.length === 2 && cont?.role === 'user' && /cut off at the token limit/.test(JSON.stringify(cont.content)) && cut.turn.actions[0]?.type === 'click', `an empty length-cut reply gets one retry with a continuation note (${cut.sent.length} requests)`);
  script = [reply({ content: '' }, 'length'), reply({ content: '' }, 'length')];
  const twice = await run({ baseUrl: 'https://openrouter.ai/api/v1' }).then(() => undefined, (e: unknown) => e as Error);
  ok(twice instanceof Error && /ran out of output tokens twice/.test(twice.message), `two cuts fail loudly: ${twice?.message}`);
} finally {
  globalThis.fetch = realFetch;
  server.close();
}

console.log(`openrouter-cache: ${n} checks passed`);
