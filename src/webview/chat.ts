import type { AgentEvent, AgentStatus } from '../agent/loop';
import { describeAction } from '../computer/types';
import { costUsd, priceForConfig } from '../agent/pricing';
import { formatSize } from '../desktop/files';
import type { DesktopStatus } from '../desktop/supervisor';
import type { ReplayItem } from '../agent/chats';
import type { ChatInfo, CommandArgs, CommandResult, Snapshot } from '../gateway/protocol';
import { snapshotChat, type ViewCommand } from './bridge';
import { pastChatLine } from './forms';
import { mdLite } from './markdown';
import { createPanels } from './panels';
import type { DesktopFile, FromChat, ToChat, UiConfig } from './protocol';

/**
 * The chat sidebar. Shows the conversation and the bot's actions; the screen itself lives in the
 * Desktop tab, so no per-step screenshots here. The one exception is when the bot hands over to
 * the user (ask_user): then a card shows the reason and the screen at that moment.
 */

const vscode = acquireVsCodeApi();
const post = (m: FromChat) => vscode.postMessage(m);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = $<HTMLDivElement>('log');
const empty = $<HTMLDivElement>('empty');
const taskEl = $<HTMLTextAreaElement>('task');
const runBtn = $<HTMLButtonElement>('run');
const stopBtn = $<HTMLButtonElement>('stop');
const pauseBtn = $<HTMLButtonElement>('pause');
const resumeBtn = $<HTMLButtonElement>('resume');
const statusLine = $<HTMLSpanElement>('statusline');
const spinner = $<HTMLSpanElement>('spinner');
const usageEl = $<HTMLSpanElement>('usage');
const rowDesktop = $<HTMLDivElement>('rowDesktop');
const desktopDot = $<HTMLSpanElement>('desktopDot');
const desktopText = $<HTMLSpanElement>('desktopText');
const openDesktopBtn = $<HTMLButtonElement>('openDesktop');
const showLogBtn = $<HTMLButtonElement>('showLog');
const powerBtn = $<HTMLButtonElement>('powerBtn');
const modelText = $<HTMLSpanElement>('modelText');
const changeModelBtn = $<HTMLButtonElement>('changeModel');
const rowKey = $<HTMLDivElement>('rowKey');
const keyText = $<HTMLSpanElement>('keyText');
const keyBtn = $<HTMLButtonElement>('keyBtn');
const attachBtn = $<HTMLButtonElement>('attach');
const attachmentsEl = $<HTMLDivElement>('attachments');
const pastBar = $<HTMLDivElement>('pastBar');
const pastLine = $<HTMLSpanElement>('pastLine');
const pastContinue = $<HTMLButtonElement>('pastContinue');
const pastBack = $<HTMLButtonElement>('pastBack');
const host: 'vscode' | 'web' = document.body.classList.contains('web') ? 'web' : 'vscode';

/* ---------- the bridge: gateway commands for the panels, answered by the host ---------- */

let nextAsk = 1;
const asks = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function ask<K extends ViewCommand>(cmd: K, args?: CommandArgs<K>): Promise<CommandResult<K>> {
  const id = nextAsk++;
  return new Promise((resolve, reject) => {
    asks.set(id, { resolve, reject });
    post({ type: 'ask', id, cmd, ...(args ? { args: args as Record<string, unknown> } : {}) });
  });
}

let status: AgentStatus = 'idle';
let statusMessage = '';
let desktop: DesktopStatus = { state: 'unknown' };
let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reportedUsd: 0 };
let currentModel = '';
let currentProvider = '';
let currentBaseUrl = '';
/** The endpoint is used with a subscription sign-in: tokens are shown, dollars are not. */
let currentSignIn = false;

const compact = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString());

