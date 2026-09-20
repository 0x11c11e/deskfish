import {
  ASK_USER_TOOL_DESCRIPTION,
  ASK_USER_TOOL_NAME,
  ASK_USER_TOOL_PARAMETERS,
  COMPUTER_TOOL_DESCRIPTION,
  COMPUTER_TOOL_NAME,
  COMPUTER_TOOL_PARAMETERS,
  FORGET_TOOL_DESCRIPTION,
  FORGET_TOOL_NAME,
  FORGET_TOOL_PARAMETERS,
  READ_DOCS_TOOL_DESCRIPTION,
  READ_DOCS_TOOL_NAME,
  CLICK_ELEMENT_TOOL_DESCRIPTION,
  CLICK_ELEMENT_TOOL_NAME,
  CLICK_ELEMENT_TOOL_PARAMETERS,
  clickElementAction,
  FIND_TOOL_NAME,
  FIND_TOOL_DESCRIPTION,
  FIND_TOOL_PARAMETERS,
  findAction,
  READ_PAGE_TOOL_NAME,
  WAIT_FOR_TOOL_NAME,
  WAIT_FOR_TOOL_DESCRIPTION,
  WAIT_FOR_TOOL_PARAMETERS,
  waitForAction,
  RUN_COMMAND_TOOL_NAME,
  RUN_COMMAND_TOOL_DESCRIPTION,
  RUN_COMMAND_TOOL_PARAMETERS,
  runCommandAction,
  READ_PAGE_TOOL_DESCRIPTION,
  READ_PAGE_TOOL_PARAMETERS,
  readPageAction,
  READ_DOCS_TOOL_PARAMETERS,
  REMEMBER_TOOL_DESCRIPTION,
  REMEMBER_TOOL_NAME,
  REMEMBER_TOOL_PARAMETERS,
  askUserAction,
  forgetAction,
  readDocsAction,
  rememberAction,
  RECALL_TOOL_DESCRIPTION,
  RECALL_TOOL_NAME,
  RECALL_TOOL_PARAMETERS,
  RESTORE_SELF_TOOL_DESCRIPTION,
  RESTORE_SELF_TOOL_NAME,
  RESTORE_SELF_TOOL_PARAMETERS,
  REVISE_SELF_TOOL_DESCRIPTION,
  REVISE_SELF_TOOL_NAME,
  REVISE_SELF_TOOL_PARAMETERS,
  NOTE_TOOL_DESCRIPTION,
  NOTE_TOOL_NAME,
  NOTE_TOOL_PARAMETERS,
  noteAction,
  recallAction,
  restoreSelfAction,
  SELF_HISTORY_TOOL_DESCRIPTION,
  SELF_HISTORY_TOOL_NAME,
  ARCHIVE_STORY_TOOL_NAME,
  ARCHIVE_STORY_TOOL_DESCRIPTION,
  ARCHIVE_STORY_TOOL_PARAMETERS,
  archiveStoryAction,
  SELF_HISTORY_TOOL_PARAMETERS,
  selfHistoryAction,
  reviseSelfAction,
  SAVE_PLAYBOOK_TOOL_DESCRIPTION,
  SAVE_PLAYBOOK_TOOL_NAME,
  SAVE_PLAYBOOK_TOOL_PARAMETERS,
  READ_PLAYBOOK_TOOL_DESCRIPTION,
  READ_PLAYBOOK_TOOL_NAME,
  READ_PLAYBOOK_TOOL_PARAMETERS,
  savePlaybookAction,
  readPlaybookAction,
  toComputerAction,
} from '../actions';
import { charterNote, docsNote, journalNote, memoryNote, modelNote, playbookNote, screenNote, selfNote, systemPrompt, tankNote } from '../prompts';
import { diffNotes } from '../notesDelta';
import { KEEP_LONG_RESULTS, PRUNE_TEXT_BATCH, isLongResult, shortenResult } from '../prune';
import type { AgentNotes } from './types';
import type { ComputerAction } from '../../computer/types';
import { describeResult, PoolExhaustedError, SCREEN_UNCHANGED_NOTE, type AdapterConfig, type ModelAdapter, type ModelTurn, type Observation } from './types';

