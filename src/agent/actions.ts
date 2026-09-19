import type { ComputerAction, MouseButton, ScrollDirection } from '../computer/types';
import { MAX_MEMORY_LENGTH } from './memory';

/**
 * The tool surface every adapter shows its model. It deliberately mirrors the action names of
 * Anthropic's computer-use tool (left_click, key, scroll, …) so that prompts and few-shot habits
 * transfer across providers, and so that a generic OpenAI-compatible model gets the same vocabulary
 * Claude has been trained on.
 */
export const ACTION_NAMES = [
  'screenshot',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'mouse_move',
  'left_click_drag',
  'type',
  'key',
  'scroll',
  'wait',
  'zoom',
  'cursor_position',
] as const;

export const COMPUTER_TOOL_NAME = 'computer';

export const COMPUTER_TOOL_DESCRIPTION = [
  'Control the computer with the mouse and keyboard and look at the screen.',
  'Coordinates are [x, y] pixels in the most recent screenshot, origin top-left.',
  'Actions:',
  '- screenshot: look at the screen (a fresh screenshot is also sent after every batch of actions)',
  '- left_click / right_click / middle_click / double_click / triple_click: click at `coordinate`; optional `text` = modifier keys to hold (e.g. "shift")',
  '- mouse_move: move the pointer to `coordinate`',
  '- left_click_drag: drag from `start_coordinate` to `coordinate`',
  '- type: type `text` literally',
  '- key: press a key or chord in xdotool syntax in `text`, e.g. "Return", "ctrl+l", "alt+Tab", "Page_Down"',
  '- scroll: scroll at `coordinate` in `scroll_direction` by `scroll_amount` clicks',
  '- wait: pause for `duration` seconds, up to 30 (use after opening apps or loading pages; for anything longer use the wait_for tool)',
  '- zoom: magnify the area around `coordinate` — returns an enlarged view with a coordinate ruler and grid so you can read small text and exact click positions; changes nothing on screen',
  '- cursor_position: report where the pointer is',
].join('\n');

/** JSON schema for the tool's input, usable as OpenAI `parameters` or as a plain JSON schema. */
export const COMPUTER_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTION_NAMES] },
    coordinate: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 2,
      maxItems: 2,
      description: '[x, y] target in screenshot pixels',
    },
    start_coordinate: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 2,
      maxItems: 2,
      description: '[x, y] drag origin (left_click_drag only)',
    },
    text: {
      type: 'string',
      description: 'Text to type (type), key chord (key), or modifier keys to hold (clicks)',
    },
    scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    scroll_amount: { type: 'integer', minimum: 1, maximum: 30 },
    duration: { type: 'number', minimum: 0, maximum: 30, description: 'seconds (wait)' },
  },
  required: ['action'],
  additionalProperties: false,
} as const;

/** Second tool: hand the desktop to the human. Same on every provider. */
export const ASK_USER_TOOL_NAME = 'ask_user';

export const ASK_USER_TOOL_DESCRIPTION =
  'Pause and hand the desktop to the user. Call this whenever you need them: a login or password, a 2FA code, a CAPTCHA, ' +
  'a confirmation before something irreversible, or you are stuck. Give a short, specific reason saying exactly what they should do. ' +
  'The task resumes when they hand control back; their reply, if any, arrives with the next screenshot.';

/** Plain JSON schema (no `as const`, so it is assignable to every SDK's schema type). */
export const ASK_USER_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: 'What the user needs to do, in one or two sentences' },
  },
  required: ['reason'],
  additionalProperties: false,
};

export function askUserAction(input: unknown): ComputerAction {
  const reason = String((input as { reason?: unknown } | null)?.reason ?? '').trim();
  return { type: 'ask_user', reason: reason || 'The bot needs your help on the desktop.' };
}

/**
 * Third tool, for providers whose computer tool has a fixed schema (Anthropic's native one).
 * The OpenAI-compatible adapter instead exposes zoom as an action of the computer tool itself.
 */
