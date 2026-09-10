import { AnthropicAdapter } from './anthropic';
import { MockAdapter } from './mock';
import { OpenAICompatAdapter } from './openaiCompat';
import type { AdapterConfig, ModelAdapter } from './types';

export type { AdapterConfig, ModelAdapter, ModelTurn, Observation } from './types';

/**
 * The model-adapter layer is the part that makes "any LLM" real: each adapter speaks one
 * provider's dialect (message shapes, tool-call format, image encoding, quirks) and exposes the
 * same `ModelAdapter` interface to the loop. Add a provider by adding a file here.
 */
export function createAdapter(cfg: AdapterConfig): ModelAdapter {
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicAdapter(cfg);
    case 'openai-compatible':
      return new OpenAICompatAdapter(cfg);
    case 'mock':
      return new MockAdapter();
    default:
      throw new Error(`unknown provider ${String((cfg as { provider: unknown }).provider)}`);
  }
}