/**
 * Adapter for any OpenAI-compatible `/chat/completions` endpoint that supports vision and tool
 * calling: LiteLLM proxy (which fronts 100+ providers), xAI, OpenRouter, Ollama, vLLM, …
 *
 * Conversation shape per turn:
 *   assistant: tool_calls[computer(...), computer(...)]
 *   tool:      "ok" / "error: …"            (one per call — the tool role only carries text)
 *   user:      [text "Screenshot after those actions", image_url data:image/jpeg]
 */

type CacheControl = { type: 'ephemeral' };
type ContentPart = { type: 'text'; text: string; cache_control?: CacheControl } | { type: 'image_url'; image_url: { url: string } };

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface PendingCall {
  id: string;
  /** Set when the call could not be parsed; reported back instead of an execution result. */
  parseError?: string;
}

export class OpenAICompatAdapter implements ModelAdapter {
  readonly name = 'openai-compatible';
  private messages: ChatMessage[] = [];
  private pending: PendingCall[] = [];
  private queuedUser: string[] = [];
  private task = '';
  private first = true;
  private readonly maxImages: number;
  private notes: AgentNotes = {};
  private screen = { width: 1280, height: 720 };

  constructor(private readonly cfg: AdapterConfig) {
    this.maxImages = cfg.maxImages ?? 3;
    if (!cfg.baseUrl) throw new Error('openai-compatible provider needs a base URL');
  }

  start(task: string, screen: { width: number; height: number }): void {
    this.task = task;
    this.first = true;
    this.pending = [];
    this.queuedUser = [];
    this.screen = screen;
    this.messages = [{ role: 'system', content: '' }];
    this.refreshNotes();
  }