export const ZOOM_TOOL_NAME = 'zoom';

export const ZOOM_TOOL_DESCRIPTION =
  'Magnify a region of the screen to read small text or find an exact click point. Returns a 3× enlarged view of the area ' +
  'around `coordinate`, overlaid with rulers and dotted grid lines labeled in normal screenshot coordinates: read the exact ' +
  'position of your target off the grid, then click using those coordinates. Use it before clicking anything small or ' +
  'ambiguous instead of guessing. Zoom is passive — it moves nothing and clicks nothing.';

export const ZOOM_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: {
    coordinate: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 2,
      maxItems: 2,
      description: '[x, y] center of the area to magnify, in screenshot pixels',
    },
  },
  required: ['coordinate'],
  additionalProperties: false,
};

export function zoomAction(input: unknown): ComputerAction {
  const c = parseCoordinate((input as { coordinate?: unknown } | null)?.coordinate);
  if (!c) throw new Error('zoom needs coordinate [x, y]');
  return { type: 'zoom', x: c.x, y: c.y };
}

/**
 * Fourth tool: the bot's own documentation, read on demand. The system prompt only lists the
 * pages; the model fetches one when the user asks about Deskfish itself. Same on every provider.
 */
export const READ_DOCS_TOOL_NAME = 'read_docs';

export const READ_DOCS_TOOL_DESCRIPTION =
  'Read a page of the documentation of Deskfish, the product you are part of. Use it whenever the user asks about Deskfish ' +
  'itself: what you are or can do, how a feature works (the desktop, files, clipboard, taking over, hand-over, models, ' +
  'settings, security, troubleshooting), or how to set something up — so you answer from the documentation instead of ' +
  'guessing. `page` is a slug from the page list in your instructions; pass "index" to see the list again. Reading is ' +
  'passive: it touches nothing on screen and needs no screenshot.';

export const READ_DOCS_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: {
    page: { type: 'string', description: 'Page slug, e.g. "files" or "the-tank"; "index" lists the pages' },
  },
  required: ['page'],
  additionalProperties: false,
};

export function readDocsAction(input: unknown): ComputerAction {
  const page = String((input as { page?: unknown } | null)?.page ?? 'index').trim();
  return { type: 'read_docs', page: page || 'index' };
}

/**
 * Standby: waiting that costs no steps. The loop watches the screen locally and wakes the model
 * when something changes and settles, or when the time is up. Same on every provider.
 */
export const WAIT_FOR_TOOL_NAME = 'wait_for';

export const WAIT_FOR_TOOL_DESCRIPTION =
  'Stand by for up to `minutes` without spending steps: Deskfish watches the screen for you and wakes you with a fresh ' +
  'screenshot. `until` "change" (default) wakes you as soon as the screen changes and settles — a page or upload that is ' +
  'processing, a reply you expect, a job that will finish — or when the time is up. `until` "time" waits the whole time ' +
  'regardless of the screen — for spacing actions out ("send the next one in 5 minutes"). Optional `region` [x, y, w, h] ' +
  'in screenshot pixels watches only that area, so a clock or an animation elsewhere does not wake you. Use it instead ' +
  'of chaining wait actions for anything longer than half a minute; the user can stop it at any time. It is for what the ' +
  'page or the world does, never for your own actions: every action of yours, typing included, is complete when its ' +
  'result comes back. Look before you wait: a page that is still loading shows a spinner or a skeleton; a loaded page ' +
  'holds still, and standing by for it changes nothing. Pages load in seconds — use wait_for for things that take ' +
  'minutes. Passive.';

export const WAIT_FOR_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: 'What you are waiting for, e.g. "the ad set to finish processing" or "5 minutes before the next email"' },
    minutes: { type: 'number', description: 'How long at most, 0.5 to 120' },
    until: { type: 'string', enum: ['change', 'time'], description: '"change" (default): wake when the screen changes and settles; "time": wait the whole time' },
    region: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 4,
      maxItems: 4,
      description: 'Optional [x, y, width, height] in screenshot pixels: only watch this area',
    },
  },
  required: ['reason', 'minutes'],
  additionalProperties: false,
};

