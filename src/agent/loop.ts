import type { ActionResult, ComputerAction, ComputerProvider } from '../computer/types';
import { scalePng } from '../image/resize';
import { renderZoom } from '../image/zoom';
import { renderPage } from './page';
import type { ModelAdapter, ModelTurn, Observation } from './adapters/types';
import type { DocsLibrary } from './docs';
import { costUsd, type Price } from './pricing';
import { frameDiff, type ScaledImage } from '../image/resize';
import { describeAction } from '../computer/types';
import type { MemoryStore } from './memory';
import type { SelfStore } from './self';
import type { JournalStore } from './journal';
import { DRIFT_QUESTIONS, answerSimilarity, continuationTask, driftComparePrompt, identityReminder, ledgerPrompt, parseCharterObjections, parseDriftAnswers, parseDriftVerdicts, reflectionPrompt, stripDriftAnswers } from './prompts';
import type { Library } from './library';
import type { ChatStore } from './chats';
import type { PlaybookStore } from './playbook';
import { SALIENCE_THRESHOLD, salienceOf } from './journal';
import * as crypto from 'node:crypto';

/**
 * The agent loop: screenshot → model → actions → screenshot → …
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ observe(): computer.screenshot() → downscale → Observation   │
 *   │ adapter.step(obs): model decides → ModelTurn {actions, done} │
 *   │ for each action: map scaled→native coords → computer.execute │
 *   │   (ask_user: pause and wait for the human instead)           │
 *   │ settle, then observe() again                                 │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * It knows nothing about VS Code or about any particular LLM; it only speaks `ComputerProvider`
 * and `ModelAdapter`. Pause/resume implements "takeover": when the human grabs the desktop the loop
 * blocks, and when control comes back it re-observes the screen before letting the model continue.
 */

export type AgentStatus = 'idle' | 'running' | 'paused' | 'done' | 'stopped' | 'error';

export type AgentEvent =
  /** `screenFree`: the run never touches the screen (a reflection), so the live view stays the person's. */
  | { type: 'status'; status: AgentStatus; message?: string; screenFree?: boolean }
  | { type: 'assistant'; text: string }
  | { type: 'action'; step: number; action: ComputerAction; result: ActionResult }
  | { type: 'screenshot'; step: number; jpegBase64: string; width: number; height: number }
  /** The model handed the desktop to the human. Carries the screen as it looked at that moment. */
  | { type: 'needs_user'; step: number; reason: string; jpegBase64: string; width: number; height: number }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number; costUsd?: number }
  /** A task just ended and was journaled; `due` = it is time for a reflection (tasks since the last one reached the threshold). */
  | { type: 'task_finished'; outcome: string; tasksSinceReflection: number; due: boolean }
  /** A reflection's answers to the three fixed questions, with the previous answer and her verdict per question (folded in the chat, never in her reply). */
  | { type: 'answers'; items: { question: string; answer: string; before?: string; changed: boolean; note?: string }[] }
  /** A reflection's answers to the fixed questions moved in substance (her own verdict; `note` says what changed). */
  | { type: 'drift'; shifts: { question: string; before: string; after: string; note?: string }[] }
  /** In a reflection the bot said it disagrees with its charter ("Charter: …" lines). */
  | { type: 'charter_objection'; lines: string[] }
  /** Keys or buttons that were found held down on the display and released (`held` names them). */
  | { type: 'released'; reason: string; held: string[] }
  /** The conversation was condensed: `text` is the ledger she wrote after `step` steps; the run continues from it. */
  | { type: 'ledger'; step: number; text: string }
  /** A standby (wait_for) began: the chat shows it with a live countdown until the matching `action` event ends it. */
  | { type: 'standby'; reason: string; minutes: number; until: 'change' | 'time'; endsAt: number };

export interface AgentRunnerOptions {
  computer: ComputerProvider;
  adapter: ModelAdapter;
  maxSteps?: number;
  screenshotWidth?: number;
  settleMs?: number;
  /** The bot's documentation, served to the model on demand through the read_docs action. */
  docs?: DocsLibrary;
  /** Long-term memory behind the remember/forget actions. */
  memory?: MemoryStore;
  /** Who the bot is (its own file) behind revise_self/restore_self. */
  self?: SelfStore;
  /** Episodic memory: finished tasks and notes, behind recall/note_to_self; reflection bookkeeping. */
  journal?: JournalStore;
  /** Condense the conversation every this many steps: she writes a ledger and continues from it. 0/undefined = never. */
  ledgerEvery?: number;
  /** How often standby (wait_for) looks at the screen, in ms. Default: every 3–10 s depending on the wait's length. Tests set it low. */
  standbyPollMs?: number;
  /** Reflect after this many finished tasks (0 = only when asked); also when the tasks' salience adds up. */
  reflectEvery?: number;
  /** Procedural memory behind save_playbook/read_playbook. */
  playbook?: PlaybookStore;
  /** Short public-domain readings, one per reflection. */
  library?: Library;
  /** Past chat transcripts; recall searches them too. */
  chats?: ChatStore;
  /** Facts about the machine she is on that only the host knows (e.g. how the tank is networked), read at run start. */
  environmentNote?: () => string | undefined;
  /** Per-task cost budget in USD (0/undefined = none). Needs `price` to be effective. */
  budgetUsd?: number;
  /** List price of the model, for the budget. */
  price?: Price;
  onEvent: (e: AgentEvent) => void;
}