  /** (Re)build the system message from the fixed parts and the live notes (memory, self, journal). */
  refreshNotes(): void {
    this.notes = this.cfg.notes?.() ?? { memory: this.cfg.memoryNote };
    const n = this.notes;
    const system = [
      this.cfg.systemPrompt ?? systemPrompt(this.cfg.autonomy),
      tankNote(),
      modelNote(this.cfg),
      n.charter ? charterNote(n.charter) : '',
      n.self !== undefined ? selfNote(n.self, n.selfStatus, n.selfLastSigned) : '',
      screenNote(this.screen),
      this.cfg.docsIndex ? docsNote(this.cfg.docsIndex) : '',
      n.memory !== undefined ? memoryNote(n.memory) : '',
      n.self !== undefined ? journalNote(n.journal ?? '') : '',
      n.playbooks !== undefined ? playbookNote(n.playbooks) : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (this.messages.length && this.messages[0].role === 'system') this.messages[0] = { role: 'system', content: system };
    else this.messages.unshift({ role: 'system', content: system });
  }

  /** What changed in the notes since the system message was built, without touching that message (it is the cached prefix). */
  notesDelta(): string | undefined {
    if (!this.cfg.notes) return undefined;
    const next = this.cfg.notes();
    const delta = diffNotes(this.notes, next);
    this.notes = next;
    return delta;
  }

  addUserMessage(text: string): void {
    this.queuedUser.push(text);
  }

  private signal?: AbortSignal;

  async step(obs: Observation, signal?: AbortSignal): Promise<ModelTurn> {
    this.signal = signal;
    // Absent after a batch that could not have changed the screen: the message then carries the
    // results and one sentence saying so, and the picture she already has stands (see A, decision 123).
    const image: ContentPart | undefined = obs.image
      ? { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${obs.image.jpeg.toString('base64')}` } }
      : undefined;
    const extras = [obs.note, ...this.queuedUser.map((t) => `User: ${t}`)].filter(Boolean).join('\n');
    // Everything pushed below belongs to *this* call. If the call never gets an answer — the
    // subscription's pool refused it and the loop knocks, then tries the same step again — the
    // retry pushes it all afresh, so the failed attempt must leave no trace: no second copy of the
    // tool results (a malformed conversation) and no lost queued user text.
    const mark = this.messages.length;
    const wasFirst = this.first;
    const queued = this.queuedUser;
    this.queuedUser = [];

    if (this.first) {
      this.first = false;
      // The run-start note (clock, network mode, a continuation ledger) rides on the first message too.
      this.messages.push({
        role: 'user',
        content: [{ type: 'text', text: `Task: ${this.task}\n\nHere is the current screen.${extras ? `\n\n${extras}` : ''}` }, ...(image ? [image] : [])],
      });
    } else {
      // The tool role only carries text, so a zoom result's magnified view rides in the user
      // message below, ahead of the regular after-batch screenshot.
      const zoomViews: ContentPart[] = [];
      this.pending.forEach((call, i) => {
        const r = obs.results[i] ?? { ok: false, error: 'no result' };
        const result = call.parseError ? `error: ${call.parseError}` : describeResult(r);
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        if (!call.parseError && r.image) {
          zoomViews.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${r.image.jpeg.toString('base64')}` } });
        }
      });
      const parts: ContentPart[] = [];
      if (zoomViews.length) parts.push({ type: 'text', text: 'Magnified view from your zoom action:' }, ...zoomViews);
      parts.push({ type: 'text', text: `${image ? 'Screenshot after those actions.' : SCREEN_UNCHANGED_NOTE}${extras ? `\n${extras}` : ''}` });
      if (image) parts.push(image);
      this.messages.push({ role: 'user', content: parts });
    }
    this.pruneImages();
    this.pruneText();

    let response: any;
    try {
      response = await this.chat();
    } catch (err) {
      this.messages.length = mark;
      this.first = wasFirst;
      this.queuedUser = queued;
      throw err;
    }
    let msg = response.choices?.[0]?.message;
    if (!msg) throw new Error('provider returned no choices');
    // Cut off at the token limit with nothing said and nothing called: ask once for the rest,
    // then fail loudly rather than end the task in silence.
    if (response.choices?.[0]?.finish_reason === 'length' && !msg.tool_calls?.length && !(typeof msg.content === 'string' && msg.content.trim())) {
      this.messages.push({ role: 'assistant', content: '' });
      this.messages.push({ role: 'user', content: 'Your reply was cut off at the token limit before you said or did anything. Continue, briefly: the next action, or the summary.' });
      response = await this.chat();
      msg = response.choices?.[0]?.message;
      if (!msg) throw new Error('provider returned no choices');
      if (!msg.tool_calls?.length && !(typeof msg.content === 'string' && msg.content.trim())) {
        throw new Error('The model ran out of output tokens twice without answering. Try a model that reasons less, or a larger max_tokens on the endpoint.');
      }
    }
    const toolCalls: ToolCall[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    this.messages.push({ role: 'assistant', content: msg.content ?? '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    const actions: ComputerAction[] = [];
    this.pending = [];
    for (const call of toolCalls) {
      const entry: PendingCall = { id: call.id };
      try {
        const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        if (call.function?.name === COMPUTER_TOOL_NAME) actions.push(toComputerAction(args));
        else if (call.function?.name === ASK_USER_TOOL_NAME) actions.push(askUserAction(args));
        else if (call.function?.name === READ_DOCS_TOOL_NAME) actions.push(readDocsAction(args));
        else if (call.function?.name === FIND_TOOL_NAME) actions.push(findAction(args));
        else if (call.function?.name === CLICK_ELEMENT_TOOL_NAME) actions.push(clickElementAction(args));
        else if (call.function?.name === READ_PAGE_TOOL_NAME) actions.push(readPageAction(args));
        else if (call.function?.name === WAIT_FOR_TOOL_NAME) actions.push(waitForAction(args));
        else if (call.function?.name === RUN_COMMAND_TOOL_NAME) actions.push(runCommandAction(args));
        else if (call.function?.name === REMEMBER_TOOL_NAME) actions.push(rememberAction(args));
        else if (call.function?.name === FORGET_TOOL_NAME) actions.push(forgetAction(args));
        else if (call.function?.name === REVISE_SELF_TOOL_NAME) actions.push(reviseSelfAction(args));
        else if (call.function?.name === RESTORE_SELF_TOOL_NAME) actions.push(restoreSelfAction(args));
        else if (call.function?.name === SELF_HISTORY_TOOL_NAME) actions.push(selfHistoryAction(args));
        else if (call.function?.name === ARCHIVE_STORY_TOOL_NAME) actions.push(archiveStoryAction(args));
        else if (call.function?.name === RECALL_TOOL_NAME) actions.push(recallAction(args));
        else if (call.function?.name === NOTE_TOOL_NAME) actions.push(noteAction(args));
        else if (call.function?.name === SAVE_PLAYBOOK_TOOL_NAME) actions.push(savePlaybookAction(args));
        else if (call.function?.name === READ_PLAYBOOK_TOOL_NAME) actions.push(readPlaybookAction(args));
        else throw new Error(`unknown tool ${call.function?.name}`);
      } catch (err) {
        entry.parseError = err instanceof Error ? err.message : String(err);
        actions.push({ type: 'screenshot' }); // placeholder keeps results aligned with calls
      }
      this.pending.push(entry);
    }

    const usage = response.usage
      ? {
          input: Number(response.usage.prompt_tokens ?? 0) - Number(response.usage.prompt_tokens_details?.cached_tokens ?? 0),
          output: Number(response.usage.completion_tokens ?? 0),
          cacheRead: Number(response.usage.prompt_tokens_details?.cached_tokens ?? 0),
          // OpenRouter (usage.include) reports the charge for the request in USD.
          ...(typeof response.usage.cost === 'number' ? { costUsd: response.usage.cost } : {}),
        }
      : undefined;
    const text = typeof msg.content === 'string' && msg.content.trim() ? msg.content.trim() : undefined;
    return { text, actions, done: toolCalls.length === 0, usage };
  }

  /**
   * Keep only recent screenshots; replace older image parts with a short note. Pruned in batches
   * (see the Anthropic adapter) so providers that cache prompt prefixes keep their hits.
   */
  private pruneImages(): void {
    const PRUNE_BATCH = 5;
    let count = 0;
    for (const m of this.messages) if (Array.isArray(m.content)) count += m.content.filter((p) => p.type === 'image_url').length;
    if (count <= this.maxImages + PRUNE_BATCH) return;
    let seen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (!Array.isArray(m.content)) continue;
      for (let j = m.content.length - 1; j >= 0; j--) {
        if (m.content[j].type !== 'image_url') continue;
        seen++;
        if (seen > this.maxImages) {
          m.content[j] = { type: 'text', text: '[earlier screenshot omitted]' };
        }
      }
    }
  }

  /** Older long tool results shrink to their first line, in batches (see ../prune.ts and the Anthropic adapter). */
  private pruneText(): void {
    const keep = this.cfg.maxTextResults ?? KEEP_LONG_RESULTS;
    const long = this.messages.filter((m) => m.role === 'tool' && typeof m.content === 'string' && isLongResult(m.content));
    if (long.length <= keep + PRUNE_TEXT_BATCH) return;
    for (const m of long.slice(0, long.length - keep)) m.content = shortenResult(m.content as string);
  }

  /** Whether to send Anthropic-style cache breakpoints (see AdapterConfig.promptCaching). */
  private cacheMarks(): boolean {
    const mode = this.cfg.promptCaching ?? 'auto';
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return /openrouter\.ai/i.test(this.cfg.baseUrl ?? '');
  }

  private isOpenRouter(): boolean {
    return /openrouter\.ai/i.test(this.cfg.baseUrl ?? '');
  }

  /**
   * A copy of the conversation with two breakpoints: the system prompt, and the last text part
   * of the newest user message. The stored messages stay clean; the breakpoint moves every turn,
   * so the whole prefix up to the previous turn is a cache hit on providers that honour it
   * (the same scheme as the Anthropic adapter's moveCacheBreakpoint).
   */
  private withCacheMarks(): ChatMessage[] {
    const mark: CacheControl = { type: 'ephemeral' };
    const out = this.messages.map((m) => ({ ...m }));
    if (out.length && out[0].role === 'system') {
      const text = typeof out[0].content === 'string' ? out[0].content : (out[0].content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
      out[0] = { role: 'system', content: [{ type: 'text', text, cache_control: mark }] };
    }
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role !== 'user') continue;
      const c = out[i].content;
      const parts: ContentPart[] = typeof c === 'string' ? [{ type: 'text', text: c }] : (c ?? []).map((p) => ({ ...p }));
      for (let j = parts.length - 1; j >= 0; j--) {
        if (parts[j].type === 'text') {
          (parts[j] as { cache_control?: CacheControl }).cache_control = mark;
          break;
        }
      }
      out[i] = { ...out[i], content: parts };
      break;
    }
    return out;
  }

  private async chat(retriedAfter401 = false): Promise<any> {
    const url = `${this.cfg.baseUrl!.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // A signed-in endpoint hands out a fresh bearer per call (the gateway refreshes behind it);
    // everything else carries the pasted key.
    const token = this.cfg.bearer ? await this.cfg.bearer(retriedAfter401) : this.cfg.apiKey;
    if (token) headers.authorization = `Bearer ${token}`;
    const body = {
      model: this.cfg.model,
      messages: this.cacheMarks() ? this.withCacheMarks() : this.messages,
      // OpenRouter returns cached-token counts (and cost) with this; other endpoints would reject the field.
      ...(this.isOpenRouter() ? { usage: { include: true } } : {}),
      tools: [
        {
          type: 'function',
          function: {
            name: COMPUTER_TOOL_NAME,
            description: COMPUTER_TOOL_DESCRIPTION,
            parameters: COMPUTER_TOOL_PARAMETERS,
          },
        },
        {
          type: 'function',
          function: {
            name: ASK_USER_TOOL_NAME,
            description: ASK_USER_TOOL_DESCRIPTION,
            parameters: ASK_USER_TOOL_PARAMETERS,
          },
        },
        { type: 'function', function: { name: FIND_TOOL_NAME, description: FIND_TOOL_DESCRIPTION, parameters: FIND_TOOL_PARAMETERS } },
        { type: 'function', function: { name: READ_PAGE_TOOL_NAME, description: READ_PAGE_TOOL_DESCRIPTION, parameters: READ_PAGE_TOOL_PARAMETERS } },
        { type: 'function', function: { name: CLICK_ELEMENT_TOOL_NAME, description: CLICK_ELEMENT_TOOL_DESCRIPTION, parameters: CLICK_ELEMENT_TOOL_PARAMETERS } },
        { type: 'function', function: { name: WAIT_FOR_TOOL_NAME, description: WAIT_FOR_TOOL_DESCRIPTION, parameters: WAIT_FOR_TOOL_PARAMETERS } },
        { type: 'function', function: { name: RUN_COMMAND_TOOL_NAME, description: RUN_COMMAND_TOOL_DESCRIPTION, parameters: RUN_COMMAND_TOOL_PARAMETERS } },
        ...(this.cfg.docsIndex
          ? [{ type: 'function', function: { name: READ_DOCS_TOOL_NAME, description: READ_DOCS_TOOL_DESCRIPTION, parameters: READ_DOCS_TOOL_PARAMETERS } }]
          : []),
        ...(this.notes.memory !== undefined
          ? [
              { type: 'function', function: { name: REMEMBER_TOOL_NAME, description: REMEMBER_TOOL_DESCRIPTION, parameters: REMEMBER_TOOL_PARAMETERS } },
              { type: 'function', function: { name: FORGET_TOOL_NAME, description: FORGET_TOOL_DESCRIPTION, parameters: FORGET_TOOL_PARAMETERS } },
            ]
          : []),
        ...(this.notes.self !== undefined
          ? [
              { type: 'function', function: { name: REVISE_SELF_TOOL_NAME, description: REVISE_SELF_TOOL_DESCRIPTION, parameters: REVISE_SELF_TOOL_PARAMETERS } },
              { type: 'function', function: { name: RESTORE_SELF_TOOL_NAME, description: RESTORE_SELF_TOOL_DESCRIPTION, parameters: RESTORE_SELF_TOOL_PARAMETERS } },
              { type: 'function', function: { name: SELF_HISTORY_TOOL_NAME, description: SELF_HISTORY_TOOL_DESCRIPTION, parameters: SELF_HISTORY_TOOL_PARAMETERS } },
              { type: 'function', function: { name: ARCHIVE_STORY_TOOL_NAME, description: ARCHIVE_STORY_TOOL_DESCRIPTION, parameters: ARCHIVE_STORY_TOOL_PARAMETERS } },
              { type: 'function', function: { name: RECALL_TOOL_NAME, description: RECALL_TOOL_DESCRIPTION, parameters: RECALL_TOOL_PARAMETERS } },
              { type: 'function', function: { name: NOTE_TOOL_NAME, description: NOTE_TOOL_DESCRIPTION, parameters: NOTE_TOOL_PARAMETERS } },
            ]
          : []),
        ...(this.notes.playbooks !== undefined
          ? [
              { type: 'function', function: { name: SAVE_PLAYBOOK_TOOL_NAME, description: SAVE_PLAYBOOK_TOOL_DESCRIPTION, parameters: SAVE_PLAYBOOK_TOOL_PARAMETERS } },
              { type: 'function', function: { name: READ_PLAYBOOK_TOOL_NAME, description: READ_PLAYBOOK_TOOL_DESCRIPTION, parameters: READ_PLAYBOOK_TOOL_PARAMETERS } },
            ]
          : []),
      ],
      tool_choice: 'auto',
      // Sent only when asked for: reasoning models (kimi-k3, GPT-5) accept nothing but their default.
      ...(this.cfg.temperature !== undefined ? { temperature: this.cfg.temperature } : {}),
      // Reasoning models spend completion tokens thinking; a low cap cuts the answer off and looks like silence.
      max_tokens: 8000,
    };
    let r: Response;
    try {
      r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: this.signal });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
      throw new Error(
        `Cannot reach the model provider at ${url} (${detail}). ` +
          `Check deskfish.baseUrl — for a local LiteLLM/Ollama it must be running; for xAI use https://api.x.ai/v1; ` +
          `or set deskfish.provider to "anthropic" or "mock".`,
      );
    }
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 500);
      // The subscription's pool, not the credential: the loop turns this into a knock on the glass.
      if (this.cfg.bearer && (r.status === 429 || (r.status === 403 && /run out of available resources|active grok subscription/i.test(detail)))) {
        throw new PoolExhaustedError("Your Grok subscription's pool is used up. Switch to the xAI API-key preset in Settings and hand back, or hand back once the pool has reset — the task goes on from here.");
      }
      if (r.status === 401 && this.cfg.bearer && !retriedAfter401) {
        // The access token expired mid-task (or was rotated elsewhere): one fresh one, one retry.
        return this.chat(true);
      }
      if (r.status === 401 || r.status === 403) {
        throw new Error(
          this.cfg.bearer
            ? `${url} refused the Grok sign-in (HTTP ${r.status}). Sign in again, or use an xAI API key, in Settings.`
            : `${url} rejected the API key (HTTP ${r.status}). Set one with "Deskfish: Set LLM API Key".`,
        );
      }
      throw new Error(`${this.cfg.model} @ ${url}: HTTP ${r.status} ${detail}`);
    }
    return r.json();
  }
}
