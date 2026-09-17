/**
 * Find-or-start, decided once for every host that wants a gateway on this computer: the extension
 * (`spawn.ts`, which then starts one detached) and the app (`app/main.ts`, which starts one in its
 * own process). Pure, so the table is tested without a gateway. No `vscode` import.
 *
 * "Older" is a lower version, then an earlier build of the same version (the build id is the build's
 * time in base 36). It is not "different": the extension and each app installer come from separate
 * builds, and if any difference meant "replace", the extension and the app would shut each other's
 * gateway down in turn. With an order, the newer build replaces the older one once and the older
 * one then attaches to it.
 */

export type GatewayAction =
  /** Nothing answers: start one. */
  | 'start'
  /** The same build, or a newer one: use it. */
  | 'use'
  /** An older build with nothing running: ask it to shut down, then start this build. */
  | 'replace'
  /** An older build busy with a task: use it (and say so); it is replaced at a later start. */
  | 'use-busy';

/** `0.1.37+m1abc2` → numbers and the build time, or undefined for what cannot be read (`+dev`, a missing id). */
function parseVersion(v: string): { parts: number[]; build?: number } | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\+([0-9a-z]+))?$/.exec(v.trim());
  if (!m) return undefined;
  const build = m[4] && m[4] !== 'dev' ? parseInt(m[4], 36) : undefined;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], build: Number.isFinite(build) ? build : undefined };
}

/** True when `running` is an older build than `mine`. An order that cannot be read is not "older". */
export function isOlderBuild(running: string, mine: string): boolean {
  const a = parseVersion(running);
  const b = parseVersion(mine);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i];
  return a.build !== undefined && b.build !== undefined && a.build < b.build;
}

/**
 * What to do about port 9980. `running` is what `/status` said (absent when nothing answered) and,
 * for an older build only, whether its snapshot said busy (`undefined` when it could not be asked:
 * it is then used as it is, never shut down blind).
 */
export function decideGateway(mine: string, running?: { version: string; busy?: boolean }): GatewayAction {
  if (!running) return 'start';
  if (!isOlderBuild(running.version, mine)) return 'use';
  if (running.busy === true) return 'use-busy';
  return running.busy === false ? 'replace' : 'use';
}
