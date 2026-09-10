/**
 * List prices (USD per million tokens) for the models Deskfish can name. Used for the cost
 * readout in the chat and for the optional per-task cost budget. Unknown models: no price, so
 * no estimate and no budget (a token count is still shown). Pure Node — shared with the webview.
 */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES: Array<[RegExp, Price]> = [
  [/claude-fable/, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  [/claude-opus-5|claude-opus-4/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/claude-sonnet-5/, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  [/claude-sonnet-4/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/claude-haiku-4-5/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
];

export function priceFor(model: string | undefined): Price | undefined {
  if (!model) return undefined;
  return PRICES.find(([re]) => re.test(model))?.[1];
}

export function costUsd(u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, p: Price): number {
  return (u.input * p.input + u.output * p.output + (u.cacheRead ?? 0) * p.cacheRead + (u.cacheWrite ?? 0) * p.cacheWrite) / 1e6;
}
