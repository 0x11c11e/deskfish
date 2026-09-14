// Pricing: the list-price table and where it applies. Claude rows price the anthropic provider
// (direct or through a gateway); Moonshot rows price Kimi only on Moonshot's own API host, so a
// self-hosted "kimi-k3" (vLLM, Ollama) gets no estimate and OpenRouter — which reports its own
// charge — is never estimated; the demo model and unknown models get nothing; costUsd sums the
// four rates and tolerates missing cache counts.
import assert from 'node:assert/strict';
import { PRICES, costUsd, priceFor, priceForConfig } from '../src/agent/pricing';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ---------- by name (Claude only) ----------
ok(priceFor('claude-opus-5')?.input === 5 && priceFor('claude-opus-5')?.output === 25, 'Opus 5 by name');
ok(priceFor('claude-sonnet-5')?.input === 2 && priceFor('claude-sonnet-5')?.cacheRead === 0.2, 'Sonnet 5 by name');
ok(priceFor('kimi-k3') === undefined, 'a host-scoped row is not priced by name alone');
ok(priceFor('gpt-5') === undefined && priceFor('') === undefined && priceFor(undefined) === undefined, 'unknown or empty → no price');

// ---------- by configuration ----------
const sonnet = priceForConfig({ provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: '' });
ok(sonnet?.input === 2 && sonnet.output === 10, 'anthropic direct → Claude list price');
ok(priceForConfig({ provider: 'anthropic', model: 'claude-opus-5', baseUrl: 'https://gateway.example.com' })?.input === 5, 'anthropic through a gateway is still priced at Anthropic rates');
const k3 = priceForConfig({ provider: 'openai-compatible', model: 'kimi-k3', baseUrl: 'https://api.moonshot.ai/v1' });
ok(k3?.input === 3 && k3.output === 15 && k3.cacheRead === 0.3, `Kimi K3 on Moonshot direct → $3 / $15 / $0.30 (${JSON.stringify(k3)})`);
ok(priceForConfig({ provider: 'openai-compatible', model: 'kimi-k3', baseUrl: 'https://api.moonshot.cn/v1' })?.input === 3, 'the .cn host counts as Moonshot too');
const k26 = priceForConfig({ provider: 'openai-compatible', model: 'kimi-k2.6', baseUrl: 'https://api.moonshot.ai/v1' });
ok(k26?.input === 0.95 && k26.output === 4 && k26.cacheRead === 0.16, 'Kimi K2.6 on Moonshot direct');
ok(priceForConfig({ provider: 'openai-compatible', model: 'kimi-k2.7-code-highspeed', baseUrl: 'https://api.moonshot.ai/v1' })?.input === 1.9, 'the highspeed code model matches its own row, not the plain code row');
ok(priceForConfig({ provider: 'openai-compatible', model: 'kimi-k2.7-code', baseUrl: 'https://api.moonshot.ai/v1' })?.input === 0.95, 'the plain code model');
ok(priceForConfig({ provider: 'openai-compatible', model: 'moonshotai/kimi-k3', baseUrl: 'https://openrouter.ai/api/v1' }) === undefined, 'OpenRouter is never estimated (it reports the charge)');
ok(priceForConfig({ provider: 'openai-compatible', model: 'kimi-k3', baseUrl: 'http://localhost:11434/v1' }) === undefined, 'a local model named kimi-k3 has no list price');
ok(priceForConfig({ provider: 'openai-compatible', model: 'kimi-k3', baseUrl: 'https://notmoonshot.ai/v1' }) === undefined, 'a look-alike host does not match');
ok(priceForConfig({ provider: 'openai-compatible', model: 'kimi-k3', baseUrl: '' }) === undefined, 'no base URL → no price');
ok(priceForConfig({ provider: 'openai-compatible', model: 'kimi-k3', baseUrl: 'not a url' }) === undefined, 'a malformed base URL → no price, no throw');
ok(priceForConfig({ provider: 'openai-compatible', model: 'moonshot-v1-8k', baseUrl: 'https://api.moonshot.ai/v1' }) === undefined, 'an unlisted Moonshot model → tokens only');
ok(priceForConfig({ provider: 'openai-compatible', model: 'claude-sonnet-5', baseUrl: 'https://api.moonshot.ai/v1' }) === undefined, 'a Claude name on a non-Anthropic provider is not priced at Anthropic rates');
ok(priceForConfig({ provider: 'mock', model: 'mock', baseUrl: '' }) === undefined, 'the demo model is free');
ok(PRICES.every((r) => r.price.input > 0 && r.price.output > 0 && r.price.cacheRead <= r.price.input), 'every row has positive rates and a cache read no dearer than input');

// ---------- costUsd ----------
const today = { input: 150_000, output: 12_000, cacheRead: 590_000 };
ok(close(costUsd(today, k3!), 0.45 + 0.177 + 0.18), `a 40-step Kimi task at 80% cache ≈ $0.81 (${costUsd(today, k3!).toFixed(3)})`);
ok(close(costUsd(today, sonnet!), 0.3 + 0.118 + 0.12), `the same tokens on Sonnet 5 ≈ $0.54 (${costUsd(today, sonnet!).toFixed(3)})`);
ok(close(costUsd({ input: 1_000_000, output: 0 }, k3!), 3), 'missing cache counts are treated as zero');
ok(close(costUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, sonnet!), 2.5), 'cache writes use the write rate');
ok(close(costUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }, sonnet!), 4), '1-hour cache writes are billed at twice the input rate');
ok(close(costUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 400_000 }, sonnet!), 0.6 * 2.5 + 0.4 * 4), 'mixed TTLs split the write between the two rates');

console.log(`pricing: ${n} checks passed`);
