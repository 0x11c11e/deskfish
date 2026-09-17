import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * "Keep Deskfish running when VS Code is closed", tier 2 of the plan: an entry that starts
 * `deskfish serve` when the person logs in (or at boot on a machine with no desktop session), so a
 * schedule fires and a task finishes on a computer that was restarted.
 *
 * The plan is a pure function — platform, runtime, entry, data dir, port in; the file to write and
 * the commands to run out — so it is testable without a login. The app reuses it on Linux with `argv`
 * (its own binary, `--hidden`) under a file name of its own, so the extension's entry and the app's
 * never overwrite each other; on macOS and Windows the app uses the OS login item instead. The
 * extension writes the file and shows the command in a visible terminal; nothing happens silently
 * except the rewrite after an update, when the extension's folder has moved.
 *
 * Two gateways on one data dir cannot happen: `deskfish serve` takes `gateway.pid` as a lock and a
 * second one exits (deviation 3.6). So the autostart entry and VS Code starting together is safe —
 * whichever is first owns her, the other finds it on port 9980 and becomes its client.
 *
 * Linux is verified here. macOS and Windows are written from their documentation and untested (no
 * Mac, no Windows on this machine).
 *
 * No `vscode` import.
 */

export type AutostartKind = 'xdg' | 'cron' | 'launchagent' | 'schtasks';

export interface AutostartPlan {
  kind: AutostartKind;
  /** The command line that starts the gateway at login. */
  command: string;
  /** The file the extension writes: the entry itself (Linux, macOS) or the script the task runs (Windows). */
  file?: string;
  contents?: string;
  /** What the visible terminal runs when the person turns it on (after the file is written). */
  install: string;
  /** What the visible terminal runs when the person turns it off (before the file is removed). */
  remove: string;
  /** The same install, as a plain POSIX script, for the silent rewrite after an update (not on Windows). */
  installScript?: string;
  /** Where it lives, for the log and the message. */
  where: string;
  /** The entry is not a file the extension owns: a changed command must re-run `install` (the cron line). */
  reapplyOnChange: boolean;
}

export interface AutostartOptions {
  platform: NodeJS.Platform;
  /** The runtime that runs the gateway: VS Code's own Electron, run as Node. */
  execPath: string;
  /** `<extension>/dist/gateway.js` — it moves with every version, which is why the entry is re-checked. */
  entry: string;
  dataDir: string;
  port: number;
  home: string;
  /**
   * A desktop session was seen (`XDG_CURRENT_DESKTOP` or `DISPLAY`). Linux without one is a server:
   * nothing reads `~/.config/autostart`, so the fallback is a cron `@reboot` line.
   */
  desktopSession?: boolean;
  /**
   * The app's entry (Linux only): the command line itself, e.g. `[<AppImage>, '--hidden']`. It is
   * written to `deskfish-app.desktop` without `ELECTRON_RUN_AS_NODE` (the app is Electron as itself),
   * and `execPath`, `entry`, `dataDir` and `port` are not used.
   */
  argv?: string[];
}

/** A string as one POSIX shell word. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A value for a `.desktop` file's Exec= key (reserved characters escaped as the spec asks). */
function desktopArg(s: string): string {
  return `"${s.replace(/\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/\$/g, '\\\\$').replace(/`/g, '\\\\`')}"`;
}

function xmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The gateway's own arguments, the same ones `spawn.ts` starts it with. */
function serveArgs(o: AutostartOptions): string[] {
  return [o.entry, 'serve', '--port', String(o.port), '--data-dir', o.dataDir];
}

const CRON_MARK = '# deskfish-gateway';
const LAUNCH_LABEL = 'sh.deskfish.gateway';
const TASK_NAME = 'Deskfish';

