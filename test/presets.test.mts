// The provider presets behind the model picker: pure data plus three helpers (presetFor,
// keySlotFor, isLocalEndpoint). No network, no vscode.
import assert from 'node:assert/strict';
import { PRESETS, isLocalEndpoint, isOauthSlot, keySlotFor, presetFor } from '../src/agent/presets';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

const byId = (id: string) => PRESETS.find((p) => p.id === id);
const ids = PRESETS.map((p) => p.id);
ok(['anthropic', 'openrouter', 'xai', 'xai-subscription', 'moonshot', 'ollama', 'litellm', 'custom', 'mock'].every((id) => ids.includes(id)) && new Set(ids).size === ids.length, `presets present, ids unique: ${ids.join(', ')}`);
ok(byId('anthropic')!.provider === 'anthropic' && byId('anthropic')!.baseUrl === '' && byId('anthropic')!.needsKey && byId('anthropic')!.models.length >= 1, 'Anthropic direct: SDK default URL, needs a key, suggests models');
ok(byId('openrouter')!.provider === 'openai-compatible' && byId('openrouter')!.baseUrl === 'https://openrouter.ai/api/v1' && byId('openrouter')!.needsKey && byId('openrouter')!.models.some((m) => m.name.startsWith('anthropic/')), 'OpenRouter: openai-compatible at openrouter.ai/api/v1 with Claude slugs');
ok(byId('moonshot')!.baseUrl === 'https://api.moonshot.ai/v1' && /Beijing/.test(byId('moonshot')!.detail) && byId('moonshot')!.models.some((m) => m.name === 'kimi-k3'), 'Moonshot direct: api.moonshot.ai, origin stated, kimi-k3');
ok(byId('xai')!.baseUrl === 'https://api.x.ai/v1' && byId('xai')!.needsKey && byId('ollama')!.needsKey === false && byId('litellm')!.needsKey === false && byId('mock')!.provider === 'mock' && byId('mock')!.needsKey === false && byId('custom')!.askBaseUrl === true && byId('custom')!.baseUrl === '', 'xAI needs a key; Ollama, LiteLLM and the demo model do not; custom asks for its URL');
ok(PRESETS.every((p) => p.label && p.detail && (p.provider !== 'openai-compatible' || p.baseUrl || p.askBaseUrl)), 'every preset has a label, a detail, and (when OpenAI-compatible) a base URL or asks for one');

// "Sign in with Grok": a second xAI preset at the same endpoint, told apart by `auth`.
const sub = byId('xai-subscription')!;
ok(sub.provider === 'openai-compatible' && sub.baseUrl === byId('xai')!.baseUrl && sub.auth === 'xai-oauth' && sub.needsKey === false, 'xai-subscription: same endpoint as the keyed xAI preset, signs in instead of taking a key');
ok(/SuperGrok/.test(sub.label) && /pool/.test(sub.detail) && /xAI decides which accounts/.test(sub.detail), 'xai-subscription: the label names the plan and the detail warns that xAI gates it');
ok(sub.models.some((m) => m.name === 'grok-4.6') && sub.models.every((m) => byId('xai')!.models.some((k) => k.name === m.name)), 'xai-subscription: the model list is the one the endpoint really serves, shared with the keyed preset');
ok(PRESETS.filter((p) => p.auth).length === 1, 'only xAI signs in: Anthropic forbids it and OpenAI documents it for Codex alone');
ok(PRESETS.every((p) => !p.auth || !p.needsKey), 'a preset that signs in never also asks for a key');

