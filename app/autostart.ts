import * as fs from 'node:fs';
import { autostartPlan, removeAutostart, writeAutostart, type AutostartPlan } from '../src/gateway/autostart';

/**
 * "Start when I log in", the tray's checkbox. macOS and Windows: the OS login item (Electron's
 * `app.setLoginItemSettings`, passed in as `api` so this module needs no Electron). Linux: an XDG
 * autostart file of the app's own, `deskfish-app.desktop` (the extension's "Keep running" entry is
 * `deskfish.desktop` and is rewritten on every VS Code start; the two never overwrite each other,
 * and both being on is safe: the data dir's lock lets one gateway own her, the other attaches).
 */

export interface LoginItemApi {
  getLoginItemSettings(options?: { args?: string[] }): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void;
}

export interface LoginItemOptions {
  platform: NodeJS.Platform;
  /** `process.execPath`: the app's binary (inside the AppImage's temporary mount when run from one). */
  execPath: string;
  env: NodeJS.ProcessEnv;
  home: string;
  api: LoginItemApi;
}

/** The binary a login entry should start: an AppImage's own file (its mount point changes every run), else the executable. */
export function appBinary(execPath: string, env: NodeJS.ProcessEnv): string {
  return env.APPIMAGE || execPath;
}

/** The app's Linux login entry: its binary with `--hidden` (it starts in the tray). */
export function linuxEntry(o: Pick<LoginItemOptions, 'execPath' | 'env' | 'home'>): AutostartPlan {
  return autostartPlan({ platform: 'linux', execPath: '', entry: '', dataDir: '', port: 0, home: o.home, argv: [appBinary(o.execPath, o.env), '--hidden'] });
}

const HIDDEN = ['--hidden'];

export class LoginItem {
  constructor(private readonly o: LoginItemOptions) {}

  isOn(): boolean {
    if (this.o.platform === 'linux') return fs.existsSync(linuxEntry(this.o).file!);
    return this.o.api.getLoginItemSettings(this.o.platform === 'win32' ? { args: HIDDEN } : undefined).openAtLogin;
  }

  /** Turn it on or off; answers where it lives, for the log. */
  set(on: boolean): string {
    if (this.o.platform === 'linux') {
      const plan = linuxEntry(this.o);
      if (on) writeAutostart(plan);
      else removeAutostart(plan);
      return plan.where;
    }
    // macOS has no arguments for a login item: the app sees `wasOpenedAtLogin` and starts hidden.
    this.o.api.setLoginItemSettings(this.o.platform === 'win32' ? { openAtLogin: on, args: HIDDEN } : { openAtLogin: on });
    return this.o.platform === 'win32' ? 'the Windows startup list' : 'Login Items in System Settings';
  }
}
