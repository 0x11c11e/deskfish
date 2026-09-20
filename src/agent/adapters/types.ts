import type { ActionResult, ComputerAction } from '../../computer/types';
import type { ScaledImage } from '../../image/resize';

/**
 * The provider says the subscription pool behind a "sign in" credential is spent (xAI: HTTP 429, or
 * 403 with "run out of available resources"). Not an error the task dies of and never a silent
 * switch to an API key — the loop knocks on the glass with it and waits for the person.
 */
export class PoolExhaustedError extends Error {
  readonly poolExhausted = true;
  constructor(message: string) {
    super(message);
    this.name = 'PoolExhaustedError';
  }
}

/**
 * Recognise it by its marker rather than by `instanceof`: the bundle and a `tsx`-loaded copy of this
 * module are two different classes, and a knock must not turn back into an error because of which
 * loader ran. (Found by `oauth.test.mts`, where the `.mts` suite and the `.ts` adapter each got one.)
 */
export function isPoolExhaustedError(err: unknown): err is PoolExhaustedError {
  return !!err && typeof err === 'object' && (err as { poolExhausted?: unknown }).poolExhausted === true;
}

/** What the loop hands the model each turn: the screen, plus results of the model's last actions. */
export interface Observation {
  /**
   * Absent when the last batch could not have changed the screen (a find, a read_page, a zoom, a
   * memory call): no screenshot was taken and the adapter says so in words instead of sending the
   * same picture again. Always present on the first observation of a task and after any batch that
   * acted.
   */
  image?: ScaledImage;
  /** One result per action the adapter returned last turn, in order. Empty on the first turn. */
  results: ActionResult[];
  /** Optional out-of-band note, e.g. "the user took over the desktop and made changes". */
  note?: string;
}

/**
 * What an image-less observation says in place of the screenshot. Both wires send the same
 * sentence: nothing *she* did could have changed the screen, so the picture she has still stands.
 * It does not claim the world held still — a page can finish loading, a reply can arrive — and the
 * prompt tells her to ask for a screenshot or wait_for when she expects that. (The last screenshot
 * is still in the conversation — images are pruned to the newest three — so "your last screenshot"
 * is something she can actually look at.)
 */
export const SCREEN_UNCHANGED_NOTE =
  'No new screenshot: nothing you just did could have changed the screen, so your last screenshot still stands.';

/** What the model wants next. */
export interface ModelTurn {
  /** Free-text commentary or the final summary. */
  text?: string;
  /** Actions to execute, in order. Coordinates are in *scaled screenshot* pixels. */
  actions: ComputerAction[];
  /** True when the model ended its turn without requesting any action — the task is finished (or it gave up). */
  done: boolean;
  /** Tokens for this turn. `input` = uncached input; cacheRead/cacheWrite = prompt-cache hits and writes (Anthropic). */
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; /** Of the cache writes, those with the 1-hour TTL (billed at 2× input instead of 1.25×). */ cacheWrite1h?: number; /** Cost in USD as reported by the provider (OpenRouter), when it reports one. */ costUsd?: number };
}

/**
 * A model adapter owns the conversation with one LLM provider. It receives observations and returns
 * turns; the loop never sees provider-specific message formats.
 */
export interface ModelAdapter {
  readonly name: string;
  /** Reset the conversation for a new task. `screen` is the size of the screenshots the model will see. */
  start(task: string, screen: { width: number; height: number }): void;
  /** Deliver the observation for the previous turn's actions and get the next turn. */
  step(obs: Observation, signal?: AbortSignal): Promise<ModelTurn>;
  /** Queue a user message to be delivered with the next observation. */
  addUserMessage(text: string): void;
  /** Re-read the notes provider (memory, self, journal) into the system prompt; the loop calls it at every run start. */
  refreshNotes?(): void;
  /**
   * Re-read the live notes WITHOUT rebuilding the system prompt (which would invalidate the cached
   * conversation), and say what changed since it was built — for the next observation note.
   */
  notesDelta?(): string | undefined;
}

/** What the loop's stores contribute to the system prompt; read fresh at the start of every run. */
export interface AgentNotes {
  /** Rendered long-term facts ('' when none). When defined, remember/forget are offered. */
  memory?: string;
  /** The self file's text. When defined, revise_self/restore_self/recall/note_to_self are offered. */
  self?: string;
  selfStatus?: 'ok' | 'tampered';
  /** The last version the bot signed itself, when the file is tampered. */
  selfLastSigned?: string;
  /** Rendered recent journal entries ('' when none). */
  journal?: string;
  /** Titles of the bot's playbooks ('' when none). When defined, save_playbook/read_playbook are offered. */
  playbooks?: string;
  /** The maker's charter (not the bot's to edit); placed just before the self. */
  charter?: string;
}

export interface AdapterConfig {
  provider: 'openai-compatible' | 'anthropic' | 'mock';
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /**
   * A credential that is fetched per call rather than pasted once: "Sign in with Grok" hands the
   * adapter this instead of `apiKey`, and the gateway refreshes behind it. `force` asks for a fresh
   * one after a 401, so a token that expired mid-task costs one retry and not the task.
   */
  bearer?: (force?: boolean) => Promise<string>;
  /** Anthropic workspace ID; identity-linked API keys must name the workspace they act in. */
  workspaceId?: string;
  systemPrompt?: string;
  /** `free` (default): the tank is the boundary, no Deskfish-imposed rules. `guided`: ask before anything irreversible. */
  autonomy?: 'free' | 'guided';
  /** How many recent screenshots to keep in the conversation (older ones are dropped to save tokens). */
  maxImages?: number;
  /** One-line-per-page index of the bot's documentation; when set, the read_docs tool is offered. */
  docsIndex?: string;
  /** Rendered long-term memories ('' when empty); when defined, the remember/forget tools are offered. */
  memoryNote?: string;
  /** Live notes (memory, self, journal); takes precedence over memoryNote and is re-read at every run start. */
  notes?: () => AgentNotes;
  /**
   * OpenAI-compatible endpoints only: mark the system prompt and the newest user message with
   * Anthropic-style `cache_control` breakpoints. `auto` (default) does it for openrouter.ai, whose
   * API translates them for Anthropic and Gemini models; `on` for any gateway that passes them
   * through (LiteLLM); `off` for strict endpoints that reject unknown fields.
   */
  promptCaching?: 'auto' | 'on' | 'off';
  /**
   * OpenAI-compatible endpoints only: the sampling temperature to send. Unset (default) sends
   * none, so every model runs at its provider default — reasoning models (kimi-k3, GPT-5) refuse
   * any other value with HTTP 400.
   */
  temperature?: number;
  /** Anthropic: prompt-cache TTL. `1h` (default) survives the pauses between a person's messages and a standby; `5m` is the cheaper write for back-to-back requests. */
  cacheTtl?: '5m' | '1h';
  /** Anthropic: how hard the model thinks per turn (`output_config.effort`). Unset = the provider's default (high). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** How many long tool results (page text, command output) stay whole in the conversation; older ones shrink to a line. */
  maxTextResults?: number;
}

export function describeResult(r: ActionResult): string {
  if (!r.ok) return `error: ${r.error ?? 'unknown'}`;
  if (r.message) return r.message;
  if (r.cursor) return `ok, cursor at (${r.cursor.x}, ${r.cursor.y})`;
  return 'ok';
}