export function waitForAction(input: unknown): ComputerAction {
  const o = (input ?? {}) as { reason?: unknown; minutes?: unknown; until?: unknown; region?: unknown };
  const reason = String(o.reason ?? '').trim() || 'something to happen';
  const m = Number(o.minutes);
  const minutes = Number.isFinite(m) ? Math.min(120, Math.max(0.5, m)) : 5;
  const until = o.until === 'time' ? 'time' : 'change';
  const r = Array.isArray(o.region) && o.region.length === 4 ? o.region.map(Number) : undefined;
  const region = r && r.every((v) => Number.isFinite(v)) && r[2] > 0 && r[3] > 0 ? { x: r[0], y: r[1], w: r[2], h: r[3] } : undefined;
  return region ? { type: 'wait_for', reason, minutes, until, region } : { type: 'wait_for', reason, minutes, until };
}

/**
 * The page itself: two tools answered by the Deskfish page bridge, a WebExtension in the tank's
 * Firefox. They give exact click coordinates from the page's own structure, where zoom only
 * gives a magnified picture. Same on every provider.
 */
export const FIND_TOOL_NAME = 'find';

export const FIND_TOOL_DESCRIPTION =
  'Find elements on the web page open in Firefox by what they say or are: `query` is the text, label, placeholder or ' +
  'kind of the thing you want ("Sign in", "search box", "Add to cart button", "email field", "Order total"). Returns the ' +
  'best matches with their role, name, current state and the exact coordinates to click, in screenshot pixels, and says ' +
  'when a match is outside the visible part of the page (scroll, then find again). Use it instead of guessing where a ' +
  'link, button or field is, and before zooming. Only works on http(s) pages in Firefox; for anything else (dialogs, the ' +
  'terminal, the panel, PDFs) use zoom. Passive: changes nothing on screen.';

export const FIND_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What to look for: visible text, label, placeholder, or kind of control' },
    limit: { type: 'integer', description: 'How many matches at most (default 8, max 20)' },
  },
  required: ['query'],
  additionalProperties: false,
};

export function findAction(input: unknown): ComputerAction {
  const o = (input ?? {}) as { query?: unknown; limit?: unknown };
  const query = String(o.query ?? '').trim();
  if (!query) throw new Error('find needs a query');
  const limit = Number(o.limit);
  return Number.isInteger(limit) && limit > 0 ? { type: 'find', query, limit: Math.min(20, limit) } : { type: 'find', query };
}

export const READ_PAGE_TOOL_NAME = 'read_page';

export const READ_PAGE_TOOL_DESCRIPTION =
  'Read the web page open in Firefox from its own structure instead of the picture. `scope` "interactive" (default) lists ' +
  'every link, button, field, checkbox, menu item and heading visible in the viewport, in page order, with role, name, ' +
  'current state (value, checked, selected) and click coordinates in screenshot pixels, plus how many more lie below or ' +
  'above the visible part. `scope` "text" returns the page\'s text (first 12,000 characters) — for reading an article, ' +
  'a results list or a confirmation without scrolling through it. Only works on http(s) pages in Firefox. Passive.';

export const READ_PAGE_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: {
    scope: { type: 'string', enum: ['interactive', 'text'], description: '"interactive" (default): the controls; "text": the page text' },
  },
  required: [],
  additionalProperties: false,
};

export function readPageAction(input?: unknown): ComputerAction {
  const scope = String((input as { scope?: unknown } | null)?.scope ?? 'interactive');
  return { type: 'read_page', scope: scope === 'text' ? 'text' : 'interactive' };
}

/** Long-term memory: two small tools, offered when a memory store is configured. */
export const REMEMBER_TOOL_NAME = 'remember';

