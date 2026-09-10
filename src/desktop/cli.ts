import { execFile } from 'node:child_process';

/** Small helpers around the container CLI and the daemon, shared by the engine and the controller. */

export type ContainerCli = 'docker' | 'podman';
export type ContainerCliPreference = 'auto' | ContainerCli;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export function exec(bin: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message).toString().trim();
        reject(new Error(`${bin} ${args.slice(0, 2).join(' ')}: ${detail.slice(0, 400)}`));
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

export function onPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

/** `auto` prefers docker when it is installed *and* running, else podman. */
export async function resolveContainerCli(pref: ContainerCliPreference): Promise<ContainerCli | undefined> {
  if (pref !== 'auto') return pref;
  const [docker, podman] = await Promise.all([onPath('docker'), onPath('podman')]);
  if (docker) {
    // docker CLI present but daemon down is common on Linux — treat it as absent then
    const alive = await exec('docker', ['info'], { timeoutMs: 5000 }).then(() => true, () => false);
    if (alive) return 'docker';
  }
  if (podman) return 'podman';
  return docker ? 'docker' : undefined;
}

/** GET <daemon>/ with a short timeout; true if it answers 2xx. */
export async function probeDesktop(daemonUrl: string, token: string, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(daemonUrl.replace(/\/+$/, '') + '/', {
      signal: ctrl.signal,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function portOf(url: string, fallback = 9990): number {
  try {
    const u = new URL(url);
    return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  } catch {
    return fallback;
  }
}