function renderUsage(): void {
  const total = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!total && !usage.output) {
    usageEl.textContent = '';
    usageEl.title = '';
    return;
  }
  const parts = [`${compact(total)} in`, `${compact(usage.output)} out`];
  if (usage.cacheRead) parts.push(`${Math.round((usage.cacheRead / total) * 100)}% cached`);
  const price = currentSignIn ? undefined : priceForConfig({ provider: currentProvider, model: currentModel, baseUrl: currentBaseUrl });
  const fmt = (usd: number) => `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;
  // Signed in: the tokens are real, the dollars are not — the run draws a pool the plan paid for.
  if (currentSignIn) parts.push('subscription');
  else if (usage.reportedUsd > 0) parts.push(fmt(usage.reportedUsd));
  else if (price) parts.push(`≈ ${fmt(costUsd(usage, price))}`);
  usageEl.textContent = parts.join(' · ');
  usageEl.title = `Input ${usage.input.toLocaleString()} uncached · ${usage.cacheRead.toLocaleString()} read from cache · ${usage.cacheWrite.toLocaleString()} written to cache · output ${usage.output.toLocaleString()}${currentSignIn ? ' · drawn from your Grok subscription, not billed per token' : usage.reportedUsd > 0 ? ' · cost as reported by the provider' : price ? ` · estimate at list prices for ${currentModel}` : ''}`;
}
let lastStep = 0;
let maxSteps = 0;
const MAX_ENTRIES = 300;

/*
 * Follow the newest message only while the reader is already at the bottom. Someone who scrolled
 * up to read is left where they are; a small "Newer messages" pill at the bottom edge takes them
 * back down. Sending a message always pins the view again.
 */
let pinned = true;
const jump = document.createElement('button');
jump.id = 'jump';
jump.type = 'button';
jump.textContent = '↓ Newer messages';
jump.hidden = true;
jump.addEventListener('click', () => {
  pinned = true;
  scrollToBottom();
});
log.appendChild(jump);
log.addEventListener('scroll', () => {
  pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  if (pinned) jump.hidden = true;
});

function scrollToBottom(): void {
  if (log.lastElementChild !== jump) log.appendChild(jump); // keep the pill last so `sticky` holds it at the bottom edge
  if (pinned) {
    log.scrollTop = log.scrollHeight;
    jump.hidden = true;
  } else {
    jump.hidden = false;
  }
}

/** Add to the log. `outside`: never inside a reflection card — for what is the person's, not hers. */
function append(el: HTMLElement, outside = false): void {
  empty.hidden = true;
  // Anything that isn't an action line (a bubble, a card…) ends the current action group,
  // so the next batch of actions folds into a fresh chip.
  if (el !== actionGroup?.el) actionGroup = undefined;
  if (el !== memoryGroup?.el) memoryGroup = undefined;
  // While she reflects, everything she does goes inside the reflection card, not into the flow.
  if (reflection && el !== reflection.el && !outside) reflection.body.appendChild(el);
  else log.appendChild(el);
  while (log.children.length > MAX_ENTRIES + 2) log.removeChild(log.children[1]); // children[0] is the empty state; the pill is last
  scrollToBottom();
}

/*
 * A reflection is her talking to herself: facts, playbooks, revisions to who she is, the three
 * answers. None of it is addressed to the user, so it folds into one card. The visible line is
 * her closing words plus what changed; open the card for the rest. Nothing is hidden: the self
 * file, journal and playbooks have their own commands.
 */
interface ReflectionCard {
  el: HTMLDetailsElement;
  summary: HTMLElement;
  body: HTMLDivElement;
  counts: { self: number; playbook: number; facts: number; notes: number };
  lastText: string;
  changed: boolean;
}
let reflection: ReflectionCard | undefined;

function reflectionCard(): ReflectionCard {
  const el = document.createElement('details');
  el.className = 'reflection';
  const summary = document.createElement('summary');
  summary.textContent = 'Reflecting…';
  const body = document.createElement('div');
  el.append(summary, body);
  return { el, summary, body, counts: { self: 0, playbook: 0, facts: 0, notes: 0 }, lastText: '', changed: false };
}

function startReflection(): void {
  if (reflection) return;
  const card = reflectionCard();
  append(card.el);
  reflection = card;
}

/** One plain line from her closing words: markdown marks dropped, cut at a sentence end. */
function closingLine(text: string, max = 150): string {
  const plain = text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '));
  return `${end > 60 ? cut.slice(0, end + 1) : cut}…`;
}

function reflectionSummary(card: ReflectionCard, status: 'done' | 'stopped' | 'error'): string {
  const c = card.counts;
  const parts: string[] = [];
  if (c.self) parts.push(`${c.self} change${c.self === 1 ? '' : 's'} to who she is`);
  if (c.playbook) parts.push(`${c.playbook} playbook${c.playbook === 1 ? '' : 's'}`);
  if (c.facts) parts.push(`${c.facts} fact${c.facts === 1 ? '' : 's'}`);
  if (c.notes) parts.push(`${c.notes} note${c.notes === 1 ? '' : 's'}`);
  if (card.changed) parts.push('an answer changed');
  const head = status === 'done' ? 'She reflected' : status === 'stopped' ? 'Reflection stopped' : 'Reflection failed';
  const closing = closingLine(card.lastText);
  const tail = parts.length ? ` · ${parts.join(' · ')}` : status === 'done' ? ' · nothing changed' : '';
  return `${head}${closing ? ` — ${closing}` : ''}${tail}`;
}

function endReflection(status: 'done' | 'stopped' | 'error'): void {
  const card = reflection;
  if (!card) return;
  reflection = undefined;
  card.summary.textContent = reflectionSummary(card, status);
  card.el.classList.toggle('changed', card.changed);
  if (status !== 'done') card.el.open = true;
  scrollToBottom();
}

/* Consecutive actions fold into one collapsed `▸ N actions` chip; expand for the raw lines. */
let actionGroup: { el: HTMLDetailsElement; body: HTMLDivElement; label: HTMLSpanElement; count: number; failed: number } | undefined;

function appendAction(line: HTMLDivElement, failed: boolean): void {
  if (!actionGroup || !actionGroup.el.isConnected) {
    const el = document.createElement('details');
    el.className = 'action-group';
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    summary.appendChild(label);
    const body = document.createElement('div');
    el.append(summary, body);
    actionGroup = { el, body, label, count: 0, failed: 0 };
    append(el);
  }
  const g = actionGroup;
  g.count++;
  if (failed) g.failed++;
  g.body.appendChild(line);
  g.label.textContent = `${g.count} action${g.count === 1 ? '' : 's'}${g.failed ? ` · ${g.failed} failed` : ''}`;
  g.el.classList.toggle('has-failed', g.failed > 0);
  scrollToBottom();
}

/*
 * Memory pills fold the same way ChatGPT's "Memory updated" chip does: consecutive facts, notes,
 * playbooks and self changes become one `Memory updated · 1 fact · 1 note to self` line; open it
 * to read what was saved. Any other element (a reply, an action chip) ends the group.
 */
type MemoryKind = 'fact' | 'forgotten' | 'playbook' | 'note' | 'self' | 'proposal';
let memoryGroup: { el: HTMLDetailsElement; body: HTMLDivElement; label: HTMLSpanElement; counts: Record<MemoryKind, number>; failed: number } | undefined;

function memoryLabel(g: NonNullable<typeof memoryGroup>): string {
  const c = g.counts;
  const n = (k: MemoryKind, one: string, many: string) => (c[k] ? `${c[k]} ${c[k] === 1 ? one : many}` : '');
  const parts = [
    n('fact', 'fact', 'facts'),
    n('forgotten', 'forgotten', 'forgotten'),
    n('playbook', 'playbook', 'playbooks'),
    n('note', 'note to self', 'notes to self'),
    n('self', 'change to who she is', 'changes to who she is'),
    n('proposal', 'proposal for who she is', 'proposals for who she is'),
  ].filter(Boolean);
  if (g.failed) parts.push(`${g.failed} not saved`);
  const saved = parts.length > (g.failed ? 1 : 0);
  return `${saved ? 'Memory updated' : 'Memory not updated'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
}

