import { sq } from '../src/gateway/autostart';

/**
 * "Install Podman" in the app: the OS's own terminal opens and runs the install command where the
 * person can read it and type their password. Guided and visible, never silent. Pure (no Electron):
 * the app tries the launches in order and runs the first whose program exists.
 *
 * Linux is checked here; the macOS and Windows launches are written from their documentation and
 * untested (no Mac, no Windows on this machine).
 */

export interface TerminalLaunch {
  file: string;
  args: string[];
  /** Windows: pass the arguments to cmd.exe as they are (its own quoting rules). */
  verbatim?: boolean;
}

const DONE = 'Finished. Go back to Deskfish and click Check again.';

/** The script a POSIX terminal runs: the command, a line saying what next, then the person's shell so the window stays. */
export function posixScript(command: string): string {
  return `${command}; echo; echo ${sq(DONE)}; exec "\${SHELL:-sh}"`;
}

/** An AppleScript string literal. */
function appleString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The launches to try, in order. Linux: Debian's `x-terminal-emulator` first, then the common
 * terminals by name (Fedora and Arch have no `x-terminal-emulator`), each told to run `sh -c`.
 */
export function terminalLaunches(platform: NodeJS.Platform, command: string): TerminalLaunch[] {
  if (platform === 'darwin') {
    const script = `sh -c ${sq(posixScript(command))}`;
    return [{ file: 'osascript', args: ['-e', `tell application "Terminal" to do script ${appleString(script)}`, '-e', 'tell application "Terminal" to activate'] }];
  }
  if (platform === 'win32') {
    // `start` opens a new console window; `cmd /k` keeps it open after the command.
    return [{ file: 'cmd.exe', args: ['/d', '/s', '/c', `"start "Deskfish: install Podman" cmd /k ${command}"`], verbatim: true }];
  }
  const sh = ['sh', '-c', posixScript(command)];
  return [
    { file: 'x-terminal-emulator', args: ['-e', ...sh] },
    { file: 'gnome-terminal', args: ['--', ...sh] },
    { file: 'konsole', args: ['-e', ...sh] },
    { file: 'xfce4-terminal', args: ['-x', ...sh] },
    { file: 'xterm', args: ['-e', ...sh] },
  ];
}