// presetFor: by provider and base URL, trailing slashes and spaces tolerated; unknown URLs → none (custom).
ok(presetFor('anthropic', 'https://ignored.example')?.id === 'anthropic' && presetFor('mock', '')?.id === 'mock', 'presetFor: anthropic and mock by provider alone');
ok(presetFor('openai-compatible', 'https://openrouter.ai/api/v1/')?.id === 'openrouter' && presetFor('openai-compatible', ' https://api.x.ai/v1 ')?.id === 'xai' && presetFor('openai-compatible', 'http://localhost:11434/v1')?.id === 'ollama' && presetFor('openai-compatible', 'https://api.moonshot.ai/v1')?.id === 'moonshot', 'presetFor: OpenAI-compatible presets found by base URL (slash and spaces tolerated)');
ok(presetFor('openai-compatible', 'https://vllm.example/v1') === undefined && presetFor('openai-compatible', '') === undefined, 'presetFor: an unknown or empty URL matches no preset');
ok(presetFor('openai-compatible', 'https://api.x.ai/v1', 'xai-oauth')?.id === 'xai-subscription' && presetFor('openai-compatible', 'https://api.x.ai/v1', '')?.id === 'xai' && presetFor('openai-compatible', 'https://api.x.ai/v1')?.id === 'xai', 'presetFor: `auth` tells the two xAI presets apart, and no `auth` means the keyed one');
ok(presetFor('openai-compatible', 'https://openrouter.ai/api/v1', 'xai-oauth')?.id === 'openrouter', 'presetFor: an `auth` no preset at that URL offers still finds the endpoint rather than nothing');

// keySlotFor: one secret slot per place the key belongs to.
ok(keySlotFor('anthropic', '') === 'deskfish.apiKey.anthropic' && keySlotFor('anthropic', 'https://x') === 'deskfish.apiKey.anthropic', 'keySlotFor: anthropic has one slot');
ok(keySlotFor('openai-compatible', 'https://OpenRouter.ai/api/v1') === 'deskfish.apiKey.openrouter.ai' && keySlotFor('openai-compatible', 'https://api.x.ai/v1') === 'deskfish.apiKey.api.x.ai' && keySlotFor('openai-compatible', 'https://api.moonshot.ai/v1') === 'deskfish.apiKey.api.moonshot.ai', 'keySlotFor: one slot per host, lower-cased');
ok(keySlotFor('mock', '') === undefined && keySlotFor('openai-compatible', 'not a url') === undefined && keySlotFor('openai-compatible', '') === undefined, 'keySlotFor: none for the demo model or an unparseable URL');
ok(keySlotFor('openai-compatible', 'https://api.x.ai/v1', 'xai-oauth') === 'deskfish.oauth.api.x.ai' && keySlotFor('openai-compatible', 'https://api.x.ai/v1', '') === 'deskfish.apiKey.api.x.ai', 'keySlotFor: the sign-in has a slot of its own, so signing out does not touch an xAI API key');
ok(keySlotFor('anthropic', '', 'xai-oauth') === 'deskfish.apiKey.anthropic' && keySlotFor('mock', '', 'xai-oauth') === undefined, 'keySlotFor: Anthropic and the demo model ignore `auth` — neither can be signed into');
ok(isOauthSlot('deskfish.oauth.api.x.ai') && !isOauthSlot('deskfish.apiKey.api.x.ai') && !isOauthSlot('deskfish.apiKey.anthropic'), 'isOauthSlot: tokens and pasted keys are told apart by their slot name');

// isLocalEndpoint: local hosts need no key.
// (Not asserted: 'http://[::1]:4000/v1' — URL.hostname keeps the brackets, so the '::1' branch never matches; see the report.)
ok(isLocalEndpoint('http://localhost:11434/v1') && isLocalEndpoint('http://127.0.0.1:4000/v1') && isLocalEndpoint('http://tank.local/v1'), 'isLocalEndpoint: localhost, 127.0.0.1 and .local are local');
ok(!isLocalEndpoint('https://openrouter.ai/api/v1') && !isLocalEndpoint('https://api.x.ai/v1') && !isLocalEndpoint('garbage') && !isLocalEndpoint(''), 'isLocalEndpoint: remote hosts and garbage are not');
// Until the Grok sign-in there was one reason to need no key: the endpoint is on this machine.
// Now there are two, and the second one must say so — a remote preset that asks for nothing at all
// would be a preset she could never authenticate with.
ok(PRESETS.filter((p) => p.provider === 'openai-compatible' && !p.needsKey).every((p) => isLocalEndpoint(p.baseUrl) || !!p.auth), 'presets agree: an OpenAI-compatible preset needs no key only when it is local or it signs in');
ok(PRESETS.filter((p) => p.provider === 'openai-compatible' && p.baseUrl && p.needsKey).every((p) => !isLocalEndpoint(p.baseUrl)), 'presets agree: a preset that asks for a key is remote');

console.log(`presets: ${n} checks passed`);