function appendMemory(text: string, kind: MemoryKind, failed: boolean, self = false): void {
  if (!memoryGroup || !memoryGroup.el.isConnected) {
    const el = document.createElement('details');
    el.className = 'memory-group';
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    summary.appendChild(label);
    const body = document.createElement('div');
    el.append(summary, body);
    memoryGroup = { el, body, label, counts: { fact: 0, forgotten: 0, playbook: 0, note: 0, self: 0, proposal: 0 }, failed: 0 };
    append(el);
  }
  const g = memoryGroup;
  if (failed) g.failed++;
  else g.counts[kind]++;
  g.body.appendChild(bubble(self ? 'memory self' : 'memory', text));
  g.label.textContent = memoryLabel(g);
  g.el.classList.toggle('has-failed', g.failed > 0);
  scrollToBottom();
}

/* A standby (wait_for) is its own line with a live countdown, never folded into the actions chip;
   the matching action result replaces it with what happened ("Stood by 1 min 30 s: nothing changed"). */
let standby: { el: HTMLDivElement; timer: ReturnType<typeof setInterval> } | undefined;

function mmss(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function startStandby(e: { reason: string; until: 'change' | 'time'; endsAt: number }): void {
  endStandby('Standby ended');
  const el = document.createElement('div');
  el.className = 'msg standby';
  const render = () => {
    el.textContent = `⏳ Standing by${e.until === 'time' ? '' : ' for a change'} — ${e.reason} · ${mmss(e.endsAt - Date.now())} left`;
  };
  render();
  const timer = setInterval(render, 1000);
  append(el);
  standby = { el, timer };
}

function endStandby(text: string, failed = false): void {
  if (!standby) return;
  clearInterval(standby.timer);
  standby.el.textContent = text;
  standby.el.classList.add('ended');
  standby.el.classList.toggle('failed', failed);
  standby = undefined;
}

const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const ICON_RESEND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';

/** A reflection's answers to the three fixed questions: one folded line, open for the answers (and what changed). */
function answersCard(items: { question: string; answer: string; before?: string; changed: boolean; note?: string }[]): HTMLDetailsElement {
  const el = document.createElement('details');
  const changed = items.filter((it) => it.changed);
  el.className = `answers${changed.length ? ' changed' : ''}`;
  const summary = document.createElement('summary');
  summary.textContent = changed.length ? `Her answers to the three questions — ${changed.length === 1 ? 'one' : changed.length} changed` : 'Her answers to the three questions';
  const body = document.createElement('div');
  for (const it of items) {
    const q = document.createElement('div');
    q.className = 'q';
    q.textContent = it.question;
    const a = document.createElement('div');
    a.className = `a${it.changed ? ' changed' : ''}`;
    a.textContent = it.answer;
    body.append(q, a);
    if (it.changed) {
      const d = document.createElement('div');
      d.className = 'diff';
      d.textContent = `${it.note ? `${it.note} ` : ''}Before: ${it.before ?? ''}`;
      body.appendChild(d);
    }
  }
  el.append(summary, body);
  return el;
}

/** `resend` is the exact text to send again from a user bubble's ↻ button (attachments are not re-sent). */
function bubble(cls: string, text: string, resend?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  if (cls === 'assistant') el.innerHTML = mdLite(text);
  else el.textContent = text;
  if (cls === 'user' || cls === 'assistant') el.appendChild(copyButton(text));
  if (cls === 'user' && resend) el.appendChild(resendButton(resend));
  return el;
}

/** Tiny hover button on your own messages: sends the same text again (after a failed run, a missing key, or just to repeat a task). */
function resendButton(text: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'copy resend';
  btn.title = 'Send again';
  btn.setAttribute('aria-label', 'Send this message again');
  btn.innerHTML = ICON_RESEND;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    sendText(text, []);
  });
  return btn;
}

/** Tiny hover button that copies the whole message (the original text, not the rendered markup). */
function copyButton(text: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'copy';
  btn.title = 'Copy message';
  btn.setAttribute('aria-label', 'Copy message');
  btn.innerHTML = ICON_COPY;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    post({ type: 'copy', text });
    btn.innerHTML = ICON_CHECK;
    btn.classList.add('done');
    btn.title = 'Copied';
    setTimeout(() => {
      btn.innerHTML = ICON_COPY;
      btn.classList.remove('done');
      btn.title = 'Copy message';
    }, 1200);
  });
  return btn;
}

/* ---------- header: desktop / model / API key rows ---------- */

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

function muted(text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'muted';
  el.textContent = text;
  return el;
}