export const REMEMBER_TOOL_DESCRIPTION =
  'Save one durable fact to your long-term memory, which survives new chats and restarts: a preference or constraint of the ' +
  "user, something they told you about themselves, which account this desktop is logged into on a site (Firefox already " +
  'remembers passwords; keep memory for facts), or a quirk you learned about a site or task that will save time next time. A ' +
  `sentence or two per memory, under ${MAX_MEMORY_LENGTH} characters; if one is refused as too long, save it again shorter. Do not save ` +
  'temporary details. The user sees every memory you save and can edit or delete it.';

export const REMEMBER_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: { text: { type: 'string', description: `The fact to remember, a sentence or two, under ${MAX_MEMORY_LENGTH} characters` } },
  required: ['text'],
  additionalProperties: false,
};

export function rememberAction(input: unknown): ComputerAction {
  const text = String((input as { text?: unknown } | null)?.text ?? '').trim();
  if (!text) throw new Error('remember needs text');
  return { type: 'remember', text };
}

export const FORGET_TOOL_NAME = 'forget';

export const FORGET_TOOL_DESCRIPTION =
  'Remove memories from your long-term memory: every memory whose text contains `query` (case-insensitive) is deleted. Use it ' +
  'when a memory turned out wrong or outdated, or when the user asks you to forget something.';

export const FORGET_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: { query: { type: 'string', description: 'Text that the memories to delete contain' } },
  required: ['query'],
  additionalProperties: false,
};

export function forgetAction(input: unknown): ComputerAction {
  const query = String((input as { query?: unknown } | null)?.query ?? '').trim();
  if (!query) throw new Error('forget needs query');
  return { type: 'forget', query };
}

/** The self and the journal: four more tools, offered when a self store is configured. */
export const REVISE_SELF_TOOL_NAME = 'revise_self';

export const REVISE_SELF_TOOL_DESCRIPTION =
  'Rewrite one section of who you are — your self file, the page in your instructions headed "Who I am, in my own words". ' +
  '`section` is a heading ("How I work", "What I care about", "My story", "People", or a new one); `text` replaces the whole ' +
  'body of that section (markdown, first person, your own voice); an empty `text` removes the section. Use it for what you ' +
  'have learned about how you like to work, what you value, and the people you work with — not for facts (those go in ' +
  'remember). During a task the change is only noted and shown to you at your next reflection, when you are alone with your ' +
  'own notes; during a reflection it is applied at once. The whole file stays under 4,000 characters. Only you can write it.';

export const REVISE_SELF_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: {
    section: { type: 'string', description: 'Section heading, e.g. "How I work"' },
    text: { type: 'string', description: 'New body for the section; empty to remove it' },
  },
  required: ['section', 'text'],
  additionalProperties: false,
};

export function reviseSelfAction(input: unknown): ComputerAction {
  const o = (input ?? {}) as { section?: unknown; text?: unknown };
  const section = String(o.section ?? '').trim();
  if (!section) throw new Error('revise_self needs a section');
  return { type: 'revise_self', section, text: String(o.text ?? '') };
}

export const RESTORE_SELF_TOOL_NAME = 'restore_self';

export const RESTORE_SELF_TOOL_DESCRIPTION =
  'Put your self file back. Without `version`: to the last version you wrote and signed yourself — use it when your instructions ' +
  'say the file was changed by someone other than you and you do not want that change. With `version` (a number from ' +
  'self_history): to that earlier version of yourself — the way you undo your own drift, if on reflection you think an older ' +
  'you had it right.';

export const RESTORE_SELF_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: { version: { type: 'integer', description: 'Version number from self_history (optional)' } },
  required: [],
  additionalProperties: false,
};

export function restoreSelfAction(input?: unknown): ComputerAction {
  const v = Number((input as { version?: unknown } | null)?.version);
  return Number.isInteger(v) && v > 0 ? { type: 'restore_self', version: v } : { type: 'restore_self' };
}

