import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ReplayItem } from '../agent/chats';
import type { AgentEvent } from '../agent/loop';
import { describeAction } from '../computer/types';
import { endFragment } from '../agent/journal';
import { costUsd, priceForConfig } from '../agent/pricing';
import { driftLine } from '../agent/prompts';
import { GatewayClient } from './client';
import type { ChatInfo, Snapshot } from './protocol';
import { VERSION } from './version';

/**
 * `deskfish mcp` — the door a coding agent knocks on. An MCP server over stdio that is one more
 * *client* of the gateway (`ClientKind: 'mcp'`): it owns nothing, writes none of her files, and
 * every tool is a command on the wire. A Claude Code or Codex session registered with
 * `claude mcp add --scope user deskfish -- deskfish mcp` can give her a task, watch it, look at
 * her screen, read her files and tell her what to do differently — in the chat, like a person.
 *
 * Two rules shape the surface (decision 107): teaching happens in the chat and never in her files,
 * so no tool writes anything of hers; and a refusal is a plain sentence, never an exception, the
 * way the ask bridge answers the views.
 *
 * Nothing may be written to stdout but the protocol — every line of ours goes to stderr.
 */

/** How long `wait` blocks by default, and the most it will. Claude Code's desktop app cuts a tool call at about 60 s. */
const WAIT_DEFAULT = 50;
const WAIT_MAX = 120;

type Json = Record<string, unknown>;

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const json = (v: Json) => text(JSON.stringify(v, null, 2));

/**
 * What the chat so far cost: the provider's own figure when it reports one (OpenRouter), otherwise an
 * estimate at the model's list price — the same arithmetic as the chat's usage line and the journal.
 * Without either, nothing at all: a teacher must not read "0" as "free" when it means "unknown".
 */
export function costOf(u: Snapshot['usage'], cfg: Snapshot['config']): { costUsd?: number; costEstimated?: true; billing?: 'subscription' } | undefined {
  // Signed in with Grok: the run draws a pool the person's plan already paid for. There is no
  // per-token charge to report and no list price that applies, so the teacher is told what it is
  // instead of a number it would read as money.
  if (cfg.auth) return { billing: 'subscription' };
  if (!u) return undefined;
  const round = (x: number) => Math.round(x * 1e4) / 1e4;
  if (u.costUsd && u.costUsd > 0) return { costUsd: round(u.costUsd) };
  const price = priceForConfig({ provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl });
  return price ? { costUsd: round(costUsd(u, price)), costEstimated: true } : undefined;
}

/** The teacher's own words back in an item: it knows what it sent, so the echo is trimmed. */
const SAID_CUT = 1000;

/**
 * The items since this session connected: the same things the chat shows, built from the events the
 * gateway pushes exactly as the service builds a transcript. Text only — an image belongs to
 * `screenshot`, not to a replay.
 */
export class ItemLog {
  items: ReplayItem[] = [];
  /** A reconnect replaced the list; the next `wait` says so and starts again from 0. */
  resynced = false;

  seed(chat: ReplayItem[], resync: boolean): void {
    this.items = [...chat];
    if (resync) this.resynced = true;
  }

  push(item: ReplayItem): void {
    // Consecutive actions of one step are one chip, the way the chat and `parseTranscript` group them.
    const last = this.items[this.items.length - 1];
    if (item.kind === 'actions' && last?.kind === 'actions' && last.step === item.step) {
      last.actions.push(...item.actions);
      return;
    }
    this.items.push(item);
  }

