// The OpenAI-compatible adapter's retry (decision 172): a connection that broke — before the headers or in the
// middle of the body — and the provider's 500/502/503/504/529 are tried twice more after 2 s and 6 s; a 4xx, the
// signed-in pool's 429, a refused connection and the stop are not. The fake endpoint is a local HTTP server whose
// answer per request the test scripts; fetch is monkeypatched so any host lands on it and every request is
// recorded. The schedule is shortened through the static hook, so nothing here sleeps for seconds.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatAdapter } from '../src/agent/adapters/openaiCompat';
import { isPoolExhaustedError, type AdapterConfig, type Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

type Answer = 'reset' | 'reset-mid-body' | number;
let script: Answer[] = [];
let body429 = '';
const requests: Record<string, string>[] = [];
const click = { id: 'call_1', type: 'function', function: { name: 'computer', arguments: JSON.stringify({ action: 'left_click', coordinate: [10, 20] }) } };
const reply = JSON.stringify({ id: 'cmpl', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [click] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1000, completion_tokens: 20 } });
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const a = script.shift() ?? 200;
    if (a === 'reset') return req.socket.destroy();
    if (a === 'reset-mid-body') {
      // The headers and half of the body, then the socket goes: the body read is what breaks.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(reply.length) });
      res.write(reply.slice(0, 40));
      return setTimeout(() => req.socket.destroy(), 20);
    }
    if (a === 200) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(reply);
    }
    res.writeHead(a, { 'content-type': 'application/json' });
    res.end(a === 429 ? body429 : JSON.stringify({ error: { message: `status ${a}` } }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init: RequestInit) => {
  requests.push(Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])));
  return realFetch(String(url).replace(/^https?:\/\/[^/]+/, local), init);
}) as typeof fetch;

const jpeg = Buffer.from('ffd8ffd9', 'hex');
const obs: Observation = { image: { jpeg, width: 640, height: 400 }, results: [] };
const make = (cfg: Partial<AdapterConfig> = {}) => {
  const a = new OpenAICompatAdapter({ provider: 'openai-compatible', model: 'test-model', baseUrl: 'https://api.x.ai/v1', apiKey: 'k', ...cfg } as AdapterConfig);
  a.start('retry', { width: 640, height: 400 });
  return a;
};
// One step against a scripted server; returns the turn or the error, and the requests it made.
const run = async (answers: Answer[], adapter = make(), signal?: AbortSignal) => {
  script = [...answers];
  requests.length = 0;
  const t0 = Date.now();
  try {
    const turn = await adapter.step(obs, signal);
    return { turn, err: undefined as any, reqs: [...requests], ms: Date.now() - t0 };
  } catch (err) {
    return { turn: undefined, err: err as any, reqs: [...requests], ms: Date.now() - t0 };
  }
};

