/**
 * Provider-neutral vocabulary for controlling a computer.
 *
 * Every model adapter (Anthropic, OpenAI-compatible, …) translates the model's tool calls into
 * `ComputerAction`s, and every computer provider (our desktop daemon, the mock, Bytebot, …)
 * executes them. Nothing on either side needs to know about the other.
 */

export interface Point {
  x: number;
  y: number;
}

export type MouseButton = 'left' | 'right' | 'middle';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export type ComputerAction =
  | { type: 'screenshot' }
  | { type: 'cursor_position' }
  | { type: 'mouse_move'; x: number; y: number }
  | {
      type: 'click';
      x?: number;
      y?: number;
      button: MouseButton;
      /** 1 = click, 2 = double click, 3 = triple click */
      count: number;
      /** modifier keys held during the click, xdotool names (ctrl, shift, alt, super) */
      holdKeys?: string[];
    }
  | { type: 'drag'; from: Point; to: Point; button?: MouseButton }
  | { type: 'type'; text: string }
  /** A key chord, e.g. ['ctrl', 'l'] or ['Return']. xdotool-style names. */
  | { type: 'key'; keys: string[] }
  | { type: 'scroll'; x?: number; y?: number; direction: ScrollDirection; amount: number }
  | { type: 'wait'; seconds: number }
  /**
   * Standby: wait up to `minutes` for something without spending model turns. Loop-executed: the
   * loop polls screenshots locally and wakes the model when the screen (or `region`, in
   * screenshot pixels) changes and settles (`until` "change"), or only when the time is up
   * (`until` "time"). Stop ends it at once. Passive — touches nothing.
   */
  | { type: 'wait_for'; reason: string; minutes: number; until: 'change' | 'time'; region?: { x: number; y: number; w: number; h: number } }
  /**
   * Magnify the area around a point: the loop (not the provider) crops the native screenshot and
   * returns an enlarged, coordinate-ruled view in the action result. Passive — touches nothing.
   */
  | { type: 'zoom'; x: number; y: number }
  /**
   * Read a page of Deskfish's own documentation. Loop-executed like zoom: the text comes back in
   * the action result and the computer never sees it. Passive — touches nothing.
   */
  | { type: 'read_docs'; page: string }
  /**
   * The Firefox page itself, through the page bridge extension in the tank: elements matching a
   * query (best first) or everything interactive on the page, with click coordinates. Passive.
   */
  | { type: 'find'; query: string; limit?: number }
  | { type: 'read_page'; scope?: 'interactive' | 'text' }
  /**
   * Run a shell command in the tank (bash, as the bot user, stdin closed) and get its output back
   * as text. The daemon runs it outside its input queue; the loop renders the result for the
   * model. Passive for the screen: no settle, no stall bookkeeping.
   */
  | { type: 'run_command'; command: string; timeoutSeconds?: number; cwd?: string }
  /** Long-term memory, loop-executed: save one fact / delete matching facts. Passive. */
  | { type: 'remember'; text: string }
  | { type: 'forget'; query: string }
  /** Who the bot is: replace/add/remove one section of its self file (applied during reflection, queued otherwise). Passive. */
  | { type: 'revise_self'; section: string; text: string }
  /** Go back to the last self the bot signed itself (after an outside edit), or to a numbered earlier version. Passive. */
  | { type: 'restore_self'; version?: number }
  /** Read the bot's own history of self versions: the list, or one version's text. Passive. */
  | { type: 'self_history'; version?: number }
  /** Move one paragraph of a self section (default "My story") into the journal, to make room. Passive. */
  | { type: 'archive_story'; section: string; startsWith: string }
  /** Search the bot's journal (episodic memory). Passive. */
  | { type: 'recall'; query: string }
  /** A note the bot leaves for itself, considered at its next reflection. Passive. */
  | { type: 'note'; text: string }
  /** Procedural memory, loop-executed: save/replace a how-to note (empty text removes it) / read one. Passive. */
  | { type: 'save_playbook'; title: string; text: string }
  | { type: 'read_playbook'; title: string }
  /**
   * Not a computer action: the model hands the desktop to the human (login, 2FA, CAPTCHA,
   * confirmation, or it is stuck). The loop pauses until the user resumes; the computer never sees it.
   */
  | { type: 'ask_user'; reason: string };

export interface Screenshot {
  /** PNG bytes at native resolution */
  png: Buffer;
  width: number;
  height: number;
}

/** One element of a web page, as the page bridge reports it. Coordinates are native screen pixels. */
export interface PageElement {
  role: string;
  name: string;
  /** Current state worth knowing: value, checked, selected option, disabled, expanded… */
  state?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Inside the viewport and not covered by something else (so a click at x,y reaches it). */
  visible: boolean;
  covered?: boolean;
  /** Distance outside the viewport in screen pixels, when off-screen. */
  below?: number;
  above?: number;
  score?: number;
}

