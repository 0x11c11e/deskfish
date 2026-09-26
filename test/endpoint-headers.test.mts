// Per-host additions on the OpenAI-compatible path: api.x.ai gets `x-grok-conv-id` (one id per adapter
// instance = per chat, surviving a second start()), openrouter.ai gets the app-attribution pair, api.openai.com
// gets `prompt_cache_key` in the body, and every other host sends exactly what it sent before. The fake endpoint
// is a local HTTP server; fetch is monkeypatched so any host lands on it, and records the headers the adapter set.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatAdapter } from '../src/agent/adapters/openaiCompat';
import type { AdapterConfig, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

type Recorded = { url: string; headers: Record<string, string>; body: any };
const requests: Recorded[] = [];
const click = (id: string) => ({ id, type: 'function', function: { name: 'computer', arguments: JSON.stringify({ action: 'left_click', coordinate: [10, 20] }) } });
const reply = () => ({ id: 'cmpl', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [click(`call_${requests.length}`)] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1000, completion_tokens: 20 } });
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply()));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init: RequestInit) => {
  requests.push({ url: String(url), headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) });
  return realFetch(String(url).replace(/^https?:\/\/[^/]+/, local), init);
}) as typeof fetch;

const jpeg = Buffer.from('ffd8ffd9', 'hex');
const obs = (results: Observation['results'] = []): Observation => ({ image: { jpeg, width: 640, height: 400 }, results });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const make = (cfg: Partial<AdapterConfig>) => new OpenAICompatAdapter({ provider: 'openai-compatible', model: 'test-model', ...cfg } as AdapterConfig);
const sent = async (adapter: OpenAICompatAdapter, steps: number) => {
  const first = requests.length;
  adapter.start('headers', { width: 640, height: 400 });
  let turn = await adapter.step(obs());
  for (let i = 1; i < steps; i++) turn = await adapter.step(obs(turn.actions.map(() => ({ ok: true }))));
  return requests.slice(first);
};
const extras = ['x-grok-conv-id', 'http-referer', 'x-openrouter-title', 'x-title'];

try {
  // (1) xAI: one id per instance, the same on every request and across a second start() (a ledger restart).
  const grok = make({ baseUrl: 'https://api.x.ai/v1', apiKey: 'k' });
  const g = [...(await sent(grok, 2)), ...(await sent(grok, 1))];
  const ids = g.map((r) => lower(r.headers)['x-grok-conv-id']);
  ok(g.length === 3 && UUID.test(ids[0]), `api.x.ai: x-grok-conv-id is a UUID (${ids[0]})`);
  ok(ids.every((id) => id === ids[0]), `api.x.ai: the id is identical across requests and a second start() (${ids})`);
  ok(g.every((r) => !('http-referer' in lower(r.headers)) && !('x-openrouter-title' in lower(r.headers)) && r.body.prompt_cache_key === undefined), 'api.x.ai: no attribution headers, no prompt_cache_key');
  const grok2 = make({ baseUrl: 'https://api.x.ai/v1', apiKey: 'k' });
  const id2 = lower((await sent(grok2, 1))[0].headers)['x-grok-conv-id'];
  ok(UUID.test(id2) && id2 !== ids[0], 'api.x.ai: a new adapter instance (a new chat) carries a different id');
  const signedIn = make({ baseUrl: 'https://api.x.ai/v1', bearer: async () => 'tok' });
  const s = lower((await sent(signedIn, 1))[0].headers);
  ok(s.authorization === 'Bearer tok' && UUID.test(s['x-grok-conv-id']), 'the signed-in Grok path (bearer) carries the id too');
  const sub = lower((await sent(make({ baseUrl: 'https://eu.api.x.ai/v1' }), 1))[0].headers);
  ok(UUID.test(sub['x-grok-conv-id']), 'a subdomain of api.x.ai carries the id');
  const lookalike = lower((await sent(make({ baseUrl: 'https://notapi.x.ai.example.com/v1' }), 1))[0].headers);
  ok(!('x-grok-conv-id' in lookalike), 'a host that only contains api.x.ai does not');

  // (2) OpenRouter: the attribution pair with its exact values, usage.include kept, nothing of xAI's or OpenAI's.
  const or = (await sent(make({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' }), 1))[0];
  const oh = lower(or.headers);
  ok(oh['http-referer'] === 'https://deskfish.sh' && oh['x-openrouter-title'] === 'Deskfish', `openrouter.ai: HTTP-Referer and X-OpenRouter-Title (${JSON.stringify(oh)})`);
  ok(or.body.usage?.include === true, 'openrouter.ai: usage.include is still in the body');
  ok(!('x-grok-conv-id' in oh) && or.body.prompt_cache_key === undefined, 'openrouter.ai: no x-grok-conv-id, no prompt_cache_key');

  // (3) OpenAI: the body carries prompt_cache_key = the instance's id; no extra headers.
  const oa = make({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k' });
  const o = await sent(oa, 2);
  const key = o[0].body.prompt_cache_key;
  ok(UUID.test(key) && key === (oa as any).conversationId && o[1].body.prompt_cache_key === key, `api.openai.com: prompt_cache_key is the instance's id on every request (${key})`);
  ok(Object.keys(lower(o[0].headers)).sort().join(',') === 'authorization,content-type', `api.openai.com: no extra headers (${Object.keys(o[0].headers)})`);

  // (4) Everyone else: headers and body fields exactly as before.
  for (const baseUrl of ['http://127.0.0.1:4000/v1', 'http://localhost:11434/v1', 'https://api.moonshot.ai/v1']) {
    for (const apiKey of ['k', undefined]) {
      const r = (await sent(make({ baseUrl, apiKey }), 1))[0];
      const names = Object.keys(lower(r.headers)).sort().join(',');
      ok(names === (apiKey ? 'authorization,content-type' : 'content-type'), `${baseUrl} (${apiKey ? 'key' : 'no key'}): headers are exactly ${names}`);
      ok(!extras.some((h) => h in lower(r.headers)) && !('prompt_cache_key' in r.body) && !('usage' in r.body), `${baseUrl}: none of the three additions in the body`);
    }
  }
} finally {
  globalThis.fetch = realFetch;
  server.close();
}

console.log(`endpoint-headers: ${n} checks passed`);