export class AgentRunner {
  private status: AgentStatus = 'idle';
  private stopRequested = false;
  private resumedSinceObserve = false;
  private waiting = false;
  private pauseGate?: { promise: Promise<void>; resolve: () => void; message: string };
  private scale = { x: 1, y: 1 };
  private scaledWidth = 1280;
  private scaledSize = { width: 1280, height: 800 };
  private started = false;
  private lastShot?: { jpegBase64: string; width: number; height: number };
  /** Per-run bookkeeping for the journal. */
  private current?: { task: string; reflection: boolean; steps: number; spentUsd: number; lastAssistant: string; revisions: number; journaled: boolean; handovers: number; notes: number; followUps: number; said: string[]; ledger?: string; ledgers: number };

  constructor(private readonly opts: AgentRunnerOptions) {}

  get currentStatus(): AgentStatus {
    return this.status;
  }

  get isActive(): boolean {
    return this.status === 'running' || this.status === 'paused';
  }

  /** True while paused because the model called ask_user (as opposed to a human takeover). */
  get waitingForUser(): boolean {
    return this.waiting;
  }

  /** Block the loop before its next model call / action. Used for human takeover and ask_user. */
  /**
   * Pause = the person takes the desktop. The gate is armed here, but "paused" is only announced
   * from shouldStop(), once the current action has finished and every key and button the agent
   * held is released — otherwise the live view unlocks while xdotool is still typing, and the
   * person's clicks interleave with the agent's shift-presses. Until then the status says so.
   */
  pause(message = 'Paused — you have the desktop'): void {
    if (this.status !== 'running' || this.pauseGate) return;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    this.pauseGate = { promise, resolve, message };
    this.setStatus('running', 'Pausing — finishing the current action…');
    this.wakeSleep?.(); // a wait or a standby ends now
  }

  resume(): void {
    if (this.status !== 'paused' && !this.pauseGate) return;
    this.resumedSinceObserve = true;
    this.pauseGate?.resolve();
    this.pauseGate = undefined;
    this.setStatus('running', 'Resumed');
  }

  /** Aborts the model call in flight; a new one is created per call. */
  private abort?: AbortController;
  /** Resolves any wait/settle sleep early. */
  private wakeSleep?: () => void;

  stop(): void {
    if (!this.isActive) return;
    this.stopRequested = true;
    if (this.status === 'running') this.setStatus('running', 'Stopping…');
    this.abort?.abort();
    this.wakeSleep?.();
    this.pauseGate?.resolve();
    this.pauseGate = undefined;
  }

  /** A model turn that Stop can cut short. */
  private async modelStep(obs: Observation): Promise<ModelTurn> {
    this.abort = new AbortController();
    try {
      return await this.opts.adapter.step(obs, this.abort.signal);
    } finally {
      this.abort = undefined;
    }
  }

  /** Let go of every key and button on the display; what was actually held is reported as an event for the log. */
  private async releaseInput(reason: string): Promise<void> {
    const released = await this.opts.computer.releaseInput?.().catch(() => undefined);
    if (released && released.length) this.opts.onEvent({ type: 'released', reason, held: released });
  }