/** What find / read_page return: the page's identity, its viewport on screen and the elements. */
export interface PageInfo {
  url: string;
  title: string;
  viewport?: { x: number; y: number; width: number; height: number; scrollY: number; pageHeight: number };
  elements: PageElement[];
  /** Page text, for read_page with scope "text". */
  text?: string;
  /** Number of candidate elements considered. */
  total?: number;
  /** Elements not listed: further visible ones over the limit, and off-screen ones below / above. */
  more?: { visible: number; below: number; above: number };
}

/** What run_command returns, as the daemon reports it. */
export interface CommandOutput {
  stdout: string;
  stderr: string;
  /** Exit code, or null when the command was killed (timeout, or the task was stopped). */
  exit: number | null;
  timedOut: boolean;
  /** Wall-clock milliseconds. */
  ms: number;
  /** Set when the daemon stopped capturing because the output grew too large. */
  truncated?: boolean;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Filled for cursor_position (native coordinates). */
  cursor?: Point;
  /** Filled for find / read_page (native coordinates); the loop renders it into `message` in screenshot coordinates. */
  page?: PageInfo;
  /** Filled for run_command; the loop renders it into `message`. */
  command?: CommandOutput;
  /** Free-text outcome for the model, e.g. what happened after ask_user. */
  message?: string;
  /** An image for the model, e.g. the magnified view a zoom action produced. */
  image?: { jpeg: Buffer; width: number; height: number };
}

export interface ComputerProvider {
  readonly name: string;
  /** Native resolution of the controlled display. */
  displaySize(): Promise<{ width: number; height: number }>;
  screenshot(): Promise<Screenshot>;
  /**
   * Execute one action. Coordinates are native display pixels. Never throws — errors come back in
   * the result. `signal`, when given, cancels a long action (a run_command) because the task was
   * stopped; providers that cannot cancel may ignore it.
   */
  execute(action: ComputerAction, signal?: AbortSignal): Promise<ActionResult>;
  /**
   * Release every mouse button and modifier key on the display. A press whose release got lost
   * (agent stopped mid-chord, VNC click released outside the pane) otherwise turns every later
   * click into a drag-select or a ctrl-click. Safe to call any time.
   */
  releaseInput?(): Promise<string[] | void>;
}

/** Human-readable one-liner for logs and the chat feed. */
export function describeAction(a: ComputerAction): string {
  switch (a.type) {
    case 'screenshot':
      return 'screenshot';
    case 'cursor_position':
      return 'cursor position';
    case 'mouse_move':
      return `move mouse to (${a.x}, ${a.y})`;
    case 'click': {
      const name = a.count === 3 ? 'triple click' : a.count === 2 ? 'double click' : `${a.button} click`;
      const at = a.x !== undefined && a.y !== undefined ? ` at (${a.x}, ${a.y})` : '';
      const hold = a.holdKeys?.length ? ` holding ${a.holdKeys.join('+')}` : '';
      return `${name}${at}${hold}`;
    }
    case 'drag':
      return `drag from (${a.from.x}, ${a.from.y}) to (${a.to.x}, ${a.to.y})`;
    case 'type':
      return `type ${JSON.stringify(a.text.length > 60 ? a.text.slice(0, 57) + '…' : a.text)}`;
    case 'key':
      return `press ${a.keys.join('+')}`;
    case 'scroll': {
      const at = a.x !== undefined && a.y !== undefined ? ` at (${a.x}, ${a.y})` : '';
      return `scroll ${a.direction} ×${a.amount}${at}`;
    }
    case 'wait':
      return `wait ${a.seconds}s`;
    case 'wait_for': {
      const m = a.minutes >= 1 ? `${Math.round(a.minutes * 10) / 10} min` : `${Math.round(a.minutes * 60)} s`;
      return `stand by up to ${m}${a.until === 'time' ? '' : ' for a change'}: ${a.reason}`;
    }
    case 'zoom':
      return `zoom into (${a.x}, ${a.y})`;
    case 'read_docs':
      return `read the docs: ${a.page}`;
    case 'find':
      return `find on the page: ${JSON.stringify(a.query)}`;
    case 'read_page':
      return a.scope === 'text' ? 'read the page text' : 'read the page';
    case 'run_command':
      return `run: ${a.command.length > 60 ? a.command.slice(0, 57) + '…' : a.command}`;
    case 'remember':
      return `remember: ${a.text}`;
    case 'forget':
      return `forget: ${a.query}`;
    case 'revise_self':
      return a.text ? `revise who I am: ${a.section}` : `remove from who I am: ${a.section}`;
    case 'restore_self':
      return a.version ? `restore who I am to version ${a.version}` : 'restore who I am';
    case 'self_history':
      return a.version ? `read version ${a.version} of who I am` : 'read my history';
    case 'archive_story':
      return `archive a paragraph of "${a.section}" to my journal`;
    case 'recall':
      return `recall: ${a.query}`;
    case 'note':
      return `note to self: ${a.text}`;
    case 'save_playbook':
      return a.text ? `save playbook: ${a.title}` : `remove playbook: ${a.title}`;
    case 'read_playbook':
      return `read playbook: ${a.title}`;
    case 'ask_user':
      return `asks you: ${a.reason}`;
  }
}
