import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { newSelfKey } from '../agent/self';

/**
 * Where the gateway keeps her: the data dir per OS, the secrets file (API keys by slot + the key
 * that signs her self file), the gateway token, and the one-time move of her files out of VS Code's
 * globalStorage. Pure Node; no `vscode` import.
 */

/** The files that make her, as they sit in the data dir (and, before the gateway, in globalStorage). */
export const HER_FILES = ['memory.md', 'self.md', 'self.sig', 'self-history.jsonl', 'journal.md', 'journal-state.json', 'playbook.md', 'charter.md', 'schedules.json'];
export const HER_DIRS = ['chats'];

/** `$DESKFISH_HOME`, else `$XDG_DATA_HOME/deskfish` or `~/.local/share/deskfish` (Linux), `~/Library/Application Support/deskfish` (macOS), `%APPDATA%\deskfish` (Windows). */
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.DESKFISH_HOME) return p.resolve(env.DESKFISH_HOME);
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'deskfish');
  if (platform === 'win32') return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'deskfish');
  return p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'deskfish');
}

/** Write a file only its owner can read (0600), atomically: a temp file created 0600, then renamed over. */
export function writePrivate(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

interface SecretsData {
  /** API keys by slot: `deskfish.apiKey.anthropic`, `deskfish.apiKey.<endpoint host>`. */
  keys: Record<string, string>;
  /** The per-install HMAC secret that signs her self file. */
  selfKey?: string;
}

/** `secrets.json` (0600): read from disk on every call, so a key written by another process is seen. */
export class SecretsFile {
  constructor(readonly file: string) {}

  private read(): SecretsData {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SecretsData>;
      return { keys: d.keys && typeof d.keys === 'object' ? { ...d.keys } : {}, selfKey: typeof d.selfKey === 'string' ? d.selfKey : undefined };
    } catch {
      return { keys: {} };
    }
  }

  private write(d: SecretsData): void {
    writePrivate(this.file, JSON.stringify(d, null, 1) + '\n');
  }

  get(slot: string): string | undefined {
    return this.read().keys[slot] || undefined;
  }

  /** Set or (with an empty key) clear a slot. Returns true when the file changed. */
  set(slot: string, key: string | undefined): boolean {
    const d = this.read();
    if ((d.keys[slot] ?? '') === (key ?? '')) return false;
    if (key) d.keys[slot] = key;
    else delete d.keys[slot];
    this.write(d);
    return true;
  }

  /** The slots that hold a key (names only). */
  slots(): string[] {
    return Object.keys(this.read().keys).sort();
  }

  get selfKey(): string | undefined {
    return this.read().selfKey;
  }

  setSelfKey(key: string): void {
    const d = this.read();
    if (d.selfKey === key) return;
    d.selfKey = key;
    this.write(d);
  }

  /** The self key, created the first time. */
  ensureSelfKey(): string {
    const have = this.selfKey;
    if (have) return have;
    const key = newSelfKey();
    this.setSelfKey(key);
    return key;
  }
}

/** The gateway token (`gateway.token`, 32 random bytes as hex, 0600): read, or created the first time. */
export function ensureToken(dir: string): string {
  const file = path.join(dir, 'gateway.token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) {
      if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
      return t;
    }
  } catch {
    /* none yet */
  }
  const token = crypto.randomBytes(32).toString('hex');
  writePrivate(file, token + '\n');
  return token;
}

/** The token if one exists (clients never create it). */
export function readToken(dir: string): string | undefined {
  try {
    const t = fs.readFileSync(path.join(dir, 'gateway.token'), 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export interface MigrateOptions {
  /** VS Code's globalStorage for the extension (where her files lived before the gateway). */
  from: string;
  /** The data dir. */
  to: string;
  /** Reads a secret from where VS Code kept it (SecretStorage). */
  readSecret: (name: string) => Promise<string | undefined>;
  /** API key slots to carry over (`deskfish.apiKey.<slot>`). */
  slots: string[];
  /** Name of the self key in SecretStorage. */
  selfKeySecret: string;
  log: (line: string) => void;
}

export type MigrateResult = 'done' | 'already' | 'nothing' | 'kept-existing';

/**
 * Move her out of globalStorage, once. When the data dir has no self yet, her files are copied
 * byte for byte (nothing in the data dir is overwritten) and the self key travels with them, so
 * her signatures stay hers; the API keys are copied into the secrets file. When the data dir
 * already holds a self (a gateway was started there first), nothing of hers is copied: the log says
 * so and Export/Import is the way across. Either way `migrated.json` in globalStorage marks it done.
 */
export async function migrateData(o: MigrateOptions): Promise<MigrateResult> {
  const marker = path.join(o.from, 'migrated.json');
  if (fs.existsSync(marker)) return 'already';
  if (!fs.existsSync(path.join(o.from, 'self.md'))) return 'nothing';
  const secrets = new SecretsFile(path.join(o.to, 'secrets.json'));
  const fresh = !fs.existsSync(path.join(o.to, 'self.md'));
  const copyHer = fresh || !secrets.selfKey;
  const copied: string[] = [];
  const selfKey = await o.readSecret(o.selfKeySecret);
  if (copyHer) {
    // Fresh, or an earlier migration copied the files and stopped before the key: finish it.
    fs.mkdirSync(o.to, { recursive: true, mode: 0o700 });
    for (const f of HER_FILES) {
      const src = path.join(o.from, f);
      const dst = path.join(o.to, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
        copied.push(f);
      }
    }
    for (const d of HER_DIRS) {
      const src = path.join(o.from, d);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(o.to, d), { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
      copied.push(`${d}/`);
    }
    if (selfKey) secrets.setSelfKey(selfKey);
  }
  let keys = 0;
  for (const slot of o.slots) {
    if (secrets.get(slot)) continue;
    const key = await o.readSecret(slot);
    if (key && secrets.set(slot, key)) keys++;
  }
  const result: MigrateResult = copyHer ? 'done' : 'kept-existing';
  writePrivate(marker, JSON.stringify({ at: new Date().toISOString(), to: o.to, result, files: copied, keys }, null, 1) + '\n');
  o.log(
    result === 'done'
      ? `— her files moved to ${o.to} (${copied.length} items, ${keys} API key${keys === 1 ? '' : 's'}, the self key ${selfKey ? 'too' : 'was not found'}); globalStorage keeps its copy —`
      : `— ${o.to} already holds a self, so her files in ${o.from} were not copied; use Export/Import to bring them over —`,
  );
  return result;
}
