import type { ActionResult, ComputerAction, ComputerProvider, Screenshot } from './types';

/**
 * ComputerProvider for the desktop daemon protocol: `POST /computer-use/computer` with
 * `{ action: '...', ...params }`, returning `{ success, data?, error? }`.
 *
 * Speakers of this protocol:
 *   - docker/desktop/daemon.mjs   — Deskfish's own slim desktop image (Debian + Openbox + Firefox)
 *   - scripts/mock-daemon.mjs     — the synthetic desktop used in tests
 *   - Bytebot's bytebotd          — if you'd rather run their (much larger) Ubuntu/XFCE image
 *
 * Optional bearer token (`DAEMON_TOKEN` on the daemon side) protects the API.
 */

interface DaemonResponse {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export interface DaemonOptions {
  token?: string;
  fetchImpl?: typeof fetch;
}

/** One entry of a `list_files` listing. */
export interface DesktopFileEntry {
  name: string;
  size: number;
  /** Modification time, ms since epoch. */
  mtime: number;
  dir: boolean;
}

export class DesktopDaemonComputer implements ComputerProvider {
  readonly name = 'desktop-daemon';
  private size?: { width: number; height: number };
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly opts: DaemonOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async displaySize(): Promise<{ width: number; height: number }> {
    if (!this.size) {
      await this.screenshot();
    }
    return this.size!;
  }

  async screenshot(): Promise<Screenshot> {
    const res = await this.call({ action: 'screenshot' });
    const b64 = res.data?.image;
    if (typeof b64 !== 'string') {
      throw new Error('daemon screenshot response has no data.image');
    }
    const png = Buffer.from(b64, 'base64');
    const { width, height } = pngDimensions(png);
    this.size = { width, height };
    return { png, width, height };
  }

