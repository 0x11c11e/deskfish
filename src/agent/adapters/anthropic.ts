import Anthropic from '@anthropic-ai/sdk';
import type { ComputerAction } from '../../computer/types';
import {
  ASK_USER_TOOL_DESCRIPTION,
  ASK_USER_TOOL_NAME,
  ASK_USER_TOOL_PARAMETERS,
  FORGET_TOOL_DESCRIPTION,
  FORGET_TOOL_NAME,
  FORGET_TOOL_PARAMETERS,
  READ_DOCS_TOOL_DESCRIPTION,
  READ_DOCS_TOOL_NAME,
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
  ZOOM_TOOL_DESCRIPTION,
  ZOOM_TOOL_NAME,
  ZOOM_TOOL_PARAMETERS,
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
  zoomAction,
} from '../actions';
import { charterNote, docsNote, journalNote, memoryNote, modelNote, playbookNote, screenNote, selfNote, systemPrompt, tankNote } from '../prompts';
import { diffNotes } from '../notesDelta';
import { KEEP_LONG_RESULTS, PRUNE_TEXT_BATCH, isLongResult, shortenResult } from '../prune';
import type { AgentNotes } from './types';
import { describeResult, type AdapterConfig, type ModelAdapter, type ModelTurn, type Observation } from './types';

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaImageBlockParam = Anthropic.Beta.BetaImageBlockParam;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type CacheMark = { type: 'ephemeral'; ttl?: '5m' | '1h' };

const COMPUTER_USE_BETA = 'computer-use-2025-11-24';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Server-side compaction: when the conversation nears the trigger size the API summarizes older
 *  turns into a compaction block (which we replay verbatim like every assistant block), so a task
 *  can run for hundreds of steps instead of dying at the context window. */
const COMPACTION_BETA = 'compact-2026-01-12';

interface PendingCall {
  id: string;
  parseError?: string;
}

/**
 * Adapter for the Anthropic API using Claude's native computer-use tool (`computer_20251124`).
 *
 * Claude has been trained on this exact tool, so it clicks more accurately than a generic
 * vision model given a JSON schema. Conversation shape per turn:
 *   assistant: [thinking?, text?, tool_use(computer)…]
 *   user:      [tool_result(ok) …, tool_result(ok + screenshot image)]   ← image rides on the last result
 *
 * Thinking blocks are replayed verbatim (required for multi-turn continuity), and refusals surface
 * as a finished turn with the server's explanation. `fallbacks: 'default'` lets the API route a
 * refused request to a fallback model instead of failing the step; set `cfg.refusalFallback=false`
 * to disable.
 */
export class AnthropicAdapter implements ModelAdapter {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly maxImages: number;
  private readonly maxTextResults: number;
  private messages: BetaMessageParam[] = [];
  private system = '';
  private screen = { width: 1280, height: 720 };
  private pending: PendingCall[] = [];
  private queuedUser: string[] = [];
  private task = '';
  private first = true;
  private notes: AgentNotes = {};