function renderConfig(c: UiConfig): void {
  maxSteps = c.maxSteps > 0 ? c.maxSteps : 0;
  currentSignIn = !!c.signIn;
  currentModel = c.model;
  currentProvider = c.provider;
  currentBaseUrl = c.baseUrl;
  renderUsage();
  modelText.replaceChildren();
  if (c.provider === 'mock') {
    modelText.append('Demo model', muted(' · scripted, no key'));
    modelText.title = 'A scripted model for trying Deskfish without an API key';
  } else {
    const via = c.provider === 'anthropic' ? 'Anthropic' : hostOf(c.baseUrl) || 'OpenAI-compatible';
    modelText.append(c.model, muted(` · ${via}`));
    modelText.title = `${c.model} via ${via}${c.provider === 'openai-compatible' ? ` (${c.baseUrl || 'no base URL set'})` : ''}`;
  }

  const local = /localhost|127\.0\.0\.1/.test(c.baseUrl);
  const needsKey = c.provider !== 'mock' && !c.hasApiKey && !local;
  rowKey.classList.toggle('warn', needsKey);
  if (c.signIn) {
    // The same row, signed in instead of keyed: no key exists to show or to paste.
    rowKey.querySelector('.rowlabel')!.textContent = 'Grok sign-in';
    keyText.textContent = c.hasApiKey ? (c.signedInAs ? `Signed in as ${c.signedInAs}` : 'Signed in') : 'Not signed in';
    keyBtn.hidden = false;
    keyBtn.textContent = c.hasApiKey ? 'Sign out' : 'Sign in with Grok';
  } else {
    rowKey.querySelector('.rowlabel')!.textContent = 'API key';
    keyText.textContent = c.provider === 'mock' ? 'Not needed' : c.hasApiKey ? (c.keyStored ?? 'Stored in your keychain') : local ? 'Not needed for a local endpoint' : 'Not set';
    keyBtn.hidden = c.provider === 'mock';
    keyBtn.textContent = c.hasApiKey ? 'Change' : 'Set API key';
  }
  keyBtn.classList.toggle('primary', needsKey);

  renderDesktop(c.desktop);
}

function renderDesktop(s: DesktopStatus): void {
  desktop = s;
  const busy = s.state === 'starting' || s.state === 'stopping';
  desktopDot.className = 'dot';
  rowDesktop.classList.remove('warn', 'error');
  desktopText.title = '';
  openDesktopBtn.hidden = true;
  showLogBtn.hidden = true;
  powerBtn.hidden = false;
  powerBtn.disabled = busy;
  powerBtn.title = '';
  renderSetup();

  if (s.runtime?.cli === 'none' && s.state !== 'on' && !busy) {
    desktopDot.classList.add('warn');
    rowDesktop.classList.add('warn');
    desktopText.textContent = 'Needs Podman — see below';
    powerBtn.hidden = true; // the setup card below carries the one Install button
    renderStatusLine();
    return;
  }

  switch (s.state) {
    case 'on':
      desktopDot.classList.add('ok');
      desktopText.textContent = 'On';
      openDesktopBtn.hidden = false;
      powerBtn.textContent = 'Turn off';
      powerBtn.title = 'Shut the desktop down. Its files and logins are kept.';
      break;
    case 'starting':
      desktopDot.classList.add('busy');
      desktopText.textContent = 'Turning on…';
      desktopText.title = s.message ?? '';
      powerBtn.textContent = 'Turn on';
      break;
    case 'stopping':
      desktopDot.classList.add('busy');
      desktopText.textContent = 'Turning off…';
      powerBtn.textContent = 'Turn off';
      break;
    case 'error':
      desktopDot.classList.add('bad');
      rowDesktop.classList.add('error');
      desktopText.textContent = 'Error';
      desktopText.title = s.message ?? 'unknown error';
      showLogBtn.hidden = false;
      powerBtn.textContent = 'Try again';
      powerBtn.title = 'Turn the desktop on again';
      break;
    default:
      desktopText.textContent = 'Off';
      powerBtn.textContent = 'Turn on';
      powerBtn.title = 'Start the desktop. The first time builds its image, which takes a few minutes.';
  }
  renderStatusLine();
}

openDesktopBtn.addEventListener('click', () => post({ type: 'openDesktop' }));
showLogBtn.addEventListener('click', () => post({ type: 'showLog' }));
powerBtn.addEventListener('click', () => {
  if (desktop.state === 'on') post({ type: 'stopDesktop' });
  else if (desktop.state !== 'starting' && desktop.state !== 'stopping') post({ type: 'startDesktop' });
});
changeModelBtn.addEventListener('click', () => post({ type: 'openSettings' }));
keyBtn.addEventListener('click', () => post({ type: 'setApiKey' }));

document.getElementById('docs')?.addEventListener('click', () => post({ type: 'openDocs' }));
for (const ex of Array.from(document.querySelectorAll<HTMLButtonElement>('.example'))) {
  ex.addEventListener('click', () => {
    taskEl.value = ex.textContent ?? '';
    taskEl.focus();
  });
}

/* ---------- setup card: no container engine on this machine ---------- */

let setupEl: HTMLDivElement | undefined;

function renderSetup(): void {
  const rt = desktop.runtime;
  const show = rt?.cli === 'none' && desktop.state !== 'on' && desktop.state !== 'starting' && desktop.state !== 'stopping';
  if (!show || rt.cli !== 'none') {
    setupEl?.remove();
    setupEl = undefined;
    // The log always holds the empty state and the "Newer messages" pill; anything else is a conversation.
    empty.hidden = Array.from(log.children).some((c) => c !== empty && c !== jump);
    return;
  }
  const plan = rt.install;
  if (!setupEl) {
    setupEl = document.createElement('div');
    setupEl.className = 'setup';
    log.insertBefore(setupEl, empty);
  }
  empty.hidden = true;

  const title = document.createElement('h4');
  title.textContent = 'One thing to install first';
  const text = document.createElement('div');
  text.textContent = "The bot gets a computer of its own — a Linux container — so Deskfish needs Podman (free and open source) or Docker on this machine. That's the only requirement.";
  const system = document.createElement('div');
  system.className = 'hint';
  system.textContent = `Detected: ${plan.system}`;

  const actions = document.createElement('div');
  actions.className = 'actions';
  const parts: HTMLElement[] = [title, text, system];

  if (plan.command) {
    const code = document.createElement('pre');
    code.textContent = plan.command;
    code.title = host === 'vscode' ? 'This runs in a VS Code terminal when you click Install' : 'The Deskfish app runs this in a terminal; a browser copies it for you';
    parts.push(code);
    const hint = document.createElement('div');
    hint.className = 'hint';
    const where = host === 'vscode' ? 'Runs in a VS Code terminal' : 'Runs in a terminal (in a browser: copied, for a terminal on the computer where Deskfish runs)';
    hint.textContent = `${where} and asks for your password.${plan.afterwards ? ` ${plan.afterwards}` : ''}`;
    parts.push(hint);
    const install = document.createElement('button');
    install.className = 'primary';
    install.textContent = 'Install Podman';
    install.addEventListener('click', () => post({ type: 'installRuntime' }));
    actions.appendChild(install);
  } else {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = "We don't know the package manager for this system — follow the installation guide, then click Check again.";
    parts.push(hint);
  }
  const check = document.createElement('button');
  check.textContent = 'Check again';
  check.addEventListener('click', () => post({ type: 'refresh' }));
  actions.appendChild(check);
  const guide = document.createElement('a');
  guide.href = plan.docsUrl;
  guide.textContent = 'Installation guide';
  guide.className = 'link';
  actions.appendChild(guide);
  parts.push(actions);
  setupEl.replaceChildren(...parts);
}