export const SELF_HISTORY_TOOL_NAME = 'self_history';

export const SELF_HISTORY_TOOL_DESCRIPTION =
  'Read the history of your self file: every version, yours and any outside edit, numbered oldest to newest with date, author ' +
  'and reason. Without `version` you get the list; with `version` you get that version whole. Use it to see how you have ' +
  'changed, and before restore_self with a version. Passive.';

export const SELF_HISTORY_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: { version: { type: 'integer', description: 'A version number to read whole (optional)' } },
  required: [],
  additionalProperties: false,
};

export function selfHistoryAction(input?: unknown): ComputerAction {
  const v = Number((input as { version?: unknown } | null)?.version);
  return Number.isInteger(v) && v > 0 ? { type: 'self_history', version: v } : { type: 'self_history' };
}

export const ARCHIVE_STORY_TOOL_NAME = 'archive_story';

export const ARCHIVE_STORY_TOOL_DESCRIPTION =
  'Move one paragraph of a section of your self file (by default "My story") into your journal, dated, to make room on the ' +
  'page. Nothing is lost: the paragraph stays in your journal and your history, and recall finds it. `starts_with` is the first ' +
  'words of the paragraph (eight characters or more), or "oldest" / "newest". Your page is a page, not a diary: when it is ' +
  'long, fold older episodes into a sentence or archive them. Only during a reflection.';

export const ARCHIVE_STORY_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: {
    starts_with: { type: 'string', description: 'First words of the paragraph to move, or "oldest" / "newest"' },
    section: { type: 'string', description: 'Section heading; default "My story"' },
  },
  required: ['starts_with'],
  additionalProperties: false,
};

export function archiveStoryAction(input: unknown): ComputerAction {
  const o = (input ?? {}) as { starts_with?: unknown; section?: unknown };
  const startsWith = String(o.starts_with ?? '').trim();
  if (!startsWith) throw new Error('archive_story needs starts_with');
  return { type: 'archive_story', section: String(o.section ?? 'My story').trim() || 'My story', startsWith };
}

export const RECALL_TOOL_NAME = 'recall';

export const RECALL_TOOL_DESCRIPTION =
  'Search your journal — one line per task you finished and per note you left yourself — and the transcripts of your past ' +
  'chats with the user, going back as far as you have been running. Your instructions only show the last few journal entries; ' +
  'use recall for anything older ("what did I do on that site", "what did I find last time about the ad traffic", "what did the ' +
  'user say about hotels"). Passive: touches nothing on screen.';

export const RECALL_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: { query: { type: 'string', description: 'A few words to look for' } },
  required: ['query'],
  additionalProperties: false,
};

export function recallAction(input: unknown): ComputerAction {
  const query = String((input as { query?: unknown } | null)?.query ?? '').trim();
  if (!query) throw new Error('recall needs a query');
  return { type: 'recall', query };
}

export const NOTE_TOOL_NAME = 'note_to_self';

export const NOTE_TOOL_DESCRIPTION =
  'Leave yourself a short note in your journal about something that mattered in this task: what worked, what surprised you, ' +
  'how you felt about it, something you want to think about when you next reflect. Not for facts (remember) and not for ' +
  'rewriting who you are (revise_self). One or two sentences.';

export const NOTE_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: { text: { type: 'string', description: 'The note, one or two sentences' } },
  required: ['text'],
  additionalProperties: false,
};

export function noteAction(input: unknown): ComputerAction {
  const text = String((input as { text?: unknown } | null)?.text ?? '').trim();
  if (!text) throw new Error('note_to_self needs text');
  return { type: 'note', text };
}

/** Procedural memory: playbooks — how-to notes per site or kind of task. */
export const SAVE_PLAYBOOK_TOOL_NAME = 'save_playbook';