  /** The service's `record()`, for a client: what the transcript would have gained from this event. */
  absorb(e: AgentEvent): void {
    switch (e.type) {
      case 'assistant':
        this.push({ kind: 'assistant', text: e.text });
        break;
      case 'action': {
        const a = e.action.type;
        // The runner's own words for the step travel with the event; this process may be older than
        // the build that added the action (decision 127), and then its describeAction has no case for it.
        const what = e.describe ?? describeAction(e.action);
        if (a === 'wait_for') {
          this.push({ kind: 'note', text: e.result.ok ? `⏳ ${(e.result.message ?? 'Stood by').split(/[;.] /)[0]} (${what})` : `⏳ Standby failed: ${e.result.error ?? ''}` });
          break;
        }
        const memoryish = a === 'remember' || a === 'forget' || a === 'revise_self' || a === 'restore_self' || a === 'note' || a === 'save_playbook' || a === 'archive_story';
        if (memoryish) this.push({ kind: 'note', text: e.result.ok ? (e.result.message ?? what) : `${what} — not done: ${e.result.error ?? ''}` });
        else this.push({ kind: 'actions', step: e.step, actions: [{ text: what, failed: !e.result.ok }] });
        break;
      }
      case 'needs_user':
      case 'needs_fill':
        // A sign-in card is a knock too: a teacher watching through `wait` is told she is waiting
        // for a person, in her own words. What the person then types never comes through here.
        this.push({ kind: 'needs_user', text: e.reason });
        break;
      case 'status':
        if (e.status === 'done' || e.status === 'stopped' || e.status === 'error') this.push({ kind: 'status', text: `${e.status}${e.message ? ` — ${e.message}` : ''}${endFragment(e.end)}` });
        break;
      case 'ledger':
        this.push({ kind: 'note', text: `📒 Ledger after ${e.step} steps: ${e.text.replace(/\s*\n+\s*/g, ' / ')}` });
        break;
      case 'drift':
        for (const s of e.shifts) this.push({ kind: 'note', text: driftLine(s) });
        break;
      case 'charter_objection':
        for (const l of e.lines) this.push({ kind: 'note', text: `She disagrees with her charter: ${l}` });
        break;
      default:
        break;
    }
  }
}

/** The tool surface over one `GatewayClient`. Nothing here owns a store, a runner or an engine. */
export class DeskfishMcp {
  private readonly log = new ItemLog();
  /** Set when she knocks; cleared when she is released or a new task starts. */
  private knock?: string;
  /** The `paused` that follows a knock has been seen, so the next `running` is her being released. */
  private knockPaused = false;
  /** Mirrors the gateway: true while a task runs or waits for the desktop. Confirmed by a snapshot before `wait` returns. */
  private busy = false;
  private wake: (() => void)[] = [];
  private connectedOnce = false;

  constructor(private readonly client: GatewayClient) {
    client.on('connected', (snap: Snapshot) => {
      this.log.seed(snap.chat, this.connectedOnce);
      this.connectedOnce = true;
      this.busy = snap.busy || snap.queued > 0;
      this.notify();
    });
    client.on('task', (t: { text: string }) => {
      this.knock = undefined;
      this.busy = true;
      this.log.push({ kind: 'user', text: t.text.length > SAID_CUT ? `${t.text.slice(0, SAID_CUT)}…` : t.text });
      this.notify();
    });
    client.on('notice', (n: { text: string }) => {
      this.log.push({ kind: 'note', text: n.text });
      this.notify();
    });
    client.on('reset', () => {
      this.log.items = [];
      this.knock = undefined;
      this.notify();
    });
    client.on('replay', (r: { items: ReplayItem[] }) => {
      this.log.items = [...r.items];
      this.notify();
    });
    client.on('event', (e: AgentEvent) => {
      this.log.absorb(e);
      if (e.type === 'needs_user' || e.type === 'needs_fill') {
        this.knock = e.reason;
        this.knockPaused = false;
      }
      if (e.type === 'status') {
        this.busy = e.status === 'running' || e.status === 'paused';
        // A knock runs status → running ("Pausing — finishing the current action…") → paused
        // ("Waiting for you: …"), so only a `running` *after* the pause means she was released.
        if (e.status === 'paused') this.knockPaused = true;
        else if (e.status === 'running' && this.knockPaused) {
          this.knock = undefined;
          this.knockPaused = false;
        }
        if (!this.busy) {
          this.knock = undefined;
          this.knockPaused = false;
        }
      }
      this.notify();
    });
  }

