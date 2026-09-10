import type { DesktopDaemonComputer, DesktopFileEntry } from '../computer/daemon';

/** Where the file exchange with the user lives on the bot's desktop. */
export const UPLOADS_DIR = '/home/bot/Uploads';
export const DOWNLOADS_DIR = '/home/bot/Downloads';

export interface NewDownload {
  name: string;
  path: string;
  size: number;
}

/**
 * Watches the desktop's Downloads folder by polling the daemon (`list_files`) and reports files
 * that appear while watching — once they have stopped growing and Firefox's `.part` file is gone.
 * Files already present when watching starts are not reported (they belong to an earlier session;
 * the "Save a file from the desktop" command lists those).
 *
 * Pure Node so it can be tested without VS Code.
 */
export class DownloadsWatcher {
  private timer?: NodeJS.Timeout;
  private seen?: Set<string>;
  /** Files present but not yet reported: name → size at the previous poll. */
  private growing = new Map<string, number>();
  private polling = false;
  private readonly listeners = new Set<(f: NewDownload) => void>();

  constructor(
    private readonly daemon: () => DesktopDaemonComputer | undefined,
    private readonly intervalMs = 2000,
    private readonly dir = DOWNLOADS_DIR,
  ) {}

  onDidDownload(listener: (f: NewDownload) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  get active(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer) return;
    this.seen = undefined;
    this.growing.clear();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.seen = undefined;
    this.growing.clear();
  }

  /** One poll; exposed for tests. Returns the files reported in this round. */
  async poll(): Promise<NewDownload[]> {
    if (this.polling) return [];
    this.polling = true;
    try {
      const daemon = this.daemon();
      if (!daemon) return [];
      let entries: DesktopFileEntry[];
      try {
        entries = await daemon.listFiles(this.dir);
      } catch {
        return []; // desktop going away or an old daemon without list_files: try again later
      }
      const files = entries.filter((e) => !e.dir);
      const names = new Set(files.map((f) => f.name));
      if (!this.seen) {
        // First look: everything present now is old news.
        this.seen = new Set(names);
        return [];
      }
      const reported: NewDownload[] = [];
      for (const f of files) {
        if (this.seen.has(f.name)) continue;
        if (isTemporary(f.name) || names.has(`${f.name}.part`)) continue;
        const previous = this.growing.get(f.name);
        if (previous === f.size) {
          // Same size on two consecutive polls with no .part sibling: the download is complete.
          this.seen.add(f.name);
          this.growing.delete(f.name);
          const d = { name: f.name, path: `${this.dir}/${f.name}`, size: f.size };
          reported.push(d);
          for (const l of this.listeners) l(d);
        } else {
          this.growing.set(f.name, f.size);
        }
      }
      // Forget files that disappeared before completing.
      for (const name of Array.from(this.growing.keys())) if (!names.has(name)) this.growing.delete(name);
      for (const name of Array.from(this.seen)) if (!names.has(name)) this.seen.delete(name);
      return reported;
    } finally {
      this.polling = false;
    }
  }
}

/** Firefox / curl / wget in-progress names and editor leftovers. */
export function isTemporary(name: string): boolean {
  return name.startsWith('.') || /\.(part|crdownload|tmp|download)$/i.test(name);
}

/** Make a host file name safe as a single path component on the desktop. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[\0]/g, '').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