  async execute(action: ComputerAction, signal?: AbortSignal): Promise<ActionResult> {
    try {
      switch (action.type) {
        case 'screenshot':
          // The agent loop always takes a screenshot after a batch of actions; nothing to do here.
          return { ok: true };

        case 'cursor_position': {
          const r = await this.call({ action: 'cursor_position' });
          return { ok: true, cursor: { x: Number(r.data?.x), y: Number(r.data?.y) } };
        }

        case 'mouse_move':
          await this.call({ action: 'move_mouse', coordinates: { x: action.x, y: action.y } });
          return { ok: true };

        case 'click':
          await this.call({
            action: 'click_mouse',
            ...(action.x !== undefined && action.y !== undefined ? { coordinates: { x: action.x, y: action.y } } : {}),
            button: action.button,
            clickCount: action.count,
            ...(action.holdKeys?.length ? { holdKeys: action.holdKeys } : {}),
          });
          return { ok: true };

        case 'drag':
          await this.call({ action: 'drag_mouse', path: [action.from, action.to], button: action.button ?? 'left' });
          return { ok: true };

        case 'type':
          await this.call({ action: 'type_text', text: action.text });
          return { ok: true };

        case 'key': {
          // Hold every key of the chord down in order, then release in reverse order — the
          // unambiguous way to express ctrl+l / alt+F4 / Return on the press_keys API.
          await this.call({ action: 'press_keys', keys: action.keys, press: 'down' });
          await this.call({ action: 'press_keys', keys: [...action.keys].reverse(), press: 'up' });
          return { ok: true };
        }

        case 'scroll':
          await this.call({
            action: 'scroll',
            ...(action.x !== undefined && action.y !== undefined ? { coordinates: { x: action.x, y: action.y } } : {}),
            direction: action.direction,
            scrollCount: Math.max(1, Math.round(action.amount)),
          });
          return { ok: true };

        case 'wait':
          await this.call({ action: 'wait', duration: Math.round(action.seconds * 1000) });
          return { ok: true };

        case 'find': {
          const r = await this.call({ action: 'page_find', query: action.query, limit: action.limit });
          return { ok: true, page: r.data as ActionResult['page'] };
        }

        case 'read_page': {
          const r = await this.call({ action: 'page_read', scope: action.scope ?? 'interactive' });
          return { ok: true, page: r.data as ActionResult['page'] };
        }

        case 'run_command': {
          // The daemon enforces the command's own timeout; the request gets a margin on top of it,
          // and Stop aborts the request, which makes the daemon kill the process.
          const timeoutSeconds = action.timeoutSeconds ?? 60;
          const r = await this.call(
            { action: 'run_command', command: action.command, timeout_seconds: timeoutSeconds, ...(action.cwd ? { cwd: action.cwd } : {}) },
            { signal, timeoutMs: (timeoutSeconds + 30) * 1000 },
          );
          return { ok: true, command: r.data as unknown as ActionResult['command'] };
        }

        case 'wait_for':
        case 'zoom':
        case 'read_docs':
        case 'remember':
        case 'forget':
        case 'revise_self':
        case 'restore_self':
        case 'self_history':
        case 'archive_story':
        case 'recall':
        case 'note':
        case 'save_playbook':
        case 'read_playbook':
        case 'ask_user':
          // Handled by the agent loop (zoom renders a view, ask_user pauses); never reach the computer.
          return { ok: true };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Put text on the desktop's clipboard (Deskfish daemon extension; Bytebot's daemon lacks it). */
  async setClipboard(text: string): Promise<void> {
    await this.call({ action: 'set_clipboard', text });
  }

  async getClipboard(): Promise<string> {
    const r = await this.call({ action: 'get_clipboard' });
    return typeof r.data?.text === 'string' ? r.data.text : '';
  }

  /*
   * File exchange. Paths are inside the desktop's home; the daemon refuses anything else.
   * read_file/write_file exist on Bytebot's daemon too; list_files is Deskfish's addition.
   */

  async readFile(filePath: string): Promise<{ name: string; data: Buffer }> {
    const r = await this.call({ action: 'read_file', path: filePath });
    const b64 = r.data?.data;
    if (typeof b64 !== 'string') throw new Error(`read_file returned no data for ${filePath}`);
    const name = typeof r.data?.name === 'string' ? r.data.name : filePath.split('/').pop() || 'file';
    return { name, data: Buffer.from(b64, 'base64') };
  }

  async writeFile(filePath: string, data: Uint8Array): Promise<void> {
    await this.call({ action: 'write_file', path: filePath, data: Buffer.from(data).toString('base64') });
  }

  /** Non-recursive listing, newest first. */
  async listFiles(dirPath: string): Promise<DesktopFileEntry[]> {
    const r = await this.call({ action: 'list_files', path: dirPath });
    const entries = r.data?.entries;
    return Array.isArray(entries) ? (entries as DesktopFileEntry[]) : [];
  }

  /** Uses only press_keys/press_mouse "up", so it works with any daemon speaking the protocol. */
  /**
   * Let go of whatever the display holds. A current daemon looks at the X server's XTEST state and
   * releases exactly that, naming it; an older one gets the blanket release of the modifiers and
   * the three buttons.
   */
  async releaseInput(): Promise<string[]> {
    try {
      const r = await this.call({ action: 'release_input', reason: 'deskfish' });
      const released = (r.data as { released?: unknown } | undefined)?.released;
      return Array.isArray(released) ? released.map(String) : [];
    } catch {
      /* older daemon without release_input */
    }
    const calls: Record<string, unknown>[] = [
      { action: 'press_keys', keys: ['ctrl', 'shift', 'alt', 'super'], press: 'up' },
      { action: 'press_mouse', button: 'left', press: 'up' },
      { action: 'press_mouse', button: 'middle', press: 'up' },
      { action: 'press_mouse', button: 'right', press: 'up' },
    ];
    for (const body of calls) {
      await this.call(body).catch(() => undefined);
    }
    return [];
  }

  private async call(body: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DaemonResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/computer-use/computer`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    const signals: AbortSignal[] = [];
    if (opts.signal) signals.push(opts.signal);
    if (opts.timeoutMs) signals.push(AbortSignal.timeout(opts.timeoutMs));
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    let r: Response;
    try {
      r = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    } catch (err) {
      throw new Error(`cannot reach desktop daemon at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!r.ok) {
      throw new Error(`daemon HTTP ${r.status} for ${String(body.action)}: ${(await r.text()).slice(0, 300)}`);
    }
    const json = (await r.json()) as DaemonResponse;
    if (json.success === false) {
      throw new Error(json.error ?? `daemon rejected ${String(body.action)}`);
    }
    return json;
  }
}

/** Read width/height from a PNG's IHDR chunk without decoding the image. */
export function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('screenshot is not a PNG');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
