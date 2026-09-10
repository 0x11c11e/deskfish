import type { ActionResult, ComputerAction } from '../../computer/types';
import type { ScaledImage } from '../../image/resize';

/** What the loop hands the model each turn: the screen, plus results of the model's last actions. */
export interface Observation {
  image: ScaledImage;
  /** One result per action the adapter returned last turn, in order. Empty on the first turn. */
  results: ActionResult[];
  /** Optional out-of-band note, e.g. "the user took over the desktop and made changes". */
  note?: string;
}

/** What the model wants next. */
export interface ModelTurn {
  /** Free-text commentary or the final summary. */
  text?: string;
  /** Actions to execute, in order. Coordinates are in *scaled screenshot* pixels. */
  actions: ComputerAction[];
  /** True when the model ended its turn without requesting any action — the task is finished (or it gave up). */
  done: boolean;
  /** Tokens for this turn. `input` = uncached input; cacheRead/cacheWrite = prompt-cache hits and writes (Anthropic). */
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; /** Cost in USD as reported by the provider (OpenRouter), when it reports one. */ costUsd?: number };
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
}

export function describeResult(r: ActionResult): string {
  if (!r.ok) return `error: ${r.error ?? 'unknown'}`;
  if (r.message) return r.message;
  if (r.cursor) return `ok, cursor at (${r.cursor.x}, ${r.cursor.y})`;
  return 'ok';
}