const saved = OpenAICompatAdapter.RETRY_DELAYS_MS;
OpenAICompatAdapter.RETRY_DELAYS_MS = [10, 20];
try {
  ok(saved.join(',') === '2000,6000', `the production schedule is 2 s then 6 s (${saved})`);

  // (1) Two resets, then an answer: the reply comes back after three requests, all on the same conversation id.
  {
    const r = await run(['reset', 'reset', 200]);
    ok(!r.err && r.turn?.actions.length === 1, `two resets then 200: the reply comes back (${r.err?.message})`);
    ok(r.reqs.length === 3, `two resets then 200: three requests (${r.reqs.length})`);
    const ids = r.reqs.map((h) => h['x-grok-conv-id']);
    ok(ids[0] && ids.every((id) => id === ids[0]), `the retried requests carry the first one's x-grok-conv-id (${ids})`);
    ok(r.reqs.every((h) => h.authorization === 'Bearer k'), 'and the same key');
  }

  // (2) A reset every time: three requests, then the error that says so.
  {
    const r = await run(['reset', 'reset', 'reset', 200]);
    ok(r.reqs.length === 3, `resets every time: exactly three requests (${r.reqs.length})`);
    ok(/^Cannot reach the model provider at https:\/\/api\.x\.ai\/v1\/chat\/completions \(.+, after 3 attempts over about \d+ s\)\. Check deskfish\.baseUrl/.test(r.err?.message), `the final error says how many attempts (${r.err?.message})`);
  }

  // (2b) The pilot's case: a reset in the middle of the body is retried the same way.
  {
    const r = await run(['reset-mid-body', 200]);
    ok(!r.err && r.turn?.actions.length === 1 && r.reqs.length === 2, `a reset mid-body then 200: two requests, the reply (${r.reqs.length}, ${r.err?.message})`);
    const all = await run(['reset-mid-body', 'reset-mid-body', 'reset-mid-body']);
    ok(all.reqs.length === 3 && /Cannot reach the model provider .*after 3 attempts/.test(all.err?.message), `mid-body every time: three requests and the counted error (${all.err?.message})`);
  }

  // (3) 503 then 200: two requests, the reply. And the HTTP error after three 5xx carries the count.
  {
    const r = await run([503, 200]);
    ok(!r.err && r.turn?.actions.length === 1 && r.reqs.length === 2, `503 then 200: two requests, the reply (${r.reqs.length})`);
    for (const s of [500, 502, 504, 529]) {
      const t = await run([s, 200]);
      ok(!t.err && t.reqs.length === 2, `${s} then 200: retried (${t.reqs.length})`);
    }
    const all = await run([502, 502, 502, 200]);
    ok(all.reqs.length === 3 && /^test-model @ .*: HTTP 502 .* \(after 3 attempts\)$/.test(all.err?.message), `502 every time: three requests, "(after 3 attempts)" (${all.err?.message})`);
  }

  // (4) 400: one request, the error reads exactly as it did before the retry existed.
  {
    const r = await run([400, 200]);
    ok(r.reqs.length === 1, `400: exactly one request (${r.reqs.length})`);
    ok(r.err?.message === 'test-model @ https://api.x.ai/v1/chat/completions: HTTP 400 {"error":{"message":"status 400"}}', `400: the message is unchanged (${r.err?.message})`);
    const plain429 = await run([429, 200]);
    ok(plain429.reqs.length === 1 && /HTTP 429/.test(plain429.err?.message) && !/attempts/.test(plain429.err?.message), `a plain 429 is not retried (${plain429.err?.message})`);
  }

  // (5) The signed-in pool's 429: one request, the knock, no retry.
  {
    body429 = JSON.stringify({ error: 'You have run out of available resources' });
    const r = await run([429, 200], make({ apiKey: undefined, bearer: async () => 'tok' }));
    ok(r.reqs.length === 1 && isPoolExhaustedError(r.err), `bearer + 429: one request, PoolExhaustedError (${r.reqs.length}, ${r.err?.name})`);
  }

  // (6) The stop during the first back-off: rejected at once, with the abort itself, after one request.
  {
    OpenAICompatAdapter.RETRY_DELAYS_MS = [500, 20];
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 80);
    const r = await run(['reset', 'reset', 200], make(), ctl.signal);
    ok(r.err && r.ms < 300, `aborted in the back-off: rejected promptly (${r.ms} ms)`);
    ok(r.err?.name === 'AbortError' && !/Cannot reach/.test(r.err?.message), `the rejection is the abort, not the unreachable error (${r.err?.name}: ${r.err?.message})`);
    await new Promise((res) => setTimeout(res, 600));
    ok(r.reqs.length === 1 && requests.length === 1, `no request after the abort (${requests.length})`);
    OpenAICompatAdapter.RETRY_DELAYS_MS = [10, 20];
  }

  // (7) A refused connection (nothing listening) is not retried and reads as before.
  {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    globalThis.fetch = ((url: string, init: RequestInit) => {
      requests.push({});
      return realFetch(`http://127.0.0.1:${port}/v1/chat/completions`, init);
    }) as typeof fetch;
    const r = await run([], make({ baseUrl: `http://127.0.0.1:${port}/v1` }));
    ok(r.reqs.length === 1 && /\(ECONNREFUSED\)\. Check deskfish\.baseUrl/.test(r.err?.message), `ECONNREFUSED: one request, no count in the message (${r.err?.message})`);
  }
} finally {
  OpenAICompatAdapter.RETRY_DELAYS_MS = saved;
  globalThis.fetch = realFetch;
  server.close();
}

console.log(`retry: ${n} checks passed`);
