// The provider presets behind the model picker: pure data plus three helpers (presetFor,
// keySlotFor, isLocalEndpoint). No network, no vscode.
import assert from 'node:assert/strict';
import { PRESETS, isLocalEndpoint, keySlotFor, presetFor } from '../src/agent/presets';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

const byId = (id: string) => PRESETS.find((p) => p.id === id);
const ids = PRESETS.map((p) => p.id);
ok(['anthropic', 'openrouter', 'xai', 'moonshot', 'ollama', 'litellm', 'custom', 'mock'].every((id) => ids.includes(id)) && new Set(ids).size === ids.length, `presets present, ids unique: ${ids.join(', ')}`);
ok(byId('anthropic')!.provider === 'anthropic' && byId('anthropic')!.baseUrl === '' && byId('anthropic')!.needsKey && byId('anthropic')!.models.length >= 1, 'Anthropic direct: SDK default URL, needs a key, suggests models');
ok(byId('openrouter')!.provider === 'openai-compatible' && byId('openrouter')!.baseUrl === 'https://openrouter.ai/api/v1' && byId('openrouter')!.needsKey && byId('openrouter')!.models.some((m) => m.name.startsWith('anthropic/')), 'OpenRouter: openai-compatible at openrouter.ai/api/v1 with Claude slugs');
ok(byId('moonshot')!.baseUrl === 'https://api.moonshot.ai/v1' && /Beijing/.test(byId('moonshot')!.detail) && byId('moonshot')!.models.some((m) => m.name === 'kimi-k3'), 'Moonshot direct: api.moonshot.ai, origin stated, kimi-k3');
ok(byId('xai')!.baseUrl === 'https://api.x.ai/v1' && byId('xai')!.needsKey && byId('ollama')!.needsKey === false && byId('litellm')!.needsKey === false && byId('mock')!.provider === 'mock' && byId('mock')!.needsKey === false && byId('custom')!.askBaseUrl === true && byId('custom')!.baseUrl === '', 'xAI needs a key; Ollama, LiteLLM and the demo model do not; custom asks for its URL');
ok(PRESETS.every((p) => p.label && p.detail && (p.provider !== 'openai-compatible' || p.baseUrl || p.askBaseUrl)), 'every preset has a label, a detail, and (when OpenAI-compatible) a base URL or asks for one');

// presetFor: by provider and base URL, trailing slashes and spaces tolerated; unknown URLs → none (custom).
ok(presetFor('anthropic', 'https://ignored.example')?.id === 'anthropic' && presetFor('mock', '')?.id === 'mock', 'presetFor: anthropic and mock by provider alone');
ok(presetFor('openai-compatible', 'https://openrouter.ai/api/v1/')?.id === 'openrouter' && presetFor('openai-compatible', ' https://api.x.ai/v1 ')?.id === 'xai' && presetFor('openai-compatible', 'http://localhost:11434/v1')?.id === 'ollama' && presetFor('openai-compatible', 'https://api.moonshot.ai/v1')?.id === 'moonshot', 'presetFor: OpenAI-compatible presets found by base URL (slash and spaces tolerated)');
ok(presetFor('openai-compatible', 'https://vllm.example/v1') === undefined && presetFor('openai-compatible', '') === undefined, 'presetFor: an unknown or empty URL matches no preset');

// keySlotFor: one secret slot per place the key belongs to.
ok(keySlotFor('anthropic', '') === 'deskfish.apiKey.anthropic' && keySlotFor('anthropic', 'https://x') === 'deskfish.apiKey.anthropic', 'keySlotFor: anthropic has one slot');
ok(keySlotFor('openai-compatible', 'https://OpenRouter.ai/api/v1') === 'deskfish.apiKey.openrouter.ai' && keySlotFor('openai-compatible', 'https://api.x.ai/v1') === 'deskfish.apiKey.api.x.ai' && keySlotFor('openai-compatible', 'https://api.moonshot.ai/v1') === 'deskfish.apiKey.api.moonshot.ai', 'keySlotFor: one slot per host, lower-cased');
ok(keySlotFor('mock', '') === undefined && keySlotFor('openai-compatible', 'not a url') === undefined && keySlotFor('openai-compatible', '') === undefined, 'keySlotFor: none for the demo model or an unparseable URL');

// isLocalEndpoint: local hosts need no key.
// (Not asserted: 'http://[::1]:4000/v1' — URL.hostname keeps the brackets, so the '::1' branch never matches; see the report.)
ok(isLocalEndpoint('http://localhost:11434/v1') && isLocalEndpoint('http://127.0.0.1:4000/v1') && isLocalEndpoint('http://tank.local/v1'), 'isLocalEndpoint: localhost, 127.0.0.1 and .local are local');
ok(!isLocalEndpoint('https://openrouter.ai/api/v1') && !isLocalEndpoint('https://api.x.ai/v1') && !isLocalEndpoint('garbage') && !isLocalEndpoint(''), 'isLocalEndpoint: remote hosts and garbage are not');
ok(PRESETS.filter((p) => p.provider === 'openai-compatible' && !p.needsKey).every((p) => isLocalEndpoint(p.baseUrl)) && PRESETS.filter((p) => p.provider === 'openai-compatible' && p.baseUrl && p.needsKey).every((p) => !isLocalEndpoint(p.baseUrl)), 'presets agree: keyless OpenAI-compatible presets are local, keyed ones are remote');

console.log(`presets: ${n} checks passed`);