/* ---------- status + events ---------- */

function renderStatusLine(): void {
  const agentBusy = status === 'running' || status === 'paused';
  const desktopBusy = desktop.state === 'starting' || desktop.state === 'stopping';
  spinner.hidden = !(status === 'running' || desktopBusy);
  let text: string;
  if (!agentBusy && desktopBusy) {
    text = desktop.message ?? (desktop.state === 'starting' ? 'Turning on the desktop…' : 'Turning off the desktop…');
  } else {
    const label = { idle: 'Ready', running: 'Working', paused: 'Paused', done: 'Done', stopped: 'Stopped', error: 'Error' }[status];
    const steps = status === 'running' && lastStep > 0 ? (maxSteps > 0 ? ` · step ${lastStep} of ${maxSteps}` : ` · step ${lastStep}`) : '';
    text = statusMessage && statusMessage !== 'Starting…' && statusMessage !== 'Resumed' ? `${label}${steps} — ${statusMessage}` : `${label}${steps}`;
  }
  statusLine.textContent = text;
  statusLine.title = text;
}

function setStatus(s: AgentStatus, message?: string): void {
  if (s === 'running' && status !== 'running' && status !== 'paused') lastStep = 0;
  status = s;
  statusMessage = message ?? '';
  const active = s === 'running' || s === 'paused';
  runBtn.querySelector('span')!.textContent = active ? 'Send' : 'Run';
  stopBtn.disabled = !active;
  pauseBtn.hidden = s !== 'running';
  resumeBtn.hidden = s !== 'paused';
  renderStatusLine();
  renderComposer();
}

function needsUserCard(reason: string, jpegBase64: string): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'needs-user';

  const title = document.createElement('h4');
  title.textContent = '✋ Deskfish needs you';
  card.appendChild(title);

  const text = document.createElement('div');
  text.textContent = reason;
  card.appendChild(text);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Do it in the Desktop tab (input is unlocked), then click Resume — or just reply here.';
  card.appendChild(hint);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const open = document.createElement('button');
  open.textContent = 'Open desktop';
  open.addEventListener('click', () => post({ type: 'openDesktop' }));
  const resume = document.createElement('button');
  resume.textContent = 'Resume';
  resume.className = 'primary';
  resume.addEventListener('click', () => post({ type: 'resume' }));
  actions.append(open, resume);
  card.appendChild(actions);

  if (jpegBase64) {
    const img = document.createElement('img');
    img.src = `data:image/jpeg;base64,${jpegBase64}`;
    img.title = 'The screen when the bot stopped — click to open the live desktop';
    img.addEventListener('click', () => post({ type: 'openDesktop' }));
    // The image arrives after the card is appended; keep the log pinned to the bottom.
    img.addEventListener('load', () => (scrollToBottom()));
    card.appendChild(img);
  }
  return card;
}