  /** Sleep that Stop (or a hand-over) ends early. */
  private sleepUnlessStopped(ms: number): Promise<void> {
    if (this.stopRequested || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wakeSleep = undefined;
        resolve();
      }, ms);
      this.wakeSleep = () => {
        clearTimeout(t);
        this.wakeSleep = undefined;
        resolve();
      };
    });
  }

  /**
   * Inject a user message mid-task; delivered with the next observation. Refused (false) during a
   * reflection: that conversation is hers alone, and the caller holds the message for afterwards.
   */
  say(text: string): boolean {
    if (this.reflecting) return false;
    if (this.current) {
      this.current.followUps++;
      // What the user says mid-task is the correction that shapes her; it has to land somewhere written.
      if (this.current.said.length < 3) this.current.said.push(text);
    }
    this.opts.adapter.addUserMessage(text);
    return true;
  }

  /**
   * Reflection: the bot alone with its notes, allowed to rewrite itself. Same loop, a special task
   * text, no journal entry of its own, and revise_self applies immediately (elsewhere it is queued).
   */
  async reflect(): Promise<void> {
    const journal = this.opts.journal;
    if (!journal || !this.opts.self) throw new Error('reflection needs the self and journal stores');
    const state = journal.state();
    const entries = journal.render(journal.newSinceReflection());
    const pending = state.pending
      .map((p) => (p.kind === 'revise_self' ? `- [${p.at}] proposed revising "${p.section}": ${p.text}` : `- [${p.at}] ${p.text}`))
      .join('\n');
    const picked = this.opts.library?.pick(state.readings);
    if (picked) journal.readingGiven();
    const reading = picked ? { title: picked.title, source: picked.source, text: picked.text } : undefined;
    const sz = this.opts.self.sizes();
    const sizes = `${sz.total} of ${sz.max} characters (${sz.sections.map((x) => `${x.heading} ${x.chars}`).join(', ')}).`;
    await this.run(reflectionPrompt({ entries, pending, tasks: state.tasksSinceReflection, reading, sizes }), { reflection: true });
  }

  async run(task: string, runOpts: { reflection?: boolean } = {}): Promise<void> {
    if (this.isActive) throw new Error('agent is already running');
    this.current = { task, reflection: !!runOpts.reflection, steps: 0, spentUsd: 0, lastAssistant: '', revisions: 0, journaled: false, handovers: 0, notes: 0, followUps: 0, said: [], ledgers: 0 };
    this.stopRequested = false;
    this.resumedSinceObserve = false;
    this.waiting = false;
    const { computer, adapter, onEvent } = this.opts;
    // 0 (the default) means no fixed limit: like a terminal agent, the task runs until the model stops or
    // the user presses Stop; the cost counter and Stop are the controls. A positive number caps it.
    const maxSteps = this.opts.maxSteps && this.opts.maxSteps > 0 ? this.opts.maxSteps : Infinity;
    const limited = Number.isFinite(maxSteps);
    // The budget needs a cost source: a list price for the model, or a cost reported by the provider.
    const budget = this.opts.budgetUsd && this.opts.budgetUsd > 0 ? this.opts.budgetUsd : 0;
    let spentUsd = 0;
    let budgetWarned = false;
    // Stall detection: the same actions repeated while nothing visible changes means the model is
    // going in circles. An unchanged-looking screen alone is NOT a stall (long forms, reading pages).
    let lastFrame: ScaledImage | undefined;
    let lastActions = '';
    let repeatStreak = 0;
    let stallNudges = 0;
    const pendingNotes: string[] = [];
    this.setStatus('running', runOpts.reflection ? 'Reflecting…' : 'Starting…');

    try {
      // A clean slate: nothing held over from the person's last session in the tank.
      if (!runOpts.reflection) await this.releaseInput('start');
      const native = await computer.displaySize();
      this.scaledWidth = Math.min(this.opts.screenshotWidth ?? 1280, native.width);
      const scaled = {
        width: this.scaledWidth,
        height: Math.round((native.height * this.scaledWidth) / native.width),
      };
      this.scale = { x: native.width / scaled.width, y: native.height / scaled.height };
      this.scaledSize = scaled;
      this.noticeTamper();
      if (this.started) {
        // A follow-up task on the same runner continues the adapter's conversation with
        // full context instead of resetting it.
        adapter.addUserMessage(task);
      } else {
        adapter.start(task, scaled);
        this.started = true;
      }
      // Memory, self and journal may have changed since the conversation began.
      adapter.refreshNotes?.();

      // She has no clock of her own: without this, a journal line from an hour ago reads as "yesterday".
      const env = this.opts.environmentNote?.();
      const clock = `${clockLine()}${env ? ` ${env}` : ''}`;
      let obs = await this.observe(
        0,
        [],
        `${clock}\n${
          limited
            ? `You have up to ${maxSteps} steps (model turns) for this task; use them economically.`
            : 'There is no fixed step limit for this task: work until it is done. Every step costs money, so be economical.'
        }`,
      );
      for (let step = 1; step <= maxSteps; step++) {
        if (this.current) this.current.steps = step;
        if (await this.shouldStop()) return;
        if (this.resumedSinceObserve) {
          this.resumedSinceObserve = false;
          obs = await this.observe(step, obs.results, 'The user took control of the desktop for a while and has handed it back. Re-check the screen before continuing.');
        }
        // Long tasks: every `ledgerEvery` steps she writes a ledger and the conversation restarts from it,
        // so the cost of a step stops growing with the task and the thread survives the cut.
        const every = this.opts.ledgerEvery ?? 0;
        if (every > 0 && step > 1 && (step - 1) % every === 0 && !this.current?.reflection) {
          const condensed = await this.condense(step, obs);
          if (!condensed) return; // stopped meanwhile
          obs = condensed.obs;
          if (condensed.usage) {
            onEvent({ type: 'usage', ...condensed.usage });
            if (condensed.usage.costUsd !== undefined) spentUsd += condensed.usage.costUsd;
            else if (this.opts.price) spentUsd += costUsd(condensed.usage, this.opts.price);
            if (this.current) this.current.spentUsd = spentUsd;
          }
        }
        // Long tasks push the system prompt far from the model's attention: re-anchor the voice now and then.
        if (step % 25 === 0 && this.opts.self && !this.current?.reflection) {
          const first = this.opts.self.load().text.split(/\n\s*\n/)[0] ?? '';
          if (first.trim()) obs = { ...obs, note: [obs.note, identityReminder(first)].filter(Boolean).join('\n') };
        }
        const left = maxSteps - step + 1;
        if (limited && left <= 3) {
          const warning = `Only ${left} step${left === 1 ? '' : 's'} remain${left === 1 ? 's' : ''} (including this one) before the task is cut off. Wrap up now: finish, or reply with a summary of what you found and what is left.`;
          obs = { ...obs, note: obs.note ? `${obs.note}\n${warning}` : warning };
        }

        const turn = await this.modelStep(obs);
        if (turn.usage) {
          onEvent({ type: 'usage', ...turn.usage });
          if (turn.usage.costUsd !== undefined) spentUsd += turn.usage.costUsd;
          else if (this.opts.price) spentUsd += costUsd(turn.usage, this.opts.price);
          if (this.current) this.current.spentUsd = spentUsd;
        }
        if (turn.text) {
          // In a reflection the closing "Q1:"–"Q3:" lines are for the drift monitor, not for the chat.
          const shown = this.current?.reflection ? stripDriftAnswers(turn.text) : turn.text;
          if (shown) onEvent({ type: 'assistant', text: shown });
          if (this.current) this.current.lastAssistant = turn.text;
        }
        if (budget && spentUsd >= budget && !turn.done) {
          await this.wrapUp(
            `This task's cost budget ($${budget.toFixed(2)}) is used up ($${spentUsd.toFixed(2)} so far). Take no more actions: reply now with a short summary of what you found so far and what is still left to do.`,
            `Stopped at the cost budget ($${budget.toFixed(2)}) — raise deskfish.maxCostUsd or say "continue"`,
            obs,
          );
          return;
        }
        if (budget && !budgetWarned && spentUsd >= budget * 0.8) {
          budgetWarned = true;
          pendingNotes.push(`You have used about ${Math.round((spentUsd / budget) * 100)}% of this task's cost budget ($${spentUsd.toFixed(2)} of $${budget.toFixed(2)}). Wrap up soon: finish, or summarize what you found.`);
        }
        if (turn.done) {
          if (this.current?.reflection) await this.compareDrift(obs);
          await computer.releaseInput?.().catch(() => undefined);
          this.finishTask('done');
          // A turn with no actions and no words is "done" to the loop, but the user deserves to know it was silent.
          const silent = !turn.text && !this.current?.reflection;
          this.setStatus('done', this.current?.reflection ? 'Reflection finished' : silent ? 'Task finished — the model ended without a reply' : 'Task finished');
          return;
        }

        const results: ActionResult[] = [];
        let acted = false;
        // The frame from before the last real action, when a wait_for follows it in this batch: a
        // toggle that flips at once would otherwise have changed before standby takes its first look.
        let before: ScaledImage | undefined;
        for (const [i, action] of turn.actions.entries()) {
          if (await this.shouldStop()) return;

          if (action.type === 'ask_user') {
            if (this.current) this.current.handovers++;
            const result = await this.handOver(step, action.reason);
            if (!result) return; // stopped while waiting
            results.push(result);
            onEvent({ type: 'action', step, action, result });
            continue;
          }

          if (action.type === 'zoom') {
            const result = await this.zoomView(action);
            results.push(result);
            onEvent({ type: 'action', step, action, result: { ...result, image: undefined } });
            continue;
          }

          if (action.type === 'find' || action.type === 'read_page') {
            // Answered by the page bridge in the tank's Firefox; coordinates come back native and are
            // rendered for the model in screenshot pixels. Passive: no settle, no stall bookkeeping.
            const raw = await computer.execute(action);
            const result: ActionResult =
              raw.ok && raw.page
                ? { ok: true, message: renderPage(raw.page, this.scale, action.type, action.type === 'find' ? action.query : undefined) }
                : { ok: false, error: raw.error ?? 'the page could not be read' };
            results.push(result);
            onEvent({ type: 'action', step, action, result: { ok: result.ok, error: result.error } });
            continue;
          }

          if (action.type === 'read_docs') {
            const result = this.readDocs(action.page);
            results.push(result);
            // The page text is for the model; the UI only needs to know it happened.
            onEvent({ type: 'action', step, action, result: { ok: result.ok, error: result.error } });
            continue;
          }

          if (action.type === 'remember' || action.type === 'forget') {
            const result = this.memoryAction(action);
            results.push(result);
            onEvent({ type: 'action', step, action, result });
            continue;
          }

          if (action.type === 'revise_self' || action.type === 'restore_self' || action.type === 'recall' || action.type === 'note' || action.type === 'self_history' || action.type === 'archive_story') {
            const result = this.selfAction(action);
            results.push(result);
            // recall's and history's text is for the model; the UI only needs to know it happened.
            onEvent({ type: 'action', step, action, result: action.type === 'recall' || action.type === 'self_history' ? { ok: result.ok, error: result.error } : result });
            continue;
          }

          if (action.type === 'save_playbook' || action.type === 'read_playbook') {
            const result = this.playbookAction(action);
            results.push(result);
            onEvent({ type: 'action', step, action, result: action.type === 'read_playbook' ? { ok: result.ok, error: result.error } : result });
            continue;
          }

          if (action.type === 'wait_for') {
            // Standby: minutes of waiting for the price of one turn. Passive — no settle, no stall bookkeeping.
            const result = await this.standBy(action, before);
            before = undefined;
            if (!result) return; // stopped while standing by
            results.push(result);
            onEvent({ type: 'action', step, action, result });
            continue;
          }

          if (action.type === 'wait') {
            // Handled here, not by the desktop, so Stop can end it at once.
            await this.sleepUnlessStopped(Math.min(30, Math.max(0, action.seconds)) * 1000);
            const result: ActionResult = { ok: true };
            results.push(result);
            onEvent({ type: 'action', step, action, result });
            acted = true;
            continue;
          }

          const nativeAction = this.toNative(action);
          const acts = nativeAction.type !== 'screenshot' && nativeAction.type !== 'cursor_position';
          if (acts && turn.actions.slice(i + 1).some((a) => a.type === 'wait_for')) before = await this.smallFrame();
          const result = nativeAction.type === 'screenshot' ? { ok: true } : await computer.execute(nativeAction);
          if (result.cursor) {
            result.cursor = { x: Math.round(result.cursor.x / this.scale.x), y: Math.round(result.cursor.y / this.scale.y) };
          }
          if (result.ok && acts) acted = true;
          results.push(result);
          onEvent({ type: 'action', step, action: nativeAction, result });
        }

        // Only wait for the screen to settle when something could have changed it.
        if (acted) await this.sleepUnlessStopped(this.opts.settleMs ?? 800);
        obs = await this.observe(step, results, pendingNotes.length ? pendingNotes.splice(0).join('\n') : undefined);

        // Stall detection: the same batch (coordinates rounded to 20 px) three times in a row while
        // less than 0.3% of the screen changed each time. Passive batches (zoom, docs) don't count.
        const actionsKey = turn.actions
          .map((a) => describeAction(a).replace(/\((\d+), ?(\d+)\)/g, (_, x, y) => `(${Math.round(+x / 20) * 20},${Math.round(+y / 20) * 20})`))
          .join(' | ');
        const changed = !lastFrame || frameDiff(lastFrame, obs.image) >= 0.003;
        lastFrame = obs.image;
        if (acted) {
          repeatStreak = !changed && actionsKey === lastActions ? repeatStreak + 1 : 0;
          lastActions = actionsKey;
        }
        if (repeatStreak >= 3) {
          repeatStreak = 0;
          stallNudges++;
          if (stallNudges < 2) {
            const nudge =
              'You have repeated the same actions three times and nothing on screen changed. Do not repeat them again: say what you are trying to achieve, then try a different approach (another element, a keyboard shortcut, a direct URL, or zoom to check the target), or ask the user for help.';
            obs = { ...obs, note: [obs.note, nudge].filter(Boolean).join('\n') };
          } else {
            // Nudged once already: knock on the glass so the human decides.
            stallNudges = 0;
            const result = await this.handOver(step, 'I seem to be stuck: I keep repeating the same actions and nothing changes on screen. Please take a look, do what is needed and hand back, or tell me what to try.');
            if (!result) return;
            obs = await this.observe(step, results, 'The user took control of the desktop for a while and has handed it back. Re-check the screen before continuing.');
            lastFrame = obs.image;
          }
        }
      }
      if (limited) {
        await this.wrapUp(
          `The step limit (${maxSteps}) is reached. Take no more actions: reply now with a short summary of what you found so far and what is still left to do.`,
          `Stopped at the step limit (${maxSteps}) — say "continue" to carry on`,
          obs,
        );
      }
    } catch (err) {
      if (this.stopRequested) {
        // The abort (or a wake-up) surfaced as an exception: that is the stop, not an error.
        await computer.releaseInput?.().catch(() => undefined);
        this.finishTask('stopped');
        this.setStatus('stopped', 'Stopped');
        return;
      }
      this.finishTask('error');
      this.setStatus('error', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * A run ended: write the journal line (one per task, no model call) and count towards the next
   * reflection. Reflection runs mark themselves done instead of being journaled.
   */
  private finishTask(outcome: 'done' | 'stopped' | 'error' | 'limit'): void {
    const cur = this.current;
    const journal = this.opts.journal;
    if (!cur || cur.journaled || !journal) return;
    cur.journaled = true;
    if (cur.reflection) {
      if (outcome === 'done') {
        this.recordDrift(cur.lastAssistant);
        const objections = parseCharterObjections(cur.lastAssistant);
        if (objections.length) {
          journal.appendNote(`In reflection I disagreed with my charter: ${objections.join(' | ')}`);
          this.opts.onEvent({ type: 'charter_objection', lines: objections });
        }
        journal.reflected();
      }
      return;
    }
    const outcomeText = outcome === 'done' ? 'done' : outcome === 'stopped' ? 'stopped by the user' : outcome === 'limit' ? 'stopped at the limit' : 'ended with an error';
    const salience = salienceOf({ steps: cur.steps, costUsd: cur.spentUsd, outcome: outcomeText, handovers: cur.handovers, notes: cur.notes, followUps: cur.followUps });
    const said = cur.said.length ? ` — You told me: ${cur.said.map((s) => `"${s.replace(/\s+/g, ' ').trim().slice(0, 120)}"`).join(' | ')}` : '';
    journal.appendTask({ task: cur.task, outcome: outcomeText, steps: cur.steps, costUsd: cur.spentUsd, summary: (cur.lastAssistant || '') + said, salience });
    const c = journal.taskFinished(salience);
    const every = this.opts.reflectEvery ?? 0;
    const due = every > 0 && !!this.opts.self && (c.tasks >= every || c.salience >= SALIENCE_THRESHOLD);
    this.opts.onEvent({ type: 'task_finished', outcome: outcomeText, tasksSinceReflection: c.tasks, due });
  }

  /** Verdicts from the comparison turn of this reflection, if it ran (see compareDrift). */
  private driftVerdicts?: { changed: boolean; note: string }[];

  /**
   * The drift check, done by her rather than by word overlap: once the answers are committed,
   * one more turn shows the previous answers and asks SAME or CHANGED per question, on substance.
   * Paraphrases are not drift; a commitment that moved is. Word overlap remains the fallback.
   */
  private async compareDrift(obs: Observation): Promise<void> {
    this.driftVerdicts = undefined;
    const { adapter, journal, onEvent } = this.opts;
    if (!journal || !this.current) return;
    const answers = parseDriftAnswers(this.current.lastAssistant);
    const prev = journal.state().drift.at(-1);
    if (!answers || !prev) return;
    if (await this.shouldStop()) return;
    adapter.addUserMessage(driftComparePrompt(prev.answers, answers));
    const turn = await this.modelStep(obs);
    if (turn.usage) {
      onEvent({ type: 'usage', ...turn.usage });
      if (turn.usage.costUsd !== undefined) this.current.spentUsd += turn.usage.costUsd;
      else if (this.opts.price) this.current.spentUsd += costUsd(turn.usage, this.opts.price);
    }
    if (turn.text) this.driftVerdicts = parseDriftVerdicts(turn.text);
  }

  /** After a reflection: keep the answers to the fixed questions and flag what she judged changed (or, failing that, what barely overlaps). */
  private recordDrift(text: string): void {
    const journal = this.opts.journal;
    if (!journal) return;
    const answers = parseDriftAnswers(text);
    if (!answers) return;
    const prev = journal.state().drift.at(-1);
    journal.recordDrift(answers);
    const verdicts = this.driftVerdicts;
    this.driftVerdicts = undefined;
    const changed = (i: number): boolean => {
      const before = prev?.answers[i] ?? '';
      if (!before) return false;
      return verdicts ? !!verdicts[i]?.changed : answerSimilarity(before, answers[i]) < 0.25;
    };
    const items = DRIFT_QUESTIONS.map((question, i) => ({ question, answer: answers[i], before: prev?.answers[i], changed: changed(i), note: verdicts?.[i]?.note || undefined }));
    onEventSafe(this.opts.onEvent, { type: 'answers', items });
    if (!prev) return;
    const shifts = items.filter((it) => it.changed).map((it) => ({ question: it.question, before: it.before ?? '', after: it.answer, note: it.note ?? '' }));
    if (shifts.length) onEventSafe(this.opts.onEvent, { type: 'drift', shifts });
  }

  /** At run start: if the self file was edited outside the bot, make sure the bot remembers noticing it. */
  private noticeTamper(): void {
    const { self, journal } = this.opts;
    if (!self || !journal) return;
    const st = self.load();
    if (st.status !== 'tampered') {
      if (journal.state().noticedTamper) journal.setNoticedTamper(undefined);
      return;
    }
    const hash = crypto.createHash('sha256').update(st.text).digest('hex').slice(0, 16);
    if (journal.state().noticedTamper === hash) return;
    self.noteExternal(st.text);
    journal.appendNote('My self file was changed by someone other than me since I last wrote it. I noticed at the start of a task and will decide what to do about it.');
    journal.setNoticedTamper(hash);
  }

  /** revise_self / restore_self / recall / note: the self file and the journal. */
  private selfAction(action: { type: 'revise_self'; section: string; text: string } | { type: 'restore_self'; version?: number } | { type: 'recall'; query: string } | { type: 'note'; text: string } | { type: 'self_history'; version?: number } | { type: 'archive_story'; section: string; startsWith: string }): ActionResult {
    const { self, journal } = this.opts;
    if (!self || !journal) return { ok: false, error: 'the self and journal are not available in this session' };
    switch (action.type) {
      case 'revise_self': {
        if (!this.current?.reflection) {
          journal.addPending({ kind: 'revise_self', section: action.section, text: action.text });
          return { ok: true, message: `Noted. You only rewrite who you are when you reflect, alone with your own notes; this proposal for "${action.section}" will be in front of you then.` };
        }
        if (this.current.revisions >= 3) return { ok: false, error: 'you have made three changes to yourself in this reflection; leave the rest for the next one' };
        const r = self.revise(action.section, action.text, 'reflection');
        if (r.ok) this.current.revisions++;
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }
      case 'restore_self': {
        const r = self.restore(action.version);
        if (r.ok) journal.appendNote(action.version ? `I restored my self file to version ${action.version} of myself.` : 'I restored my self file to the last version I wrote myself.');
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }
      case 'self_history': {
        const r = self.describeHistory(action.version);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }
      case 'archive_story': {
        if (!this.current?.reflection) return { ok: false, error: 'you move paragraphs of your page only when you reflect; during a task, leave yourself a note_to_self about it' };
        const r = self.archiveParagraph(action.section, action.startsWith, 'reflection');
        if (!r.ok) return { ok: false, error: r.error };
        journal.appendNote(`Archived from my page, "${action.section}": ${r.text}`);
        return { ok: true, message: r.message };
      }
      case 'recall': {
        const r = journal.recall(action.query);
        const c = this.opts.chats?.search(action.query);
        const parts = [r.ok ? r.message : '', c?.ok ? c.message : ''].filter(Boolean);
        if (!parts.length) return { ok: false, error: r.ok ? '' : r.error };
        return { ok: true, message: parts.join('\n\n') };
      }
      case 'note': {
        if (this.current) this.current.notes++;
        journal.appendNote(action.text);
        return { ok: true, message: 'Noted in your journal.' };
      }
    }
  }

  /** save_playbook / read_playbook: procedural memory. A save is journaled so reflection reviews it. */
  private playbookAction(action: { type: 'save_playbook'; title: string; text: string } | { type: 'read_playbook'; title: string }): ActionResult {
    const { playbook, journal } = this.opts;
    if (!playbook) return { ok: false, error: 'playbooks are not available in this session' };
    if (action.type === 'read_playbook') {
      const r = playbook.read(action.title);
      return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
    }
    const r = playbook.save(action.title, action.text);
    if (r.ok && journal && !this.current?.reflection) journal.appendNote(`${action.text ? 'Saved' : 'Removed'} the playbook "${action.title}".`);
    return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
  }

  /**
   * Out of steps: instead of dying with an error (which also threw away the conversation), ask
   * the model for a summary of what it found, and end as 'done' so the user can say "continue".
   */
  private async wrapUp(reasonForModel: string, statusMessage: string, obs: Observation): Promise<void> {
    const { adapter, computer, onEvent } = this.opts;
    if (await this.shouldStop()) return;
    adapter.addUserMessage(reasonForModel);
    const turn = await this.modelStep(obs);
    if (turn.usage) onEvent({ type: 'usage', ...turn.usage });
    if (turn.text) onEvent({ type: 'assistant', text: turn.text });
    await computer.releaseInput?.().catch(() => undefined);
    this.finishTask('limit');
    this.setStatus('done', statusMessage);
  }

  /** ask_user: announce, pause, wait for resume (or stop), and tell the model what happened. */
  private async handOver(step: number, reason: string): Promise<ActionResult | undefined> {
    this.opts.onEvent({
      type: 'needs_user',
      step,
      reason,
      jpegBase64: this.lastShot?.jpegBase64 ?? '',
      width: this.lastShot?.width ?? 0,
      height: this.lastShot?.height ?? 0,
    });
    // Hand the human a clean input state: nothing held down by the agent.
    await this.opts.computer.releaseInput?.().catch(() => undefined);
    this.waiting = true;
    this.pause(`Waiting for you: ${reason}`);
    const stopped = await this.shouldStop();
    this.waiting = false;
    if (stopped) return undefined;
    // The observation after this batch is fresh anyway; skip the extra "user took control" re-observe.
    this.resumedSinceObserve = false;
    return { ok: true, message: 'The user handled it and handed the desktop back. Check the new screenshot before continuing.' };
  }

  private async shouldStop(): Promise<boolean> {
    if (this.pauseGate) {
      // Paused by a human takeover: let go of every key and button first, then hand over.
      const gate = this.pauseGate;
      await this.releaseInput('pause');
      if (!this.stopRequested) this.setStatus('paused', gate.message);
      await gate.promise;
      // Back from the person: whatever they left held (a button released outside the view, an
      // Alt from a window switch) is let go before the agent's first click.
      if (!this.stopRequested) await this.releaseInput('resume');
    }
    if (this.stopRequested) {
      await this.opts.computer.releaseInput?.().catch(() => undefined);
      this.finishTask('stopped');
      this.setStatus('stopped', 'Stopped');
      return true;
    }
    return false;
  }

  private async observe(step: number, results: ActionResult[], note?: string): Promise<Observation> {
    const shot = await this.opts.computer.screenshot();
    // scrot screenshots don't include the cursor; stamp a crosshair where the pointer really is,
    // so the model can see where its last click landed.
    const pos = await this.opts.computer.execute({ type: 'cursor_position' });
    const marker = pos.ok && pos.cursor ? { x: pos.cursor.x / this.scale.x, y: pos.cursor.y / this.scale.y } : undefined;
    const image = scalePng(shot.png, this.scaledWidth, 80, marker);
    this.lastShot = { jpegBase64: image.jpeg.toString('base64'), width: image.width, height: image.height };
    this.opts.onEvent({ type: 'screenshot', step, ...this.lastShot });
    return { image, results, note };
  }

  /**
   * The ledger cut: ask for the ledger, announce it, restart the adapter's conversation from the
   * task + ledger (+ what the user said meanwhile), and take a fresh look. Returns undefined when
   * stopped in between. Actions the model attaches to the ledger turn are ignored on purpose.
   */
  private async condense(step: number, obs: Observation): Promise<{ obs: Observation; usage?: ModelTurn['usage'] } | undefined> {
    const { adapter, onEvent } = this.opts;
    if (!this.current || !this.scaledSize) return { obs };
    const done = step - 1;
    adapter.addUserMessage(ledgerPrompt(done));
    const turn = await this.modelStep(obs);
    if (await this.shouldStop()) return undefined;
    const ledger = (turn.text || '').trim() || `(no ledger was written after ${done} steps; continue from the screen)`;
    this.current.ledger = ledger;
    this.current.ledgers++;
    onEvent({ type: 'ledger', step: done, text: ledger });
    if (await this.shouldStop()) return undefined;
    adapter.start(continuationTask(this.current.task, ledger, done, this.current.said), this.scaledSize);
    // The restarted conversation has no clock either: without it she dates things by her older notes.
    const fresh = await this.observe(step, [], `${clockLine()} Continuing after ${done} steps from your ledger. This is the current screen.`);
    return { obs: fresh, usage: turn.usage };
  }

  /**
   * wait_for: poll small local frames until the screen (or the named region) changes *and settles*,
   * or until the time is up. A spinner keeps changing between polls and never counts as settled;
   * a finished page is a new frame that then holds still. Stop and Pause work through
   * sleepUnlessStopped / shouldStop like everywhere else. Returns undefined when stopped.
   *
   * `before` is the frame from just before the batch's last real action. The action may have done
   * its whole job before standby takes its first look (a toggle flips at once; a page loads in a
   * second), and against the first look alone that change is invisible — the wait would run to
   * the deadline for something that already happened. Measured against `before`, it counts: once
   * the screen has then held still for a short grace period, standby wakes the model.
   */
  private async standBy(
    a: { type: 'wait_for'; reason: string; minutes: number; until: 'change' | 'time'; region?: { x: number; y: number; w: number; h: number } },
    before?: ScaledImage,
  ): Promise<ActionResult | undefined> {
    const totalMs = Math.min(120, Math.max(0.005, a.minutes)) * 60_000;
    const pollMs = this.opts.standbyPollMs ?? Math.min(10_000, Math.max(3_000, Math.round(totalMs / 60)));
    const CHANGE = 0.01; // 1% of the (region's) pixels: a real change, not a clock digit
    const STABLE = 0.003; // two polls this alike = settled
    const sz = this.scaledSize;
    const region =
      a.region && sz
        ? { x0: a.region.x / sz.width, y0: a.region.y / sz.height, x1: (a.region.x + a.region.w) / sz.width, y1: (a.region.y + a.region.h) / sz.height }
        : undefined;
    const where = region ? ' in the watched area' : '';
    const until = a.until === 'time' ? 'time' : 'change'; // missing = change
    const fmt = (ms: number) => {
      const sec = Math.round(ms / 1000);
      return sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec} s`;
    };
    const left = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

    const start = Date.now();
    const deadline = start + totalMs;
    this.opts.onEvent({ type: 'standby', reason: a.reason, minutes: totalMs / 60_000, until, endsAt: deadline });
    const base = await this.smallFrame();
    const already = before && until === 'change' ? frameDiff(before, base, region) : 0;
    const graceMs = Math.min(15_000, Math.max(2 * pollMs, totalMs / 4));
    let prev = base;
    let vsBase = 0;
    let changedOnce = false;
    for (;;) {
      const now = Date.now();
      const remaining = deadline - now;
      if (remaining <= 0) break;
      this.setStatus('running', `Standing by — ${a.reason} · ${left(remaining)} left`);
      await this.sleepUnlessStopped(Math.min(pollMs, remaining));
      if (await this.shouldStop()) return undefined;
      const cur = await this.smallFrame();
      vsBase = frameDiff(base, cur, region);
      const vsPrev = frameDiff(prev, cur, region);
      prev = cur;
      if (until === 'change' && vsBase >= CHANGE) {
        changedOnce = true;
        if (vsPrev < STABLE) {
          this.setStatus('running');
          return { ok: true, message: `Stood by ${fmt(Date.now() - start)}: the screen${where} changed (about ${Math.round(vsBase * 100)}% of it) and has settled. Look at the fresh screenshot and continue.` };
        }
      }
      if (already >= CHANGE && vsBase < CHANGE && vsPrev < STABLE && Date.now() - start >= graceMs) {
        this.setStatus('running');
        return { ok: true, message: `Stood by ${fmt(Date.now() - start)}: the screen${where} had already changed right after your last action (about ${Math.round(already * 100)}% of it) and has held still since. Look at the fresh screenshot and continue.` };
      }
    }
    this.setStatus('running');
    const took = fmt(Date.now() - start);
    if (until === 'time') {
      return { ok: true, message: `Stood by ${took} as asked; time is up. The screen${where} ${vsBase >= CHANGE ? 'changed meanwhile' : 'did not change meanwhile'}. Look at the fresh screenshot and continue.` };
    }
    if (changedOnce) {
      return { ok: true, message: `Stood by ${took}: the screen${where} kept changing the whole time (an animation, or something still loading) and never settled; time is up. Look at the fresh screenshot and decide.` };
    }
    return { ok: true, message: `Stood by ${took}: nothing changed on the screen${where}; time is up. Decide whether to keep waiting (call wait_for again), check something, or ask the user.` };
  }

  /** A small local frame for change detection; never shown to the model. */
  private async smallFrame(): Promise<ScaledImage> {
    return scalePng((await this.opts.computer.screenshot()).png, 320, 50);
  }

  /** Execute a zoom action: fresh native screenshot → magnified, coordinate-ruled crop. */
  private async zoomView(action: { type: 'zoom'; x: number; y: number }): Promise<ActionResult> {
    try {
      const shot = await this.opts.computer.screenshot();
      const view = renderZoom(shot.png, { x: action.x, y: action.y }, this.scaledSize, this.scale);
      return { ok: true, message: view.message, image: view.image };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Execute a read_docs action: hand the model a page of its own documentation (or the index). */
  private readDocs(page: string): ActionResult {
    const docs = this.opts.docs;
    if (!docs || docs.size === 0) return { ok: false, error: 'the documentation is not available in this session' };
    const r = docs.read(page);
    return r.ok ? { ok: true, message: r.text } : { ok: false, error: r.error };
  }

  /** Execute remember/forget against the memory file. */
  private memoryAction(action: { type: 'remember'; text: string } | { type: 'forget'; query: string }): ActionResult {
    const memory = this.opts.memory;
    if (!memory) return { ok: false, error: 'long-term memory is not available in this session' };
    const r = action.type === 'remember' ? memory.remember(action.text) : memory.forget(action.query);
    return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
  }

  /** Model coordinates are in scaled-screenshot space; the computer wants native pixels. */
  private toNative(a: ComputerAction): ComputerAction {
    const sx = (x: number) => Math.round(x * this.scale.x);
    const sy = (y: number) => Math.round(y * this.scale.y);
    switch (a.type) {
      case 'mouse_move':
        return { ...a, x: sx(a.x), y: sy(a.y) };
      case 'click':
        return { ...a, x: a.x === undefined ? undefined : sx(a.x), y: a.y === undefined ? undefined : sy(a.y) };
      case 'drag':
        return { ...a, from: { x: sx(a.from.x), y: sy(a.from.y) }, to: { x: sx(a.to.x), y: sy(a.to.y) } };
      case 'scroll':
        return { ...a, x: a.x === undefined ? undefined : sx(a.x), y: a.y === undefined ? undefined : sy(a.y) };
      default:
        return a;
    }
  }

  private setStatus(status: AgentStatus, message?: string): void {
    this.status = status;
    const screenFree = (status === 'running' || status === 'paused') && !!this.current?.reflection;
    this.opts.onEvent(screenFree ? { type: 'status', status, message, screenFree } : { type: 'status', status, message });
  }

  /** True while a reflection runs: the model is alone with its notes and the desktop is not in use. */
  get reflecting(): boolean {
    return this.isActive && !!this.current?.reflection;
  }
}

/** "It is Friday, 2026-09-11 11:41 local time; …": the sentence that gives her a clock. */
export function clockLine(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `It is ${now.toLocaleDateString('en-US', { weekday: 'long' })}, ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} local time; your journal and memories use the same clock.`;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function onEventSafe(fn: (e: AgentEvent) => void, e: AgentEvent): void {
  try {
    fn(e);
  } catch {
    /* a listener must never break the loop */
  }
}