  constructor(private readonly cfg: AdapterConfig & { refusalFallback?: boolean }) {
    // apiKey undefined → the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login`.
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl || undefined,
      // Identity-linked API keys must say which workspace a request acts in; the SDK only adds
      // this header by itself for OAuth profiles, so a plain key needs it passed explicitly.
      ...(cfg.workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': cfg.workspaceId } } : {}),
    });
    this.maxImages = cfg.maxImages ?? 3;
    this.maxTextResults = cfg.maxTextResults ?? KEEP_LONG_RESULTS;
  }

  start(task: string, screen: { width: number; height: number }): void {
    this.task = task;
    this.screen = screen;
    this.first = true;
    this.pending = [];
    this.queuedUser = [];
    this.messages = [];
    this.refreshNotes();
  }

  /** (Re)build the system prompt from the fixed parts and the live notes (memory, self, journal). */
  refreshNotes(): void {
    this.notes = this.cfg.notes?.() ?? { memory: this.cfg.memoryNote };
    const n = this.notes;
    this.system = [
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
  }

  /** What changed in the notes since the system prompt was built, without touching that prompt (it is the cached prefix). */
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
    const image: BetaImageBlockParam = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: obs.image.jpeg.toString('base64') },
    };
    const extras = [obs.note, ...this.queuedUser.map((t) => `User: ${t}`)].filter(Boolean).join('\n');
    this.queuedUser = [];

    if (this.first) {
      this.first = false;
      // The run-start note (clock, network mode, a continuation ledger) rides on the first message too.
      this.messages.push({
        role: 'user',
        content: [{ type: 'text', text: `Task: ${this.task}\n\nHere is the current screen.${extras ? `\n\n${extras}` : ''}` }, image],
      });
    } else {
      // The API rejects an `is_error` tool_result that contains anything but text, so images that
      // would ride on a failed result go after the results as plain user content instead.
      const trailing: BetaContentBlockParam[] = [];
      const content: BetaContentBlockParam[] = this.pending.map((call, i): BetaToolResultBlockParam => {
        const last = i === this.pending.length - 1;
        if (call.parseError) {
          if (last) trailing.push({ type: 'text', text: 'Current screen:' }, image);
          return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: call.parseError };
        }
        const result = obs.results[i] ?? { ok: false, error: 'no result' };
        const text = describeResult(result);
        // A zoom result carries its own image (the magnified view); the last result also carries
        // the after-batch screenshot, labeled when both would otherwise sit side by side.
        const blocks: (BetaImageBlockParam | { type: 'text'; text: string })[] = [{ type: 'text', text }];
        if (result.image) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: result.image.jpeg.toString('base64') } });
        }
        if (last) {
          if (result.image) blocks.push({ type: 'text', text: 'And the current full screen:' });
          blocks.push(image);
        }
        if (!result.ok) {
          if (blocks.length > 1) trailing.push({ type: 'text', text: 'Current screen:' }, ...blocks.slice(1).filter((b) => b.type === 'image'));
          return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: text };
        }
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          content: blocks.length > 1 ? blocks : text,
        };
      });
      content.push(...trailing);
      if (this.pending.length === 0) content.push({ type: 'text', text: 'Current screen:' }, image);
      if (extras) content.push({ type: 'text', text: extras });
      this.messages.push({ role: 'user', content });
    }
    this.pruneImages();
    this.pruneText();
    this.moveCacheBreakpoint();

    const useFallback = this.cfg.refusalFallback !== false && this.fallbackSupported;
    const response = await this.request(useFallback);

    // Replay the assistant turn verbatim (thinking blocks included) so the next request is valid.
    this.messages.push({ role: 'assistant', content: response.content as unknown as BetaContentBlockParam[] });

    const texts: string[] = [];
    const actions: ComputerAction[] = [];
    this.pending = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        if (block.text.trim()) texts.push(block.text.trim());
      } else if (block.type === 'tool_use') {
        const entry: PendingCall = { id: block.id };
        try {
          if (block.name === 'computer') actions.push(toComputerAction(block.input));
          else if (block.name === ZOOM_TOOL_NAME) actions.push(zoomAction(block.input));
          else if (block.name === ASK_USER_TOOL_NAME) actions.push(askUserAction(block.input));
          else if (block.name === READ_DOCS_TOOL_NAME) actions.push(readDocsAction(block.input));
          else if (block.name === FIND_TOOL_NAME) actions.push(findAction(block.input));
          else if (block.name === READ_PAGE_TOOL_NAME) actions.push(readPageAction(block.input));
          else if (block.name === WAIT_FOR_TOOL_NAME) actions.push(waitForAction(block.input));
          else if (block.name === RUN_COMMAND_TOOL_NAME) actions.push(runCommandAction(block.input));
          else if (block.name === REMEMBER_TOOL_NAME) actions.push(rememberAction(block.input));
          else if (block.name === FORGET_TOOL_NAME) actions.push(forgetAction(block.input));
          else if (block.name === REVISE_SELF_TOOL_NAME) actions.push(reviseSelfAction(block.input));
          else if (block.name === RESTORE_SELF_TOOL_NAME) actions.push(restoreSelfAction(block.input));
          else if (block.name === SELF_HISTORY_TOOL_NAME) actions.push(selfHistoryAction(block.input));
          else if (block.name === ARCHIVE_STORY_TOOL_NAME) actions.push(archiveStoryAction(block.input));
          else if (block.name === RECALL_TOOL_NAME) actions.push(recallAction(block.input));
          else if (block.name === NOTE_TOOL_NAME) actions.push(noteAction(block.input));
          else if (block.name === SAVE_PLAYBOOK_TOOL_NAME) actions.push(savePlaybookAction(block.input));
          else if (block.name === READ_PLAYBOOK_TOOL_NAME) actions.push(readPlaybookAction(block.input));
          else throw new Error(`unknown tool ${block.name}`);
        } catch (err) {
          entry.parseError = err instanceof Error ? err.message : String(err);
          actions.push({ type: 'screenshot' }); // placeholder keeps results aligned with tool_use ids
        }
        this.pending.push(entry);
      }
    }

    if (response.stop_reason === 'refusal') {
      const why = response.stop_details?.type === 'refusal' ? response.stop_details.explanation ?? '' : '';
      texts.push(`The model declined to continue${why ? `: ${why}` : '.'}`);
      return { text: texts.join('\n'), actions: [], done: true };
    }

    return {
      text: texts.length ? texts.join('\n') : undefined,
      actions,
      done: this.pending.length === 0,
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
        cacheWrite1h: response.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      },
    };
  }

  /** Cleared the first time a model says it does not take the `fallbacks` parameter (Sonnet 5 does not). */
  private fallbackSupported = true;

  private async request(useFallback: boolean) {
    try {
      return await this.createMessage(useFallback);
    } catch (err) {
      if (useFallback && err instanceof Anthropic.BadRequestError && /fallbacks/i.test(err.message)) {
        // Not every model takes the refusal fallback; remember that and send the same request without it.
        this.fallbackSupported = false;
        try {
          return await this.createMessage(false);
        } catch (again) {
          throw this.friendlyError(again);
        }
      }
      throw this.friendlyError(err);
    }
  }

  /** The SDK's errors, reworded to say what to click. */
  private friendlyError(err: unknown): unknown {
    if (err instanceof Anthropic.AuthenticationError) {
      return new Error('Anthropic rejected the API key. Set one with "Deskfish: Set LLM API Key" (or export ANTHROPIC_API_KEY).');
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return new Error(`Cannot reach the Anthropic API${this.cfg.baseUrl ? ` at ${this.cfg.baseUrl}` : ''}: ${err.message}`);
    }
    if (err instanceof Anthropic.RateLimitError) {
      return new Error(`Anthropic rate limit hit: ${err.message}`);
    }
    if (err instanceof Anthropic.BadRequestError && /anthropic-workspace-id/i.test(err.message)) {
      return new Error(
        'Your Anthropic API key is identity-linked, so Anthropic needs to know which workspace to bill. ' +
          'Set "deskfish.anthropicWorkspaceId" to your workspace ID (Anthropic Console → Settings → Workspaces; it looks like wrkspc_…), ' +
          'or create a workspace API key instead. Then send the task again.',
      );
    }
    // No key anywhere: not in SecretStorage, not in the environment. The SDK's own wording
    // ("Could not resolve authentication method…") does not tell the user what to click.
    if (err instanceof Error && /could not resolve authentication method/i.test(err.message)) {
      return new Error('No API key is set. Click the key chip in the sidebar (or run "Deskfish: Set LLM API Key"), then send the task again.');
    }
    return err;
  }

  private createMessage(useFallback: boolean) {
    return this.client.beta.messages.create({
      model: this.cfg.model,
      max_tokens: 16000,
      betas: useFallback ? [COMPUTER_USE_BETA, FALLBACK_BETA, COMPACTION_BETA] : [COMPUTER_USE_BETA, COMPACTION_BETA],
      ...(useFallback ? { fallbacks: 'default' as const } : {}),
      context_management: { edits: [{ type: 'compact_20260112' }] },
      thinking: { type: 'adaptive' },
      // Effort trades thinking depth for tokens and seconds; unset = the provider's default.
      ...(this.cfg.effort ? { output_config: { effort: this.cfg.effort } } : {}),
      system: [{ type: 'text', text: this.system, cache_control: this.cacheMark() }],
      tools: [
        {
          type: 'computer_20251124',
          name: 'computer',
          display_width_px: this.screen.width,
          display_height_px: this.screen.height,
          display_number: 1,
        },
        {
          name: ZOOM_TOOL_NAME,
          description: ZOOM_TOOL_DESCRIPTION,
          input_schema: ZOOM_TOOL_PARAMETERS,
        },
        {
          name: ASK_USER_TOOL_NAME,
          description: ASK_USER_TOOL_DESCRIPTION,
          input_schema: ASK_USER_TOOL_PARAMETERS,
        },
        { name: FIND_TOOL_NAME, description: FIND_TOOL_DESCRIPTION, input_schema: FIND_TOOL_PARAMETERS },
        { name: READ_PAGE_TOOL_NAME, description: READ_PAGE_TOOL_DESCRIPTION, input_schema: READ_PAGE_TOOL_PARAMETERS },
        { name: WAIT_FOR_TOOL_NAME, description: WAIT_FOR_TOOL_DESCRIPTION, input_schema: WAIT_FOR_TOOL_PARAMETERS },
        { name: RUN_COMMAND_TOOL_NAME, description: RUN_COMMAND_TOOL_DESCRIPTION, input_schema: RUN_COMMAND_TOOL_PARAMETERS },
        ...(this.cfg.docsIndex
          ? [{ name: READ_DOCS_TOOL_NAME, description: READ_DOCS_TOOL_DESCRIPTION, input_schema: READ_DOCS_TOOL_PARAMETERS }]
          : []),
        ...(this.notes.memory !== undefined
          ? [
              { name: REMEMBER_TOOL_NAME, description: REMEMBER_TOOL_DESCRIPTION, input_schema: REMEMBER_TOOL_PARAMETERS },
              { name: FORGET_TOOL_NAME, description: FORGET_TOOL_DESCRIPTION, input_schema: FORGET_TOOL_PARAMETERS },
            ]
          : []),
        ...(this.notes.self !== undefined
          ? [
              { name: REVISE_SELF_TOOL_NAME, description: REVISE_SELF_TOOL_DESCRIPTION, input_schema: REVISE_SELF_TOOL_PARAMETERS },
              { name: RESTORE_SELF_TOOL_NAME, description: RESTORE_SELF_TOOL_DESCRIPTION, input_schema: RESTORE_SELF_TOOL_PARAMETERS },
              { name: SELF_HISTORY_TOOL_NAME, description: SELF_HISTORY_TOOL_DESCRIPTION, input_schema: SELF_HISTORY_TOOL_PARAMETERS },
              { name: ARCHIVE_STORY_TOOL_NAME, description: ARCHIVE_STORY_TOOL_DESCRIPTION, input_schema: ARCHIVE_STORY_TOOL_PARAMETERS },
              { name: RECALL_TOOL_NAME, description: RECALL_TOOL_DESCRIPTION, input_schema: RECALL_TOOL_PARAMETERS },
              { name: NOTE_TOOL_NAME, description: NOTE_TOOL_DESCRIPTION, input_schema: NOTE_TOOL_PARAMETERS },
            ]
          : []),
        ...(this.notes.playbooks !== undefined
          ? [
              { name: SAVE_PLAYBOOK_TOOL_NAME, description: SAVE_PLAYBOOK_TOOL_DESCRIPTION, input_schema: SAVE_PLAYBOOK_TOOL_PARAMETERS },
              { name: READ_PLAYBOOK_TOOL_NAME, description: READ_PLAYBOOK_TOOL_DESCRIPTION, input_schema: READ_PLAYBOOK_TOOL_PARAMETERS },
            ]
          : []),
      ],
      messages: this.messages,
    }, { signal: this.signal });
  }

  /**
   * Incremental prompt caching: one breakpoint on the last block of the newest user message. The
   * conversation is append-only, so on the next request everything before that point is a cache
   * hit (10% of the input price) instead of being re-billed in full. The breakpoint moves every
   * turn (Anthropic allows 4; the system prompt keeps one), so older user messages are stripped.
   */
  private moveCacheBreakpoint(): void {
    let last: BetaMessageParam | undefined;
    for (const m of this.messages) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content as Array<{ cache_control?: unknown }>) delete b.cache_control;
      last = m;
    }
    const blocks = last?.content as Array<{ cache_control?: CacheMark }> | undefined;
    if (blocks?.length) blocks[blocks.length - 1].cache_control = this.cacheMark();
  }

  /**
   * The breakpoint's TTL. 1 hour by default: a person's reply, a standby or a slow command routinely
   * takes more than the 5 minutes of the default cache, and every expiry re-wrote the whole
   * conversation at cache-write price (a two-step text answer cost $0.60 on 2026-09-14 for that
   * reason). The 1-hour write costs 2× input instead of 1.25× on the few thousand new tokens of
   * each step — about a cent — and the prefix then survives the gaps.
   */
  private cacheMark(): CacheMark {
    return this.cfg.cacheTtl === '5m' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl: '1h' };
  }

  /**
   * Keep only recent screenshots; older image blocks become a short note.
   *
   * Pruned in batches, not every step: rewriting a message that sits inside the cached prefix
   * invalidates the prompt cache from that point on, so pruning one image per step meant the
   * last few turns were re-written (at cache-write price) on every request and only ~30% of the
   * input was read from cache. Letting images build up to maxImages + PRUNE_BATCH and then
   * dropping back to maxImages leaves the prefix untouched on most steps.
   */
  private pruneImages(): void {
    const PRUNE_BATCH = 5;
    let count = 0;
    const walk = (blocks: BetaContentBlockParam[], fn: (blocks: BetaContentBlockParam[], j: number) => void) => {
      for (let j = blocks.length - 1; j >= 0; j--) {
        const b = blocks[j];
        if (b.type === 'image') fn(blocks, j);
        else if (b.type === 'tool_result' && Array.isArray(b.content)) walk(b.content as BetaContentBlockParam[], fn);
      }
    };
    const users = this.messages.filter((m): m is BetaMessageParam & { content: BetaContentBlockParam[] } => m.role === 'user' && Array.isArray(m.content));
    for (const m of users) walk(m.content, () => count++);
    if (count <= this.maxImages + PRUNE_BATCH) return;
    let seen = 0;
    for (let i = users.length - 1; i >= 0; i--) {
      walk(users[i].content, (blocks, j) => {
        seen++;
        if (seen > this.maxImages) blocks[j] = { type: 'text', text: '[earlier screenshot omitted]' };
      });
    }
  }

  /**
   * Keep only the newest long tool results whole (page text, command output, a documentation page);
   * older ones shrink to their first line (see ../prune.ts). Batched like the images so the cached
   * prefix is rewritten once every few results, not every step.
   */
  private pruneText(): void {
    type Slot = { result?: BetaToolResultBlockParam; blocks?: BetaContentBlockParam[]; index?: number; text: string };
    const slots: Slot[] = [];
    for (const m of this.messages) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        if (typeof b.content === 'string') {
          if (isLongResult(b.content)) slots.push({ result: b, text: b.content });
          continue;
        }
        if (!Array.isArray(b.content)) continue;
        const blocks = b.content as BetaContentBlockParam[];
        for (let j = 0; j < blocks.length; j++) {
          const c = blocks[j];
          if (c.type === 'text' && isLongResult(c.text)) slots.push({ blocks, index: j, text: c.text });
        }
      }
    }
    if (slots.length <= this.maxTextResults + PRUNE_TEXT_BATCH) return;
    for (const s of slots.slice(0, slots.length - this.maxTextResults)) {
      const short = shortenResult(s.text);
      if (s.result) s.result.content = short;
      else if (s.blocks && s.index !== undefined) s.blocks[s.index] = { type: 'text', text: short };
    }
  }
}