function onEvent(e: AgentEvent): void {
  switch (e.type) {
    case 'status':
      setStatus(e.status, e.message);
      if (standby && (e.status === 'stopped' || e.status === 'error')) endStandby(e.status === 'stopped' ? 'Standby ended — stopped' : 'Standby ended — error', e.status === 'error');
      if (e.status === 'running' && e.message === 'Reflecting…') startReflection();
      if (e.status === 'done' || e.status === 'stopped' || e.status === 'error') {
        if (reflection) {
          // The card's own line says how it ended; a stopped or failed reflection keeps the status inside it.
          if (e.status !== 'done') append(bubble(`status ${e.status}`, e.message ?? e.status));
          endReflection(e.status);
        } else {
          append(bubble(`status ${e.status}`, e.message ?? e.status));
        }
      }
      break;
    case 'assistant':
      if (reflection) reflection.lastText = e.text;
      append(bubble('assistant', e.text));
      break;
    case 'action': {
      if (reflection && e.result.ok) {
        const c = reflection.counts;
        if (e.action.type === 'remember' || e.action.type === 'forget') c.facts++;
        else if (e.action.type === 'save_playbook') c.playbook++;
        else if (e.action.type === 'revise_self' || e.action.type === 'restore_self' || e.action.type === 'archive_story') c.self++;
        else if (e.action.type === 'note') c.notes++;
      }
      if (e.action.type === 'wait_for') {
        // The standby line shows the outcome; the first clause of her result says what happened.
        if (!standby) startStandby({ reason: e.action.reason, until: e.action.until ?? 'change', endsAt: Date.now() });
        endStandby(e.result.ok ? `⏳ ${(e.result.message ?? 'Stood by').split(/[;.] /)[0]}` : `⏳ Standby failed (${e.result.error ?? 'unknown reason'})`, !e.result.ok);
        break;
      }
      // Tool errors are phrased for her ("keep a playbook under 2500 — the steps that matter"); show the user only the reason.
      const reason = (err?: string) => (err ?? 'unknown reason').split(/;|—/)[0].trim();
      if (e.action.type === 'remember' || e.action.type === 'forget') {
        const text = e.action.type === 'remember' ? e.action.text : e.action.query;
        appendMemory(e.result.ok ? (e.result.message ?? text) : `Not ${e.action.type === 'remember' ? 'remembered' : 'forgotten'}: ${reason(e.result.error)}`, e.action.type === 'remember' ? 'fact' : 'forgotten', !e.result.ok);
        break;
      }
      if (e.action.type === 'save_playbook') {
        appendMemory(e.result.ok ? (e.result.message ?? describeAction(e.action)) : `Playbook not saved (${reason(e.result.error)}); she can try again shorter`, 'playbook', !e.result.ok);
        break;
      }
      if (e.action.type === 'revise_self' || e.action.type === 'restore_self' || e.action.type === 'note' || e.action.type === 'archive_story') {
        const what = e.action.type === 'note' ? `Note to self: ${e.action.text}` : e.result.message ?? describeAction(e.action);
        // Mid-task a self revision is only a proposal for her next reflection; in a reflection it is applied.
        const kind: MemoryKind = e.action.type === 'note' ? 'note' : reflection ? 'self' : 'proposal';
        appendMemory(e.result.ok ? what : `Could not ${describeAction(e.action)} (${reason(e.result.error)})`, kind, !e.result.ok, true);
        break;
      }
      const el = document.createElement('div');
      el.className = `action${e.result.ok ? '' : ' failed'}`;
      el.textContent = `${describeAction(e.action)}${e.result.ok ? '' : ` — ${e.result.error}`}`;
      el.title = `step ${e.step}: ${el.textContent}`;
      if (e.action.type === 'run_command' && e.result.ok && e.result.command) {
        // As a terminal agent shows it: the command and its verdict on the line, the output folded under it.
        el.textContent += ` → ${e.result.message ?? ''}`;
        el.classList.add('command');
        const out = e.result.command;
        const text = `${out.stdout}${out.stderr ? `${out.stdout && !out.stdout.endsWith('\n') ? '\n' : ''}[stderr]\n${out.stderr}` : ''}`.replace(/\s+$/, '');
        if (text) {
          const d = document.createElement('details');
          d.className = 'command-output';
          const s = document.createElement('summary');
          s.textContent = 'output';
          const pre = document.createElement('pre');
          pre.textContent = text;
          d.append(s, pre);
          el.appendChild(d);
        }
      }
      appendAction(el, !e.result.ok);
      break;
    }
    case 'needs_user':
      append(needsUserCard(e.reason, e.jpegBase64));
      break;
    case 'standby':
      startStandby(e);
      break;
    case 'ledger': {
      const el = document.createElement('details');
      el.className = 'ledger';
      const summary = document.createElement('summary');
      summary.textContent = `📒 Ledger after ${e.step} steps — the conversation continues from it`;
      const body = document.createElement('div');
      body.textContent = e.text;
      el.append(summary, body);
      append(el);
      break;
    }
    case 'answers':
      if (reflection && e.items.some((it) => it.changed)) reflection.changed = true;
      append(answersCard(e.items));
      break;
    case 'drift':
      // The folded answers card above already shows the change; nothing more in the chat (the controller notifies).
      break;
    case 'charter_objection':
      for (const l of e.lines) append(bubble('memory self', `She disagrees with her charter: ${l}`));
      break;
    case 'screenshot':
      lastStep = e.step;
      renderStatusLine();
      // Shown in the Desktop tab, not here.
      break;
    case 'usage':
      usage = {
        input: usage.input + e.input,
        output: usage.output + e.output,
        cacheRead: usage.cacheRead + (e.cacheRead ?? 0),
        cacheWrite: usage.cacheWrite + (e.cacheWrite ?? 0),
        cacheWrite1h: usage.cacheWrite1h + (e.cacheWrite1h ?? 0),
        reportedUsd: usage.reportedUsd + (e.costUsd ?? 0),
      };
      renderUsage();
      break;
  }
}

/* ---------- files: attachments (to the desktop) and downloads (from it) ---------- */

const ICON_FILE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

let pending: DesktopFile[] = [];

function renderAttachments(): void {
  attachmentsEl.replaceChildren();
  attachmentsEl.hidden = pending.length === 0;
  for (const file of pending) {
    const chip = document.createElement('span');
    chip.className = 'attachment';
    chip.title = `${file.path} (${formatSize(file.size)})`;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = file.name;
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = 'Remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      pending = pending.filter((f) => f !== file);
      renderAttachments();
    });
    chip.append(name, remove);
    attachmentsEl.appendChild(chip);
  }
}

const downloadCards = new Map<string, { card: HTMLDivElement; button: HTMLButtonElement; note: HTMLDivElement }>();

function downloadCard(file: DesktopFile): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'download';

  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.innerHTML = ICON_FILE;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = file.name;
  name.title = file.path;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${formatSize(file.size)} · new on the bot's desktop`;
  const note = document.createElement('div');
  note.className = 'note';
  note.hidden = true;
  meta.append(name, sub, note);

  const button = document.createElement('button');
  button.className = 'primary';
  button.textContent = 'Save to your computer';
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = 'Saving…';
    note.hidden = true;
    post({ type: 'saveFile', file });
  });

  card.append(icon, meta, button);
  downloadCards.set(file.path, { card, button, note });
  return card;
}

function onSaved(path: string, hostPath: string): void {
  const entry = downloadCards.get(path);
  if (!entry) return;
  entry.note.hidden = false;
  entry.note.classList.remove('error');
  entry.note.textContent = `Saved to ${hostPath}`;
  entry.note.title = hostPath;
  entry.button.disabled = false;
  entry.button.className = 'secondary';
  entry.button.textContent = 'Show in folder';
  entry.button.onclick = () => post({ type: 'revealFile', hostPath });
}

