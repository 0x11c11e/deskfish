// Long tool results (page text, command output) stay whole only while recent: after more than
// KEEP + BATCH long results the older ones shrink to their first line, in a batch, on both
// adapters. The prefix between prunes is byte-stable (cache hits), and short results are never touched.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicAdapter } from '../src/agent/adapters/anthropic';
import { OpenAICompatAdapter } from '../src/agent/adapters/openaiCompat';
import type { Observation } from '../src/agent/adapters/types';
import { KEEP_LONG_RESULTS, LONG_RESULT_CHARS, PRUNE_TEXT_BATCH, shortenResult } from '../src/agent/prune';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

const TURNS = 9; // two read_page calls per turn → 18 long results
const long = (i: number) => `Page text ${i}: ${'lorem ipsum dolor sit amet '.repeat(120)}`; // ~3,200 chars
const jpeg = Buffer.from('ffd8ffd9', 'hex');
const obs = (results: Observation['results']): Observation => ({ image: { jpeg, width: 640, height: 400 }, results });
const isLong = (t: string) => t.length > LONG_RESULT_CHARS && !t.includes('dropped from the conversation');
const isShort = (t: string) => t.includes('dropped from the conversation');

// ---------- Anthropic ----------
{
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      bodies.push(JSON.parse(data));
      const i = bodies.length - 1;
      const last = i === TURNS;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `msg_${i}`, type: 'message', role: 'assistant', model: 'm', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
        content: last ? [{ type: 'text', text: 'done' }] : [{ type: 'tool_use', id: `a_${i}`, name: 'read_page', input: { scope: 'text' } }, { type: 'tool_use', id: `b_${i}`, name: 'read_page', input: { scope: 'text' } }],
        stop_reason: last ? 'end_turn' : 'tool_use',
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'claude-test', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'dummy', refusalFallback: false });
    adapter.start('read a lot', { width: 640, height: 400 });
    let turn = await adapter.step(obs([]));
    let k = 0;
    while (!turn.done) {
      ok(turn.actions.length === 2 && turn.actions.every((a) => a.type === 'read_page'), `turn parsed two read_page calls`);
      turn = await adapter.step(obs([{ ok: true, message: long(k++) }, { ok: true, message: `short ${k}` + long(k++) }]));
    }
    // Texts of every tool_result in a request body, in order.
    const texts = (body: any): string[] => {
      const out: string[] = [];
      for (const m of body.messages) {
        if (m.role !== 'user' || !Array.isArray(m.content)) continue;
        for (const b of m.content) {
          if (b.type !== 'tool_result') continue;
          if (typeof b.content === 'string') out.push(b.content);
          else for (const c of b.content) if (c.type === 'text') out.push(c.text);
        }
      }
      return out;
    };
    const longs = bodies.map((b) => texts(b).filter(isLong).length);
    ok(Math.max(...longs) === KEEP_LONG_RESULTS + PRUNE_TEXT_BATCH, `long results never exceed KEEP + BATCH (${longs.join(',')})`);
    ok(longs.includes(KEEP_LONG_RESULTS) && longs[longs.length - 1] <= KEEP_LONG_RESULTS + PRUNE_TEXT_BATCH, 'a prune drops back to KEEP');
    const lastTexts = texts(bodies[bodies.length - 1]);
    const shortened = lastTexts.filter(isShort);
    ok(shortened.length > 0 && shortened.every((t) => /^(Page text \d+:|short \d+Page text)/.test(t) && t.includes('characters; ask again')), `shortened results keep their first line: ${shortened[0]?.slice(0, 40)}`);
    ok(lastTexts.filter(isLong).slice(-1)[0]?.includes('Page text 17'), 'the newest results stay whole');
    // Both forms were pruned: a string content (the first call) and a text block next to the screenshot (the last call).
    const stringForms = bodies[bodies.length - 1].messages.filter((m: any) => m.role === 'user' && Array.isArray(m.content)).flatMap((m: any) => m.content).filter((b: any) => b.type === 'tool_result' && typeof b.content === 'string' && isShort(b.content));
    const blockForms = bodies[bodies.length - 1].messages.filter((m: any) => m.role === 'user' && Array.isArray(m.content)).flatMap((m: any) => m.content).filter((b: any) => b.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c: any) => c.type === 'text' && isShort(c.text)));
    ok(stringForms.length > 0 && blockForms.length > 0, `string results (${stringForms.length}) and block results (${blockForms.length}) both shrink`);
    // Prefix stability: strip the moving cache mark, then each request must start with the previous one's messages except at a prune.
    const strip = (b: any) => JSON.stringify(b.messages, (key, v) => (key === 'cache_control' ? undefined : v));
    let rewrites = 0;
    for (let i = 1; i < bodies.length; i++) {
      const prev = strip(bodies[i - 1]).slice(0, -1); // drop the closing ]
      if (!strip(bodies[i]).startsWith(prev)) rewrites++;
    }
    ok(rewrites >= 1 && rewrites <= 3, `the prefix is rewritten only at prunes (${rewrites} of ${bodies.length - 1} requests)`);
  } finally {
    server.close();
  }
}

// ---------- OpenAI-compatible ----------
{
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      bodies.push(JSON.parse(data));
      const i = bodies.length - 1;
      const last = i === TURNS;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl', object: 'chat.completion', usage: { prompt_tokens: 10, completion_tokens: 1 },
        choices: [{ index: 0, finish_reason: last ? 'stop' : 'tool_calls', message: last ? { role: 'assistant', content: 'done' } : { role: 'assistant', content: null, tool_calls: [{ id: `a_${i}`, type: 'function', function: { name: 'read_page', arguments: '{"scope":"text"}' } }, { id: `b_${i}`, type: 'function', function: { name: 'read_page', arguments: '{"scope":"text"}' } }] } }],
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const adapter = new OpenAICompatAdapter({ provider: 'openai-compatible', model: 'm', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'dummy', promptCaching: 'off' });
    adapter.start('read a lot', { width: 640, height: 400 });
    let turn = await adapter.step(obs([]));
    let k = 0;
    while (!turn.done) turn = await adapter.step(obs([{ ok: true, message: long(k++) }, { ok: true, message: long(k++) }]));
    const longs = bodies.map((b) => b.messages.filter((m: any) => m.role === 'tool' && isLong(m.content)).length);
    ok(Math.max(...longs) === KEEP_LONG_RESULTS + PRUNE_TEXT_BATCH && longs.includes(KEEP_LONG_RESULTS), `OpenAI path: tool messages are pruned in batches (${longs.join(',')})`);
    const lastBody = bodies[bodies.length - 1];
    ok(lastBody.messages.some((m: any) => m.role === 'tool' && isShort(m.content)), 'older tool messages are shortened');
  } finally {
    server.close();
  }
}

ok(shortenResult('$ npm test\nline2\nline3'.padEnd(2000, 'x')).startsWith('$ npm test\n[the rest'), 'shortenResult keeps the first line');
console.log(`prunetext: ${n} checks passed`);
