/**
 * List prices (USD per million tokens) for the models Deskfish can name. Used for the cost
 * readout in the chat, for the optional per-task cost budget and for the journal line. Unknown
 * models: no price, so no estimate and no budget (a token count is still shown). Pure Node —
 * shared with the webview.
 *
 * A row is priced only where its list price applies: Claude rows for the `anthropic` provider
 * (directly or through a gateway that bills at Anthropic's rates), Moonshot rows only when the
 * base URL is Moonshot's own API — a `kimi-k3` served by a local vLLM or Ollama costs nothing,
 * and OpenRouter reports its own charge (`usage.cost`), which the loop prefers over any estimate.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PriceRow {
  model: RegExp;
  price: Price;
  /** When set, the row applies only to base URLs on this host (OpenAI-compatible providers). */
  host?: RegExp;
}

const MOONSHOT = /(^|\.)api\.moonshot\.(ai|cn)$/i;

export const PRICES: PriceRow[] = [
  { model: /claude-fable/, price: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  { model: /claude-opus-5|claude-opus-4/, price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { model: /claude-sonnet-5/, price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { model: /claude-sonnet-4/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { model: /claude-haiku-4-5/, price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  // Moonshot AI (platform.kimi.ai/docs/pricing/chat, 2026-09-13). Its prefix cache is automatic
  // and has no write surcharge, so cacheWrite = input; the adapter never reports one anyway.
  { model: /kimi-k3/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 }, host: MOONSHOT },
  { model: /kimi-k2\.7-code-highspeed/, price: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 1.9 }, host: MOONSHOT },
  { model: /kimi-k2\.7-code/, price: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0.95 }, host: MOONSHOT },
  { model: /kimi-k2\.6/, price: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0.95 }, host: MOONSHOT },
];

/** The list price of a model by name alone (Claude rows only; host-scoped rows need `priceForConfig`). */
export function priceFor(model: string | undefined): Price | undefined {
  if (!model) return undefined;
  return PRICES.find((r) => !r.host && r.model.test(model))?.price;
}

function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

/**
 * The list price that applies to a configured provider, if any: Claude rows for `anthropic`,
 * host-scoped rows for an OpenAI-compatible endpoint on that host, nothing for the demo model or
 * for endpoints whose rates Deskfish does not know.
 */
export function priceForConfig(cfg: { provider: string; model: string; baseUrl?: string }): Price | undefined {
  if (cfg.provider === 'anthropic') return priceFor(cfg.model);
  if (cfg.provider !== 'openai-compatible' || !cfg.model) return undefined;
  const host = hostOf(cfg.baseUrl);
  if (!host) return undefined;
  return PRICES.find((r) => r.host?.test(host) && r.model.test(cfg.model))?.price;
}

export function costUsd(u: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number }, p: Price): number {
  // Cache writes: 1.25× input for the 5-minute TTL (the row's cacheWrite), 2× input for the 1-hour TTL.
  const long = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite ?? 0);
  const short = (u.cacheWrite ?? 0) - long;
  return (u.input * p.input + u.output * p.output + (u.cacheRead ?? 0) * p.cacheRead + short * p.cacheWrite + long * p.input * 2) / 1e6;
}
