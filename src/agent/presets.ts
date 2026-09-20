/**
 * Where a model comes from: the choices behind the "Change" button and the command palette's
 * "Choose Model…", so nobody has to know base URLs. Pure data (no `vscode`), so it is testable
 * and reusable by the headless runner. Model lists are suggestions — every preset also accepts a
 * typed name — and the slugs follow each provider's naming at the time of writing.
 */

export type ProviderName = 'anthropic' | 'openai-compatible' | 'mock';

export interface Preset {
  id: string;
  label: string;
  detail: string;
  provider: ProviderName;
  /** '' for Anthropic direct (SDK default) and for the demo model. */
  baseUrl: string;
  /** Suggested models, best first; empty when the endpoint decides (LiteLLM, custom). */
  models: { name: string; note?: string }[];
  needsKey: boolean;
  /** Asked for when the preset has no fixed base URL. */
  askBaseUrl?: boolean;
  /**
   * This preset signs in instead of taking a key: the credential is an OAuth token pair the gateway
   * keeps and refreshes (`deskfish.oauth.<host>`), not a string the person pastes. Today only xAI
   * offers one to outside apps; Anthropic forbids it and OpenAI documents it for Codex alone.
   */
  auth?: 'xai-oauth';
}

/**
 * The Grok models the xAI endpoint serves to both of its presets, best first. Checked against
 * `GET https://api.x.ai/v1/language-models` on 2026-09-18 with a subscription token: seven ids,
 * every one of them text+image (the three `grok-4.20-0309-*` are listed here under their alias).
 */
const XAI_MODELS: { name: string; note?: string }[] = [
  { name: 'grok-4.6', note: 'best results' },
  { name: 'grok-4.5' },
  { name: 'grok-4.3', note: 'cheaper' },
  { name: 'grok-4.20', note: 'cheaper, 1M context' },
  { name: 'grok-build-0.1', note: 'the model behind Grok Build' },
];

export const PRESETS: Preset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (direct)',
    detail: 'Recommended: Claude with its native computer-use tool, the most precise clicks. Needs an Anthropic API key.',
    provider: 'anthropic',
    baseUrl: '',
    models: [
      { name: 'claude-opus-5', note: 'best results' },
      { name: 'claude-sonnet-5', note: 'faster and cheaper' },
    ],
    needsKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    detail: 'One key, many models. Claude and Gemini get prompt caching here; clicks are a little less precise than direct.',
    provider: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { name: 'anthropic/claude-opus-5', note: 'best results' },
      { name: 'anthropic/claude-sonnet-5', note: 'faster and cheaper' },
      { name: 'google/gemini-2.5-pro', note: 'good vision, cached' },
      { name: 'openai/gpt-5', note: 'caches automatically' },
      { name: 'moonshotai/kimi-k3', note: 'Kimi (Moonshot AI, Beijing) — hosted through OpenRouter, your key stays with OpenRouter' },
    ],
    needsKey: true,
  },
  {
    id: 'xai-subscription',
    label: 'xAI (Grok) — sign in with your SuperGrok',
    detail: 'Her calls draw the weekly pool your SuperGrok plan already pays for, instead of billing an xAI API key. xAI decides which accounts get sign-in tokens.',
    provider: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    models: XAI_MODELS,
    needsKey: false,
    auth: 'xai-oauth',
  },
  {
    id: 'xai',
    label: 'xAI (Grok) — API key',
    detail: 'Grok through the xAI API, billed per token. Needs an xAI key.',
    provider: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    models: XAI_MODELS,
    needsKey: true,
  },
  {
    id: 'moonshot',
    label: 'Moonshot AI (Kimi, direct)',
    detail: 'Kimi from Moonshot AI, Beijing. Your key and everything on screen go to their servers; through OpenRouter they would not. Needs a Moonshot key.',
    provider: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: [
      { name: 'kimi-k3', note: 'flagship, vision + tools, 1M context' },
      { name: 'kimi-k2.6', note: 'vision + tools' },
    ],
    needsKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (local, no key)',
    detail: 'A model running on this machine. Only vision models with tool calling can drive a desktop; small ones misclick often.',
    provider: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    models: [{ name: 'llama3.2-vision' }],
    needsKey: false,
  },
  {
    id: 'litellm',
    label: 'LiteLLM proxy (local)',
    detail: 'One local URL in front of many providers; model names come from its config. Set deskfish.promptCaching to "on" for Anthropic models behind it.',
    provider: 'openai-compatible',
    baseUrl: 'http://localhost:4000/v1',
    models: [],
    needsKey: false,
  },
  {
    id: 'custom',
    label: 'Other OpenAI-compatible endpoint…',
    detail: 'vLLM, a hosted gateway, anything with /chat/completions, vision and tool calling.',
    provider: 'openai-compatible',
    baseUrl: '',
    models: [],
    needsKey: true,
    askBaseUrl: true,
  },
  {
    id: 'mock',
    label: 'Demo model (no key)',
    detail: 'A scripted fake model to see the desktop, the chat and the hand-over without spending anything.',
    provider: 'mock',
    baseUrl: '',
    models: [{ name: 'mock' }],
    needsKey: false,
  },
];

/**
 * The preset a saved configuration corresponds to, if any (by provider and base URL). Two presets
 * may share a base URL when one of them signs in — xAI has both — so `auth` picks between them.
 */
export function presetFor(provider: ProviderName, baseUrl: string, auth: '' | 'xai-oauth' = ''): Preset | undefined {
  const url = baseUrl.trim().replace(/\/+$/, '');
  if (provider === 'mock') return PRESETS.find((p) => p.id === 'mock');
  if (provider === 'anthropic') return PRESETS.find((p) => p.id === 'anthropic');
  const here = PRESETS.filter((p) => p.provider === 'openai-compatible' && p.baseUrl && p.baseUrl.replace(/\/+$/, '') === url);
  return here.find((p) => (p.auth ?? '') === auth) ?? here[0];
}

/**
 * One secret slot per place the credential belongs to, so switching between OpenRouter and Anthropic
 * does not throw the other key away: `deskfish.apiKey.anthropic`, `deskfish.apiKey.openrouter.ai`, …
 * A signed-in endpoint has a slot of its own (`deskfish.oauth.api.x.ai`), so signing out of Grok
 * leaves an xAI API key that was there before untouched.
 */
export function keySlotFor(provider: ProviderName, baseUrl: string, auth: '' | 'xai-oauth' = ''): string | undefined {
  if (provider === 'mock') return undefined;
  if (provider === 'anthropic') return 'deskfish.apiKey.anthropic';
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (!host) return undefined;
    return auth ? `deskfish.oauth.${host}` : `deskfish.apiKey.${host}`;
  } catch {
    return undefined;
  }
}

/** True for a slot that holds signed-in tokens rather than a pasted key. */
export function isOauthSlot(slot: string): boolean {
  return slot.startsWith('deskfish.oauth.');
}

/** Local endpoints need no key. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    // URL.hostname keeps the brackets around an IPv6 literal ("[::1]").
    const host = new URL(baseUrl).hostname.replace(/^\[(.*)\]$/, '$1');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  } catch {
    return false;
  }
}