  /**
   * She is waiting for a person when the gateway says so: `ask_user` pauses her with
   * "Waiting for you: <reason>". The `needs_user` event sets the knock at once (so `wait` returns
   * without a round trip), and every snapshot then confirms or clears it — a person who answers in
   * VS Code releases her without this process hearing a thing it could recognise on its own.
   */
  private readKnock(snap: Snapshot | undefined): string | undefined {
    if (!snap) return this.knock;
    const prefix = 'Waiting for you: ';
    const m = snap.statusMessage ?? '';
    if (snap.status === 'paused' && m.startsWith(prefix)) {
      this.knock = m.slice(prefix.length);
      this.knockPaused = true;
    } else if (!snap.busy || (snap.status === 'running' && this.knockPaused)) {
      this.knock = undefined;
      this.knockPaused = false;
    }
    return this.knock;
  }

  private notify(): void {
    const woke = this.wake;
    this.wake = [];
    for (const w of woke) w();
  }

  /** Resolves on the next event from the gateway, or after `ms`. */
  private activity(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(fire, ms);
      this.wake.push(fire);
    });
  }

  private async snapshot(): Promise<Snapshot> {
    return this.client.refreshSnapshot();
  }

  /** The chunk of items after `cursor`, and where the cursor now is. */
  private since(cursor?: number): { items: ReplayItem[]; cursor: number; note?: string } {
    if (this.log.resynced) {
      this.log.resynced = false;
      return { items: this.log.items, cursor: this.log.items.length, note: 'The connection to the gateway dropped and came back; the list starts again from the chat as it is now, so your cursor was reset.' };
    }
    const from = Math.min(Math.max(0, cursor ?? 0), this.log.items.length);
    return { items: this.log.items.slice(from), cursor: this.log.items.length };
  }

  /* ---------- the tools ---------- */

  async run(task: string, reason: string): Promise<ReturnType<typeof text>> {
    // Taken before the task is sent: the item the task itself becomes must be in the first `wait`.
    const cursor = this.log.items.length;
    let failed: string | undefined;
    // A task that has to turn the tank on first can take half a minute to be accepted; the answer
    // does not wait for that, because the queue already has it.
    const sent = this.client.run(task, undefined, { reason }).catch((err: unknown) => {
      failed = err instanceof Error ? err.message : String(err);
    });
    await Promise.race([sent, new Promise((r) => setTimeout(r, 5000))]);
    if (failed) return text(`She did not take the task: ${failed}`);
    const snap = await this.snapshot().catch(() => undefined);
    const queued = snap?.queued ?? 0;
    return json({
      accepted: true,
      queued,
      cursor,
      note: queued
        ? `She is busy; this task is number ${queued} in her queue and starts when the one before it ends.`
        : 'She has it. Call wait to watch; the tank may still be turning on.',
    });
  }

  async say(message: string): Promise<ReturnType<typeof text>> {
    const snap = await this.snapshot();
    if (!snap.busy) return text('She is idle — use run; a run in the same chat continues the conversation.');
    await this.client.say(message);
    this.log.push({ kind: 'user', text: message.length > SAID_CUT ? `${message.slice(0, SAID_CUT)}…` : message });
    this.knock = undefined;
    this.knockPaused = false;
    return text('Said. If she was waiting for you, she is going again.');
  }

  async wait(timeoutSeconds: number | undefined, cursor: number | undefined): Promise<ReturnType<typeof text>> {
    const limit = Math.min(WAIT_MAX, Math.max(1, timeoutSeconds ?? WAIT_DEFAULT));
    const deadline = Date.now() + limit * 1000;
    for (;;) {
      if (this.knock) break;
      if (!this.busy) {
        // The mirror can be one event behind the queue (a second task starts the moment the first ends).
        const snap = await this.snapshot().catch(() => undefined);
        if (!snap || (!snap.busy && !snap.queued)) break;
        this.busy = true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.activity(Math.min(remaining, 2000));
    }
    const snap = await this.snapshot().catch(() => undefined);
    const knock = this.readKnock(snap);
    const chunk = this.since(cursor);
    return json({
      status: snap?.status ?? (this.busy ? 'running' : 'idle'),
      statusMessage: snap?.statusMessage,
      busy: snap ? snap.busy || snap.queued > 0 : this.busy,
      queued: snap?.queued ?? 0,
      ...(knock ? { knock } : {}),
      cursor: chunk.cursor,
      items: chunk.items,
      ...(chunk.note ? { note: chunk.note } : {}),
    });
  }

  async status(): Promise<ReturnType<typeof text>> {
    const s = await this.snapshot();
    const knock = this.readKnock(s);
    const lastUser = [...s.chat].reverse().find((i) => i.kind === 'user');
    const u = s.usage;
    return json({
      status: s.status,
      statusMessage: s.statusMessage,
      busy: s.busy,
      queued: s.queued,
      ...(knock ? { knock } : {}),
      task: lastUser && lastUser.kind === 'user' ? lastUser.text.slice(0, 300) : undefined,
      step: s.screenshot?.step ?? 0,
      ...(costOf(u, s.config) ?? {}),
      tokens: u ? { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } : undefined,
      model: s.config.model,
      provider: s.config.provider,
      desktop: s.desktop.status.state,
      cursor: this.log.items.length,
      version: s.version,
    });
  }

  async transcript(chat?: string): Promise<ReturnType<typeof text>> {
    if (chat) {
      const past = await this.client.call('chats.open', { name: chat });
      return json({ chat: past.info as unknown as Json, items: past.items });
    }
    const s = await this.snapshot();
    return json({ chat: 'the chat she is in now', items: s.chat, cursor: this.log.items.length });
  }

  async screenshot(fresh: boolean): Promise<{ content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] }> {
    let shot: { dataUrl: string; width: number; height: number; step?: number } | undefined;
    if (fresh) {
      try {
        shot = await this.client.call('desktop.screenshot');
      } catch (err) {
        return { content: [{ type: 'text', text: `No fresh frame: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    } else {
      const s = await this.snapshot();
      shot = s.screenshot;
      if (!shot) return { content: [{ type: 'text', text: 'She has taken no screenshot in this chat yet. Call screenshot with fresh true for a look at the tank as it is now.' }] };
    }
    const comma = shot.dataUrl.indexOf(',');
    const data = comma >= 0 ? shot.dataUrl.slice(comma + 1) : shot.dataUrl;
    return {
      content: [
        { type: 'text', text: `${fresh ? 'The tank now' : `The last frame she saw (step ${shot.step ?? 0})`}, ${shot.width}×${shot.height}.` },
        { type: 'image', data, mimeType: 'image/jpeg' },
      ],
    };
  }

  async stop(): Promise<ReturnType<typeof text>> {
    await this.client.stop();
    this.knock = undefined;
    return text('Stopped. Whatever she was doing — a task, a standby, waiting for you — has ended.');
  }

  async newChat(): Promise<ReturnType<typeof text>> {
    await this.client.newConversation();
    return text('New chat. The one before it is filed and readable through chats and transcript.');
  }

  async chats(filter?: string): Promise<ReturnType<typeof text>> {
    const list = await this.client.call('chats.list');
    const f = (filter ?? '').trim().toLowerCase();
    const rows = f ? list.filter((c: ChatInfo) => `${c.name} ${c.firstTask} ${c.outcome ?? ''}`.toLowerCase().includes(f)) : list;
    return json({ chats: rows as unknown as Json[], note: 'The chat she is in now is not a past chat; transcript with no argument shows it.' });
  }

  async file(which: 'self' | 'journal' | 'playbooks' | 'memory', file: 'memory.md' | 'charter.md'): Promise<ReturnType<typeof text>> {
    if (which === 'self') return text(await this.client.call('self.read'));
    if (which === 'journal') return text(await this.client.call('journal.read'));
    if (which === 'playbooks') return text(await this.client.call('playbook.read'));
    const m = await this.client.call('memory.read', { file });
    return text(`${m.text}\n\n(${m.facts} fact${m.facts === 1 ? '' : 's'} in ${file})`);
  }

  async reflect(): Promise<ReturnType<typeof text>> {
    const r = await this.client.reflect();
    return text(
      r === 'started'
        ? 'She is reflecting: she reads the chat, writes her journal and may revise her own page. It is hers — read it afterwards with self and journal.'
        : r === 'busy'
          ? 'She is busy; a reflection starts when she is free, or at the next due one.'
          : 'The reflection could not start (no self page, or no model configured).',
    );
  }
}

/** Every tool, with the descriptions a teacher reads. Nothing here writes a file of hers. */
export function buildMcpServer(client: GatewayClient): McpServer {
  const d = new DeskfishMcp(client);
  const server = new McpServer({ name: 'deskfish', version: VERSION }, { capabilities: { tools: {} } });

  server.registerTool(
    'run',
    {
      title: 'Give Deskfish a task',
      description:
        'Give her a task in her chat, the way a person types one. She works on her own Linux desktop (the tank): browser, terminal, files. ' +
        'If she is busy the task is queued and starts when the one before it ends; if the tank is off she turns it on herself. ' +
        'Say who you are and why in the first line when you are teaching — she is told the run carries a reason, not who sent it. ' +
        'After a finished task a second run continues the same conversation, which is how you give feedback. Then call wait.',
      inputSchema: { task: z.string().describe('The task, in plain words, as the person would write it'), reason: z.string().optional().describe("What put this task here; 'lesson' by default, and it shows in her log and her journal") },
      annotations: { title: 'Give Deskfish a task', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ task, reason }) => d.run(task, (reason ?? 'lesson').trim() || 'lesson'),
  );

  server.registerTool(
    'say',
    {
      title: 'Say something mid-task',
      description: 'A message while she works: a correction, an answer to a knock, more detail. Refused when she is idle — use run then, which continues the same chat.',
      inputSchema: { text: z.string().describe('What to say to her') },
      annotations: { title: 'Say something mid-task', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ text: t }) => d.say(t),
  );

  server.registerTool(
    'wait',
    {
      title: 'Watch until something happens',
      description:
        'Block until the task ends, she knocks on the glass (needs a person), or the timeout. Returns {status, busy, queued, knock?, cursor, items}: the chat items since your cursor — what she said, the steps she took, her standbys, notes, the end. ' +
        'Call it in a loop, passing back the cursor you got, until status is done/stopped/error (busy false) or knock is set. Text only; use screenshot to see the screen. ' +
        'Keep timeoutSeconds under your own per-call tool timeout.',
      inputSchema: {
        timeoutSeconds: z.number().optional().describe(`How long to block at most; ${WAIT_DEFAULT} by default, ${WAIT_MAX} at most`),
        since: z.number().optional().describe('The cursor from the last call; 0 or absent means everything this session has seen'),
      },
      annotations: { title: 'Watch until something happens', readOnlyHint: true, openWorldHint: false },
    },
    async ({ timeoutSeconds, since }) => d.wait(timeoutSeconds, since),
  );

  server.registerTool(
    'status',
    {
      title: 'What she is doing, and what it has cost',
      description: 'Status, the current task, the step she is on, cost and tokens so far in the running task (the cost is the provider\'s own figure, or an estimate at list price marked costEstimated; absent when neither is known, and replaced by billing: "subscription" when she runs on a signed-in plan, where tokens are spent but no money is), her model and provider, whether the tank is on, how many tasks are queued, and a knock if she is waiting for a person. The counts are live: a finished task\'s steps and tokens are on its journal line and at the end of its transcript.',
      inputSchema: {},
      annotations: { title: 'What she is doing', readOnlyHint: true, openWorldHint: false },
    },
    async () => d.status(),
  );

  server.registerTool(
    'transcript',
    {
      title: 'Read a chat',
      description: 'The chat she is in now, or a past one by name (the names come from chats). Text items, the same ones the chat shows.',
      inputSchema: { chat: z.string().optional().describe('The name of a past chat; absent means the one she is in now') },
      annotations: { title: 'Read a chat', readOnlyHint: true, openWorldHint: false },
    },
    async ({ chat }) => d.transcript(chat),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Look at her screen',
      description: 'A picture of the tank. Fresh by default — a passive look that changes nothing and does not interrupt her; with fresh false, the last frame she herself saw, with its step number.',
      inputSchema: { fresh: z.boolean().optional().describe('True (the default) takes a new frame; false returns the last one the loop took') },
      annotations: { title: 'Look at her screen', readOnlyHint: true, openWorldHint: false },
    },
    async ({ fresh }) => d.screenshot(fresh !== false),
  );

  server.registerTool(
    'stop',
    {
      title: 'Stop what she is doing',
      description: 'Ends the running task at once — a standby or a knock included. Stop means stop, from any client.',
      inputSchema: {},
      annotations: { title: 'Stop what she is doing', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async () => d.stop(),
  );

  server.registerTool(
    'new_chat',
    {
      title: 'Start a new chat',
      description: 'Files the current chat and starts an empty one: the boundary between one lesson and the next. The next run does not carry the old conversation.',
      inputSchema: {},
      annotations: { title: 'Start a new chat', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => d.newChat(),
  );

  server.registerTool(
    'chats',
    {
      title: 'Her past chats',
      description: 'The history: every chat with the time it started, its first task, its size and how it ended. Filter by a word in the task or the name.',
      inputSchema: { filter: z.string().optional().describe('Only chats whose name, first task or outcome contains this') },
      annotations: { title: 'Her past chats', readOnlyHint: true, openWorldHint: false },
    },
    async ({ filter }) => d.chats(filter),
  );

  server.registerTool(
    'self',
    {
      title: 'Her page about herself',
      description: 'Her self page as she wrote it, with who signed it last and whether the signature still holds. Read-only: her page is hers, and a correction goes to her in the chat.',
      inputSchema: {},
      annotations: { title: 'Her page about herself', readOnlyHint: true, openWorldHint: false },
    },
    async () => d.file('self', 'memory.md'),
  );

  server.registerTool(
    'journal',
    {
      title: 'Her journal',
      description: 'One line per finished task (outcome, steps, cost, what started it) and every note she left herself. The fastest way to see whether a lesson stuck.',
      inputSchema: {},
      annotations: { title: 'Her journal', readOnlyHint: true, openWorldHint: false },
    },
    async () => d.file('journal', 'memory.md'),
  );

  server.registerTool(
    'playbooks',
    {
      title: 'Her playbooks',
      description: 'The how-tos she has written for herself. She writes them mid-task or in a reflection; nobody else does.',
      inputSchema: {},
      annotations: { title: 'Her playbooks', readOnlyHint: true, openWorldHint: false },
    },
    async () => d.file('playbooks', 'memory.md'),
  );

  server.registerTool(
    'memory',
    {
      title: 'Her long-term memory',
      description: 'Her facts file (memory.md), or her charter — the text she and her maker signed. Read-only.',
      inputSchema: { file: z.enum(['memory.md', 'charter.md']).optional().describe("Which file; 'memory.md' by default") },
      annotations: { title: 'Her long-term memory', readOnlyHint: true, openWorldHint: false },
    },
    async ({ file }) => d.file('memory', file ?? 'memory.md'),
  );

  server.registerTool(
    'reflect',
    {
      title: 'Ask her to reflect now',
      description: 'Folds the lesson while the chat is fresh instead of waiting for her next due reflection: she reads it, writes her journal and may revise her own page. What she keeps is hers.',
      inputSchema: {},
      annotations: { title: 'Ask her to reflect now', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => d.reflect(),
  );

  return server;
}

/** Connect the server to this process's stdio. Returns when the client closes it. */
export async function serveMcp(client: GatewayClient): Promise<void> {
  const server = buildMcpServer(client);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
}