function onSaveFailed(path: string, error: string): void {
  const entry = downloadCards.get(path);
  if (!entry) return;
  entry.button.disabled = false;
  entry.button.textContent = 'Save to your computer';
  if (error) {
    entry.note.hidden = false;
    entry.note.classList.add('error');
    entry.note.textContent = error;
  }
}

attachBtn.addEventListener('click', () => post({ type: 'attach' }));

/* ---------- composer ---------- */

function submit(): void {
  const text = taskEl.value.trim();
  if (!text && !pending.length) return;
  sendText(text, pending);
  taskEl.value = '';
  pending = [];
  renderAttachments();
}

/** Send `text` (plus any attachments) as a new task, or as a message to the running one. */
function sendText(text: string, attachments: DesktopFile[]): void {
  const shown = attachments.length ? `${text || 'Here are some files.'}\n📎 ${attachments.map((f) => f.name).join(', ')}` : text;
  const sent = text || `I attached ${attachments.length === 1 ? 'a file' : 'some files'}.`;
  pinned = true;
  // Sent while she reflects, the message sits after the card: the host holds it and starts it as a task when she finishes.
  append(bubble('user', shown, sent), true);
  if (status === 'running' || status === 'paused') {
    post({ type: 'say', text: sent, attachments });
  } else {
    // The log is never cleared: a new task continues the visible conversation
    // (and, host-side, the model's conversation too when the last task ended cleanly).
    post({ type: 'run', task: sent, attachments });
  }
}

runBtn.addEventListener('click', submit);
taskEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    submit();
  }
});
stopBtn.addEventListener('click', () => post({ type: 'stop' }));
pauseBtn.addEventListener('click', () => post({ type: 'pause' }));
resumeBtn.addEventListener('click', () => post({ type: 'resume' }));

/** Empty the log (the empty state and the "Newer messages" pill stay). */
function clearLog(): void {
  while (log.children.length > 1) log.removeChild(log.children[1]);
  log.appendChild(jump);
  pinned = true;
  actionGroup = undefined;
  memoryGroup = undefined;
  reflection = undefined;
  if (standby) clearInterval(standby.timer);
  standby = undefined;
  downloadCards.clear();
}

/** New chat: clear the log and counters and show the empty state. The extension already dropped the model's conversation. */
function resetChat(): void {
  exitPast();
  clearLog();
  usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reportedUsd: 0 };
  renderUsage();
  pending.length = 0;
  renderAttachments();
  setStatus('idle');
  empty.hidden = false;
  taskEl.focus();
}

/**
 * A transcript rendered as it looked. Bubbles reset the action group like live events do. A
 * reflection is only recognisable at its end ("Reflection finished"), so what follows a status line
 * with no user message in between is kept aside and folded when that end comes. `title`: a chat
 * continued from the past (its line says so); empty for the live chat after a (re)connect and for a
 * past chat shown in place.
 */
function renderReplay(items: ReplayItem[], title: string): void {
  pinned = true;
  // A past chat, rendered as it was. Bubbles reset the action group like live events do.
  // A reflection is only recognisable at its end ("Reflection finished"), so what follows a
  // status line with no user message in between is kept aside and folded when that end comes.
  let since: { els: HTMLElement[]; card: ReflectionCard } | undefined;
  const keep = (el: HTMLElement) => {
    append(el);
    since?.els.push(el);
  };
  for (const it of items) {
    switch (it.kind) {
      case 'user':
        since = undefined;
        append(bubble('user', it.text, it.text));
        break;
      case 'assistant':
        keep(bubble('assistant', it.text));
        if (since) since.card.lastText = it.text;
        break;
      case 'note': {
        if (/^📒/.test(it.text)) {
          const el = document.createElement('details');
          el.className = 'ledger';
          const summary = document.createElement('summary');
          const [head, ...rest] = it.text.split(': ');
          summary.textContent = head;
          const body = document.createElement('div');
          body.textContent = rest.join(': ').split(' / ').join('\n');
          el.append(summary, body);
          keep(el);
        } else if (/^⏳/.test(it.text)) {
          const el = bubble('standby ended', it.text);
          keep(el);
        } else if (/^(Her answer changed|She disagrees)/i.test(it.text)) {
          keep(bubble('memory self', it.text));
        } else {
          const t = it.text;
          const failed = /not done:|^Not (remembered|forgotten)|^Could not|^Playbook not saved/i.test(t);
          const kind: MemoryKind = /^Remembered/i.test(t) ? 'fact' : /^Forg/i.test(t) ? 'forgotten' : /playbook/i.test(t) ? 'playbook' : /^Noted\. You only rewrite/i.test(t) ? 'proposal' : /^(Revised|Restored|Removed|Moved)/i.test(t) ? 'self' : 'note';
          appendMemory(t, kind, failed, kind === 'self' || kind === 'proposal' || kind === 'note');
          if (since && memoryGroup && !since.els.includes(memoryGroup.el)) since.els.push(memoryGroup.el);
        }
        if (since) {
          const c = since.card.counts;
          if (/^(Remembered|Forgot)/i.test(it.text)) c.facts++;
          else if (/playbook/i.test(it.text) && !/not done/i.test(it.text)) c.playbook++;
          else if (/^(Revised|Restored|Removed ".*" from who you are)/i.test(it.text)) c.self++;
          else if (/^Noted/i.test(it.text)) c.notes++;
          else if (/^Her answer changed/i.test(it.text)) since.card.changed = true;
        }
        break;
      }
      case 'needs_user':
        keep(needsUserCard(it.text, ''));
        break;
      case 'status':
        if (since && /Reflection finished/i.test(it.text)) {
          const card = since.card;
          append(card.el);
          for (const el of since.els) card.body.appendChild(el);
          card.summary.textContent = reflectionSummary(card, 'done');
          card.el.classList.toggle('changed', card.changed);
          since = undefined;
          break;
        }
        append(bubble(`status ${it.text.split(/\s|—/)[0]}`, it.text));
        since = { els: [], card: reflectionCard() };
        actionGroup = undefined;
        break;
      case 'actions':
        for (const a of it.actions) {
          const el = document.createElement('div');
          el.className = `action${a.failed ? ' failed' : ''}`;
          el.textContent = a.text;
          el.title = `step ${it.step}: ${a.text}`;
          appendAction(el, a.failed);
          if (since && actionGroup && !since.els.includes(actionGroup.el)) since.els.push(actionGroup.el);
        }
        break;
    }
  }
  if (title) append(bubble('memory', `${title}. She has it as context for your next message.`));
  if (title || items.length) empty.hidden = true;
}