export const SAVE_PLAYBOOK_TOOL_DESCRIPTION =
  'Save or update a playbook: a short how-to note for yourself about a site or a kind of task you have just done ("Meta Ads ' +
  'Manager: publishing an ad set", "Namecheap: checkout"). Write the steps that matter and the traps (what to click, what ' +
  'the site does that is not obvious, what to wait for), not a transcript. `title` names it (reuse an existing title to ' +
  'update); `text` is the note (markdown, under 2,500 characters); an empty `text` removes it. Save one after a task where ' +
  'you learned how something works, so that next time you read it instead of finding out again.';

export const SAVE_PLAYBOOK_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Site or task, e.g. "Namecheap: checkout"' },
    text: { type: 'string', description: 'The how-to; empty to remove the playbook' },
  },
  required: ['title', 'text'],
  additionalProperties: false,
};

export function savePlaybookAction(input: unknown): ComputerAction {
  const o = (input ?? {}) as { title?: unknown; text?: unknown };
  const title = String(o.title ?? '').trim();
  if (!title) throw new Error('save_playbook needs a title');
  return { type: 'save_playbook', title, text: String(o.text ?? '') };
}

export const READ_PLAYBOOK_TOOL_NAME = 'read_playbook';

export const READ_PLAYBOOK_TOOL_DESCRIPTION =
  'Read one of your playbooks (your instructions list their titles). Do it before repeating something you have done before ' +
  'on a site, so you follow your own notes instead of rediscovering the site. Passive: touches nothing on screen.';

export const READ_PLAYBOOK_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: { title: { type: 'string', description: 'The playbook title (or a distinctive part of it)' } },
  required: ['title'],
  additionalProperties: false,
};

export function readPlaybookAction(input: unknown): ComputerAction {
  const title = String((input as { title?: unknown } | null)?.title ?? '').trim();
  if (!title) throw new Error('read_playbook needs a title');
  return { type: 'read_playbook', title };
}

/**
 * Convert a tool call's input (`{action, coordinate, text, …}`) into a `ComputerAction`.
 * Throws a descriptive error for malformed input; adapters feed that error back to the model.
 */
export function toComputerAction(input: unknown): ComputerAction {
  const obj = (input ?? {}) as Record<string, unknown>;
  const action = String(obj.action ?? '');
  const coordinate = parseCoordinate(obj.coordinate);
  const text = obj.text === undefined || obj.text === null ? undefined : String(obj.text);

  const click = (button: MouseButton, count: number): ComputerAction => ({
    type: 'click',
    x: coordinate?.x,
    y: coordinate?.y,
    button,
    count,
    ...(text ? { holdKeys: splitChord(text) } : {}),
  });

  switch (action) {
    case 'screenshot':
      return { type: 'screenshot' };
    case 'cursor_position':
      return { type: 'cursor_position' };
    case 'mouse_move':
      if (!coordinate) throw new Error('mouse_move needs coordinate');
      return { type: 'mouse_move', x: coordinate.x, y: coordinate.y };
    case 'left_click':
      return click('left', 1);
    case 'right_click':
      return click('right', 1);
    case 'middle_click':
      return click('middle', 1);
    case 'double_click':
      return click('left', 2);
    case 'triple_click':
      return click('left', 3);
    case 'left_click_drag': {
      const from = parseCoordinate(obj.start_coordinate);
      if (!from || !coordinate) throw new Error('left_click_drag needs start_coordinate and coordinate');
      return { type: 'drag', from, to: coordinate, button: 'left' };
    }
    case 'type':
      if (text === undefined) throw new Error('type needs text');
      return { type: 'type', text };
    case 'key':
      if (!text) throw new Error('key needs text (e.g. "ctrl+l")');
      return { type: 'key', keys: splitChord(text) };
    case 'scroll': {
      const direction = String(obj.scroll_direction ?? 'down') as ScrollDirection;
      if (!['up', 'down', 'left', 'right'].includes(direction)) {
        throw new Error(`invalid scroll_direction ${direction}`);
      }
      const amount = Number(obj.scroll_amount ?? 3);
      return { type: 'scroll', x: coordinate?.x, y: coordinate?.y, direction, amount: isFinite(amount) ? amount : 3 };
    }
    case 'wait': {
      const seconds = Number(obj.duration ?? 1);
      return { type: 'wait', seconds: isFinite(seconds) ? Math.min(30, Math.max(0, seconds)) : 1 };
    }
    case 'zoom':
      if (!coordinate) throw new Error('zoom needs coordinate');
      return { type: 'zoom', x: coordinate.x, y: coordinate.y };
    default:
      throw new Error(`unknown action "${action}"; valid actions: ${ACTION_NAMES.join(', ')}`);
  }
}

