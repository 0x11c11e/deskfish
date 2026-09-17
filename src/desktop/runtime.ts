import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { onPath, resolveContainerCli, type ContainerCli, type ContainerCliPreference } from './cli';

/**
 * Container runtime detection and, when none is installed, a per-OS install plan the UI can show
 * and run in a terminal. Nothing here installs anything silently: the command is displayed, runs
 * in a visible VS Code terminal, and `sudo`/the OS asks for the password.
 *
 * Pure Node (no `vscode` import) so the plans can be unit-tested.
 */

export interface InstallPlan {
  platform: 'linux' | 'darwin' | 'win32' | 'other';
  /** What was detected, for the UI: "Debian GNU/Linux 13 (trixie)". */
  system: string;
  /** Command shown to the user and run in a terminal — absent when we don't know this system. */
  command?: string;
  /** What is still left to do after the command finishes. */
  afterwards?: string;
  docsUrl: string;
}

export type RuntimeStatus = { cli: ContainerCli } | { cli: 'none'; install: InstallPlan };

const DOCS = 'https://podman.io/docs/installation';
/** Rootless Podman needs a sub-UID range for the user; distros only add it for users created after install. */
// Both guards are parenthesised: with flat `a && b || c` chaining a failed install would fall
// through to the `||` branch and the line would still exit 0.
const SUBUID = '(grep -q "^$USER:" /etc/subuid 2>/dev/null || sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER")';
const MIGRATE = '(podman system migrate 2>/dev/null || true)';

export async function detectRuntime(pref: ContainerCliPreference): Promise<RuntimeStatus> {
  const cli = await resolveContainerCli(pref);
  if (cli && (pref === 'auto' || (await onPath(cli)))) return { cli };
  return { cli: 'none', install: await installPlan() };
}

export async function installPlan(): Promise<InstallPlan> {
  switch (process.platform) {
    case 'linux':
      return planForLinux(await fs.readFile('/etc/os-release', 'utf8').catch(() => ''));
    case 'darwin':
      return planForMac();
    case 'win32':
      return planForWindows();
    default:
      return { platform: 'other', system: `${os.type()} ${os.release()}`, docsUrl: DOCS };
  }
}

export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function planForLinux(osRelease: string): InstallPlan {
  const r = parseOsRelease(osRelease);
  const ids = `${r.ID ?? ''} ${r.ID_LIKE ?? ''}`.toLowerCase().split(/\s+/).filter(Boolean);
  const is = (...names: string[]) => names.some((n) => ids.includes(n));
  const system = r.PRETTY_NAME || r.NAME || 'Linux';
  let command: string | undefined;
  if (is('debian', 'ubuntu')) {
    // passt (pasta) gives rootless port publishing; older releases only have slirp4netns.
    command = `sudo apt-get update && sudo apt-get install -y podman uidmap && (sudo apt-get install -y passt || sudo apt-get install -y slirp4netns) && ${SUBUID} && ${MIGRATE}`;
  } else if (is('fedora', 'rhel', 'centos')) {
    command = `(sudo dnf install -y podman passt || sudo dnf install -y podman) && ${SUBUID} && ${MIGRATE}`;
  } else if (is('arch')) {
    command = `sudo pacman -S --needed --noconfirm podman passt && ${SUBUID} && ${MIGRATE}`;
  } else if (is('suse', 'opensuse')) {
    command = `sudo zypper install -y podman && ${SUBUID} && ${MIGRATE}`;
  } else if (is('alpine')) {
    command = `sudo apk add podman passt shadow-subids && ${SUBUID} && ${MIGRATE}`;
  }
  return { platform: 'linux', system, command, docsUrl: DOCS };
}

export function planForMac(): InstallPlan {
  return {
    platform: 'darwin',
    system: `macOS (Darwin ${os.release()})`,
    command:
      'command -v brew >/dev/null 2>&1 && brew install podman && podman machine init && podman machine start || echo "Could not finish. If Homebrew is missing, install it first: https://brew.sh"',
    afterwards: 'On macOS, Podman runs Linux containers in a small VM ("podman machine") — the command creates and starts it.',
    docsUrl: 'https://podman.io/docs/installation#macos',
  };
}

export function planForWindows(): InstallPlan {
  return {
    platform: 'win32',
    system: `Windows ${os.release()}`,
    command: 'winget install -e --id RedHat.Podman --accept-package-agreements --accept-source-agreements',
    afterwards: 'Then restart Deskfish (or VS Code) and turn the desktop on: the first start creates Podman\'s Linux VM. Podman needs WSL 2; the installer offers to enable it.',
    docsUrl: 'https://podman.io/docs/installation#windows',
  };
}

/** How to hand the plan's command to a terminal: POSIX shells get `sh -c` so it also works in fish. */
export function terminalCommand(plan: InstallPlan): string | undefined {
  if (!plan.command) return undefined;
  if (plan.platform === 'win32' || plan.command.includes("'")) return plan.command;
  return `sh -c '${plan.command}'`;
}