export function autostartPlan(o: AutostartOptions): AutostartPlan {
  if (o.argv) return appPlan(o, o.argv);
  const args = serveArgs(o);
  if (o.platform === 'darwin') {
    const file = path.join(o.home, 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`);
    const command = `ELECTRON_RUN_AS_NODE=1 ${[o.execPath, ...args].map(sq).join(' ')}`;
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[o.execPath, ...args].map((a) => `    <string>${xmlText(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
    const script = `launchctl unload ${sq(file)} 2>/dev/null
launchctl load -w ${sq(file)}
echo "Deskfish will start when you log in. The launch agent is ${file}:"
echo
cat ${sq(file)}`;
    const removeScript = `launchctl unload -w ${sq(file)} 2>/dev/null
rm -f ${sq(file)}
echo "Removed ${file} — Deskfish no longer starts when you log in."`;
    return { kind: 'launchagent', command, file, contents, install: `sh -c ${sq(script)}`, installScript: script, remove: `sh -c ${sq(removeScript)}`, where: file, reapplyOnChange: false };
  }

  if (o.platform === 'win32') {
    // schtasks quoting is fragile, so the task runs a one-line script the extension owns instead.
    const file = path.win32.join(o.dataDir, 'deskfish-gateway.cmd');
    const command = `"${o.execPath}" ${args.map((a) => `"${a}"`).join(' ')}`;
    const contents = ['@echo off', 'set "ELECTRON_RUN_AS_NODE=1"', `start "" /b ${command}`, ''].join('\r\n');
    return {
      kind: 'schtasks',
      command,
      file,
      contents,
      install: `cmd /c schtasks /create /f /sc onlogon /tn ${TASK_NAME} /tr "\\"${file}\\"" && type "${file}"`,
      remove: `cmd /c schtasks /delete /f /tn ${TASK_NAME}`,
      where: `the scheduled task "${TASK_NAME}" (${file})`,
      reapplyOnChange: false,
    };
  }

  const command = `env ELECTRON_RUN_AS_NODE=1 ${[o.execPath, ...args].map(sq).join(' ')}`;
  if (o.desktopSession === false) {
    const line = `@reboot ${command} ${CRON_MARK}`;
    const script = `{ crontab -l 2>/dev/null | grep -v ${sq(CRON_MARK)}; echo ${sq(line)}; } | crontab -
echo "Deskfish will start when this machine boots. Your crontab now has:"
crontab -l | grep ${sq(CRON_MARK)}`;
    const removeScript = `crontab -l 2>/dev/null | grep -v ${sq(CRON_MARK)} | crontab -
echo "Removed the @reboot line — Deskfish no longer starts at boot."`;
    return { kind: 'cron', command, install: `sh -c ${sq(script)}`, installScript: script, remove: `sh -c ${sq(removeScript)}`, where: 'a @reboot line in your crontab', reapplyOnChange: true };
  }

  const file = path.join(o.home, '.config', 'autostart', 'deskfish.desktop');
  const contents = `[Desktop Entry]
Type=Application
Name=Deskfish
Comment=Keeps Deskfish running when VS Code is closed, so her tasks and schedules do not stop with it.
Exec=env ELECTRON_RUN_AS_NODE=1 ${[o.execPath, ...args].map(desktopArg).join(' ')}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
  const script = `echo "Deskfish will start when you log in. The entry is ${file}:"
echo
cat ${sq(file)}
echo
echo "Remove it from here with: Deskfish: Keep Running When VS Code Is Closed (it toggles), or: rm ${file}"`;
  const removeScript = `rm -f ${sq(file)}
echo "Removed ${file} — Deskfish no longer starts when you log in."`;
  return { kind: 'xdg', command, file, contents, install: `sh -c ${sq(script)}`, installScript: script, remove: `sh -c ${sq(removeScript)}`, where: file, reapplyOnChange: false };
}

/** The app's login entry on Linux: an XDG autostart file of its own. */
function appPlan(o: AutostartOptions, argv: string[]): AutostartPlan {
  if (o.platform !== 'linux') throw new Error('the app uses the OS login item on macOS and Windows');
  if (!argv.length) throw new Error('argv is empty');
  const file = path.join(o.home, '.config', 'autostart', 'deskfish-app.desktop');
  const contents = `[Desktop Entry]
Type=Application
Name=Deskfish
Comment=Starts Deskfish in the tray when you log in, so her tasks and schedules keep going.
Exec=${argv.map(desktopArg).join(' ')}
Icon=deskfish
Terminal=false
X-GNOME-Autostart-enabled=true
`;
  const removeScript = `rm -f ${sq(file)}
echo "Removed ${file} — Deskfish no longer starts when you log in."`;
  return {
    kind: 'xdg',
    command: argv.map(sq).join(' '),
    file,
    contents,
    install: `sh -c ${sq(`cat ${sq(file)}`)}`,
    installScript: `cat ${sq(file)}`,
    remove: `sh -c ${sq(removeScript)}`,
    where: file,
    reapplyOnChange: false,
  };
}

/** Is a desktop session running? Without one, nothing reads `~/.config/autostart`. */
export function hasDesktopSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.XDG_CURRENT_DESKTOP || env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** What is in place now: the entry file's contents, or the crontab's Deskfish line. Undefined when nothing is. */
export function readAutostart(plan: AutostartPlan): string | undefined {
  if (plan.kind === 'cron') {
    try {
      const out = execFileSync('crontab', ['-l'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return out.split('\n').find((l) => l.includes(CRON_MARK)) || undefined;
    } catch {
      return undefined;
    }
  }
  if (!plan.file) return undefined;
  try {
    return fs.readFileSync(plan.file, 'utf8');
  } catch {
    return undefined;
  }
}

/** What `readAutostart` should find when this plan is in place. */
export function expectedAutostart(plan: AutostartPlan): string {
  return plan.kind === 'cron' ? `@reboot ${plan.command} ${CRON_MARK}` : plan.contents ?? '';
}

/** True when the entry is missing or was written for another runtime, entry path, data dir or port. */
export function autostartNeedsWrite(plan: AutostartPlan): boolean {
  return readAutostart(plan) !== expectedAutostart(plan);
}

/**
 * Put the entry file in place. The visible terminal runs `plan.install` after this (it registers
 * the agent or the task, and shows what was written); the silent rewrite after an update calls
 * this alone, and re-runs `install` itself only where there is no file to rewrite (cron).
 */
export function writeAutostart(plan: AutostartPlan): void {
  if (!plan.file || plan.contents === undefined) return;
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.writeFileSync(plan.file, plan.contents, { mode: 0o644 });
}

/**
 * Put the entry in place without a terminal: the file, and where there is no file of ours (the
 * cron line) the command itself. Used by the silent rewrite when an update moved the extension.
 */
export function applyAutostart(plan: AutostartPlan): void {
  writeAutostart(plan);
  if (!plan.reapplyOnChange || !plan.installScript) return;
  execFileSync('sh', ['-c', plan.installScript], { timeout: 10_000, stdio: 'ignore' });
}

export function removeAutostart(plan: AutostartPlan): void {
  if (!plan.file) return;
  try {
    fs.rmSync(plan.file);
  } catch {
    /* not there */
  }
}