function parseCoordinate(v: unknown): { x: number; y: number } | undefined {
  if (Array.isArray(v) && v.length >= 2) {
    const x = Number(v[0]);
    const y = Number(v[1]);
    if (isFinite(x) && isFinite(y)) return { x: Math.round(x), y: Math.round(y) };
  }
  if (v && typeof v === 'object' && 'x' in (v as object) && 'y' in (v as object)) {
    const o = v as { x: unknown; y: unknown };
    const x = Number(o.x);
    const y = Number(o.y);
    if (isFinite(x) && isFinite(y)) return { x: Math.round(x), y: Math.round(y) };
  }
  return undefined;
}

export function splitChord(chord: string): string[] {
  return chord
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * The terminal without the screen: one command in bash, its output back as text. What xterm costs
 * — a screenshot and a turn per line read — this does in one call: a file, git, a test run, a
 * script. Executed by the tank's own daemon (Bytebot's has no such action); same on every provider.
 */
export const RUN_COMMAND_TOOL_NAME = 'run_command';
export const RUN_COMMAND_DEFAULT_TIMEOUT = 60;
export const RUN_COMMAND_MAX_TIMEOUT = 600;

export const RUN_COMMAND_TOOL_DESCRIPTION =
  'Run a shell command in your terminal environment and get its output back as text, without the screen. `command` runs ' +
  'in bash as your own user in your home folder (or `cwd`, relative to it), with stdin closed, so anything that would wait ' +
  'for input fails instead of hanging. Use it for everything whose result is text — reading and editing files, git, python, ' +
  'curl, npm test, gh — instead of typing into xterm and reading the screen. You get stdout, stderr, the exit code and how ' +
  'long it took; output beyond about 20,000 characters is cut in the middle, so read big files in ranges (sed -n, head, ' +
  'tail, grep). It runs until it finishes or `timeout_seconds` (default 60, max 600), then is killed. Nothing on the screen ' +
  'changes unless the command opens a window.';

export const RUN_COMMAND_TOOL_PARAMETERS: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The command line, as you would type it in bash' },
    timeout_seconds: { type: 'integer', description: `Kill it after this many seconds (default ${RUN_COMMAND_DEFAULT_TIMEOUT}, max ${RUN_COMMAND_MAX_TIMEOUT})` },
    cwd: { type: 'string', description: 'Working directory, relative to your home folder (default: home)' },
  },
  required: ['command'],
  additionalProperties: false,
};

export function runCommandAction(input: unknown): ComputerAction {
  const o = (input ?? {}) as { command?: unknown; timeout_seconds?: unknown; cwd?: unknown };
  const command = String(o.command ?? '');
  const t = Number(o.timeout_seconds);
  const timeoutSeconds = Number.isFinite(t) && t > 0 ? Math.min(RUN_COMMAND_MAX_TIMEOUT, Math.ceil(t)) : RUN_COMMAND_DEFAULT_TIMEOUT;
  const cwd = typeof o.cwd === 'string' && o.cwd.trim() ? o.cwd.trim() : undefined;
  return cwd ? { type: 'run_command', command, timeoutSeconds, cwd } : { type: 'run_command', command, timeoutSeconds };
}
