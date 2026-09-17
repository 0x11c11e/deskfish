import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import type { DesktopState } from '../src/desktop/supervisor';

/**
 * The tray icon and its menu: Open Deskfish · the desktop's state and its on/off · Start when I log
 * in · Quit. The menu is rebuilt whenever something it shows changes (Linux trays cannot update a
 * shown menu in place).
 */

export interface TrayState {
  /** Undefined while no gateway answers. */
  desktop?: DesktopState;
  loginItem: boolean;
  knocking: boolean;
}

export interface TrayActions {
  open(): void;
  desktop(on: boolean): void;
  loginItem(on: boolean): void;
  quit(): void;
}

const DESKTOP_WORDS: Record<DesktopState, string> = {
  unknown: 'Desktop: checking…',
  off: 'Desktop: off',
  starting: 'Desktop: starting…',
  on: 'Desktop: on',
  stopping: 'Desktop: stopping…',
  error: 'Desktop: could not start',
};

export class AppTray {
  private readonly tray: Tray;
  private state: TrayState = { loginItem: false, knocking: false };

  constructor(iconPath: string, private readonly actions: TrayActions) {
    let image = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') image = image.resize({ width: 18, height: 18 });
    this.tray = new Tray(image);
    this.tray.setToolTip('Deskfish');
    // Windows and some Linux trays: a click opens the window (macOS and AppIndicator show the menu).
    this.tray.on('click', () => actions.open());
    this.render();
  }

  update(patch: Partial<TrayState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  private render(): void {
    const s = this.state;
    const desktop = s.desktop;
    const items: MenuItemConstructorOptions[] = [
      { label: s.knocking ? '✋ Deskfish needs you — Open' : 'Open Deskfish', click: () => this.actions.open() },
      { type: 'separator' },
      { label: desktop ? DESKTOP_WORDS[desktop] : 'Desktop: waiting for Deskfish…', enabled: false },
      desktop === 'on' || desktop === 'starting'
        ? { label: 'Turn the desktop off', enabled: desktop === 'on', click: () => this.actions.desktop(false) }
        : { label: 'Turn the desktop on', enabled: desktop === 'off' || desktop === 'error' || desktop === 'unknown', click: () => this.actions.desktop(true) },
      { type: 'separator' },
      { label: 'Start when I log in', type: 'checkbox', checked: s.loginItem, click: (item) => this.actions.loginItem(item.checked) },
      { type: 'separator' },
      { label: 'Quit Deskfish', click: () => this.actions.quit() },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
    this.tray.setToolTip(s.knocking ? 'Deskfish needs you' : 'Deskfish');
  }

  destroy(): void {
    this.tray.destroy();
  }
}