/* ---------- a past chat, shown in place of the live one ---------- */

/** The past chat on screen, or undefined for the live chat. While one is shown, the live chat's lines are not drawn; Back rebuilds it. */
let past: ChatInfo | undefined;

function showPast(info: ChatInfo, items: ReplayItem[]): void {
  past = info;
  clearLog();
  renderReplay(items, '');
  // A knock in a past chat is history: its Resume and Open desktop would act on the live task.
  for (const el of Array.from(log.querySelectorAll('.needs-user .actions, .needs-user .hint'))) el.remove();
  if (!items.length) empty.hidden = false;
  log.scrollTop = 0;
  pinned = false;
  jump.hidden = true;
  pastLine.textContent = pastChatLine(info, new Date());
  pastLine.title = info.firstTask;
  pastBar.hidden = false;
  renderComposer();
}

function exitPast(): void {
  if (!past) return;
  past = undefined;
  pastBar.hidden = true;
  renderComposer();
}

/** Back: the live chat again, rebuilt from a fresh snapshot as a reconnect does. */
async function backToLive(): Promise<void> {
  exitPast();
  try {
    const snap: Snapshot = await ask('snapshot');
    for (const m of snapshotChat(snap)) receive(m);
  } catch (err) {
    append(bubble('memory', `Could not reach Deskfish to show the current chat: ${err instanceof Error ? err.message : String(err)}`), true);
  }
}

pastBack.addEventListener('click', () => void backToLive());
pastContinue.addEventListener('click', async () => {
  const info = past;
  if (!info || status === 'running' || status === 'paused') return;
  // The gateway answers with reset and the transcript as a continued chat; they must be drawn, not skipped.
  exitPast();
  try {
    await ask('chats.continue', { name: info.name });
    taskEl.focus();
  } catch (err) {
    await backToLive();
    append(bubble('memory', `Could not continue that chat: ${err instanceof Error ? err.message : String(err)}`), true);
  }
});

/** The composer while a past chat is shown: nothing to send until it is continued. */
function renderComposer(): void {
  const busy = status === 'running' || status === 'paused';
  taskEl.disabled = !!past;
  attachBtn.disabled = !!past;
  runBtn.disabled = !!past;
  taskEl.placeholder = past ? 'This is a past chat. Continue it to reply, or go Back.' : 'Tell the bot what to do…  (Enter to send, Shift+Enter for a new line)';
  pastContinue.disabled = busy;
  pastContinue.title = busy ? 'She is working on the current chat; wait for it to end or stop it first' : 'Pick this chat up again: it becomes her context for your next message';
}

const panels = createPanels({
  host,
  ask,
  post,
  showPast,
  toggled(open) {
    document.body.classList.toggle('panel-open', open);
    if (!open && !past) taskEl.focus();
  },
});

/** One message from the host. While a past chat is shown, the live chat's new lines are not drawn (Back rebuilds it). */
function receive(m: ToChat): void {
  if (past && (m.type === 'user' || m.type === 'notice' || m.type === 'download')) {
    if (m.type !== 'download') panels.schedulesMayHaveChanged();
    return;
  }
  switch (m.type) {
    case 'config':
      renderConfig(m.config);
      break;
    case 'desktop':
      renderDesktop(m.status);
      break;
    case 'replay':
      renderReplay(m.items, m.live ? '' : m.title);
      break;
    case 'event':
      if (m.event.type === 'status' && (m.event.status === 'done' || m.event.status === 'stopped' || m.event.status === 'error')) panels.schedulesMayHaveChanged();
      if (!past) onEvent(m.event);
      // Behind a past chat only the status line and the counters follow the live one.
      else if (m.event.type === 'status') setStatus(m.event.status, m.event.message);
      else if (m.event.type === 'usage' || m.event.type === 'screenshot') onEvent(m.event);
      break;
    case 'newChat':
      resetChat();
      break;
    case 'user':
      pinned = true;
      append(bubble('user', m.text), true);
      panels.schedulesMayHaveChanged();
      break;
    case 'notice':
      append(bubble('memory', m.text), true);
      panels.schedulesMayHaveChanged();
      break;
    case 'attached':
      pending = [...pending, ...m.files];
      renderAttachments();
      taskEl.focus();
      break;
    case 'download':
      append(downloadCard(m.file));
      break;
    case 'saved':
      onSaved(m.path, m.hostPath);
      break;
    case 'saveFailed':
      onSaveFailed(m.path, m.error);
      break;
    case 'answer': {
      const pending = asks.get(m.id);
      if (!pending) break;
      asks.delete(m.id);
      if (m.ok) pending.resolve(m.result);
      else pending.reject(new Error(m.error));
      break;
    }
    case 'open':
      panels.open(m.panel);
      break;
  }
}

window.addEventListener('message', (ev: MessageEvent<ToChat>) => receive(ev.data));

setStatus('idle');
renderDesktop({ state: 'unknown' });
post({ type: 'ready' });
