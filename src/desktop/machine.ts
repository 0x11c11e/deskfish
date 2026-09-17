import { spawn } from 'node:child_process';
import { exec, type ContainerCli } from './cli';
import type { EngineLog } from './engine';

/**
 * Podman on macOS and Windows runs containers inside a small Linux VM, "podman machine". Before the
 * tank can be built or run that VM must exist and be running: the engine's start calls
 * `ensurePodmanMachine` first there (never on Linux, never for Docker). The decision is a pure
 * function over `podman machine list --format json`, so it is tested without a Mac.
 *
 * Untested on a real Mac or Windows machine (none here); written from Podman's documentation.
 * No `vscode` import.
 */

export type MachineStep = { action: 'none' } | { action: 'init' } | { action: 'start'; name: string };

/** True where Podman needs its VM: macOS and Windows. */
export function needsMachine(platform: NodeJS.Platform, cli: ContainerCli): boolean {
  return cli === 'podman' && (platform === 'darwin' || platform === 'win32');
}

interface MachineRow {
  Name?: string;
  Default?: boolean;
  Running?: boolean;
  Starting?: boolean;
}

/**
 * What to do from the list's JSON: no machine → `init` (then start); one running or starting →
 * nothing; otherwise start the default machine (the first one when none is marked default). Output
 * that cannot be read → nothing: `podman build`/`run` then report the real error.
 */
export function machineStep(listJson: string): MachineStep {
  let rows: MachineRow[];
  try {
    rows = JSON.parse(listJson.trim() || '[]');
  } catch {
    return { action: 'none' };
  }
  if (!Array.isArray(rows)) return { action: 'none' };
  if (!rows.length) return { action: 'init' };
  if (rows.some((r) => r.Running || r.Starting)) return { action: 'none' };
  const pick = rows.find((r) => r.Default) ?? rows[0];
  // `podman machine list` marks the default connection with a trailing '*'.
  return { action: 'start', name: String(pick.Name ?? '').replace(/\*$/, '') };
}

/** Run a podman command, streaming its lines to the log and the newest one (at most once a second) to the progress line. */
function streamed(args: string[], prefix: string, log: EngineLog, timeoutMs: number): Promise<void> {
  log.progress(prefix);
  log.info(`podman ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn('podman', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let shownAt = 0;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const onData = (chunk: Buffer) => {
      for (const raw of chunk.toString().split(/\r?\n|\r/)) {
        const line = raw.trim();
        if (!line) continue;
        tail = line;
        log.info(`  ${line}`);
        if (Date.now() - shownAt >= 1000) {
          shownAt = Date.now();
          log.progress(`${prefix} · ${line.slice(0, 80)}`);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`podman ${args.slice(0, 2).join(' ')} failed (exit ${code}): ${tail}`)); });
  });
}

/** Create and/or start Podman's VM when the list says so. */
export async function ensurePodmanMachine(log: EngineLog): Promise<void> {
  const list = await exec('podman', ['machine', 'list', '--format', 'json'], { timeoutMs: 30_000 });
  const step = machineStep(list.stdout);
  if (step.action === 'none') return;
  if (step.action === 'init') {
    await streamed(['machine', 'init'], "Creating Podman's Linux VM — a few minutes, once", log, 30 * 60_000);
    await streamed(['machine', 'start'], "Starting Podman's Linux VM — about a minute", log, 10 * 60_000);
    return;
  }
  await streamed(['machine', 'start', ...(step.name ? [step.name] : [])], "Starting Podman's Linux VM — about a minute", log, 10 * 60_000);
}
