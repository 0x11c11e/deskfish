import type { ReplayItem } from '../agent/chats';
import type { AgentEvent, AgentStatus } from '../agent/loop';
import type { ComputerAction } from '../computer/types';
import type { DesktopStatus } from '../desktop/supervisor';
import type { CommandName, EditableFile } from '../gateway/protocol';

/** Messages between the extension host and its two webviews. Shared so both sides stay in sync. */

export interface UiConfig {
  provider: string;
  model: string;
  baseUrl: string;
  daemonUrl: string;
  vncUrl: string;
  hasApiKey: boolean;
  /** Step limit per task (for the "step 12 of 60" counter). */
  maxSteps: number;
  desktop: DesktopStatus;
  /** How the key row describes a stored key; "Stored in your keychain" when absent (VS Code). */
  keyStored?: string;
}

/** The panels inside the chat view; host chrome (VS Code's commands, the page's title bar) only opens them. */
export type PanelName = 'history' | 'settings' | 'schedules' | 'files';

/** A file on the bot's desktop (inside /home/bot). */
export interface DesktopFile {
  name: string;
  /** Absolute path on the desktop, e.g. /home/bot/Downloads/report.pdf */
  path: string;
  size: number;
}

// extension → chat webview
export type ToChat =
  | { type: 'config'; config: UiConfig }
  | { type: 'desktop'; status: DesktopStatus }
  | { type: 'event'; event: AgentEvent }
  | { type: 'user'; text: string }
  /** A line from Deskfish itself (not the bot): a missed schedule, for instance. */
  | { type: 'notice'; text: string }
  /** A past chat rendered into the sidebar (after newChat), read-only until the user types. `live`: the current chat, rebuilt after (re)connecting to the gateway; no "past chat" line. */
  | { type: 'replay'; title: string; items: ReplayItem[]; live?: boolean }
  /** Files the user picked were copied to the desktop's Uploads folder; show them in the composer. */
  | { type: 'attached'; files: DesktopFile[] }
  /** A new file appeared in the desktop's Downloads folder. */
  | { type: 'download'; file: DesktopFile }
  /** Result of saveFile. */
  /** The user started a new chat: wipe the log; the model's conversation is already gone. */
  | { type: 'newChat' }
  | { type: 'saved'; path: string; hostPath: string }
  | { type: 'saveFailed'; path: string; error: string }
  /** The gateway's answer to the view's `ask` (a command outside `VIEW_COMMANDS` is answered `ok: false` without reaching it). */
  | { type: 'answer'; id: number; ok: true; result: unknown }
  | { type: 'answer'; id: number; ok: false; error: string }
  /** Host chrome asked for a panel. */
  | { type: 'open'; panel: PanelName };

// chat webview → extension
export type FromChat =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'run'; task: string; attachments?: DesktopFile[] }
  | { type: 'say'; text: string; attachments?: DesktopFile[] }
  | { type: 'stop' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'openDesktop' }
  | { type: 'setApiKey' }
  | { type: 'openSettings' }
  | { type: 'startDesktop' }
  | { type: 'stopDesktop' }
  /** Turn the desktop off and on again (a running task is stopped first). */
  | { type: 'restartDesktop' }
  | { type: 'showLog' }
  /** Open the documentation site in the browser. */
  | { type: 'openDocs' }
  /** Open a terminal with the Podman install command for this OS. */
  | { type: 'installRuntime' }
  /** Open a file picker and copy the chosen files to the desktop. */
  | { type: 'attach' }
  /** Copy a desktop file to the user's computer (save dialog). */
  | { type: 'saveFile'; file: DesktopFile }
  /** Show a saved file in the OS file manager. */
  | { type: 'revealFile'; hostPath: string }
  /** Put a message's text on the user's clipboard (the host clipboard is reliable; the webview one is not). */
  | { type: 'copy'; text: string }
  /** A gateway command for the view's panels; the host forwards it when `VIEW_COMMANDS` names it and posts the `answer`. */
  | { type: 'ask'; id: number; cmd: CommandName; args?: Record<string, unknown> }
  /** VS Code only: open memory.md or charter.md in a real editor. */
  | { type: 'openFile'; file: EditableFile };

// extension → desktop webview
export type ToDesktop =
  | { type: 'connect'; url: string; password?: string }
  | { type: 'screenshot'; dataUrl: string; width: number; height: number }
  | { type: 'agentStatus'; status: AgentStatus; message?: string; screenFree?: boolean }
  /** One action she took, in native display pixels, for the live view's drawn pointer. */
  | { type: 'agentAction'; action: ComputerAction }
  | { type: 'desktop'; status: DesktopStatus }
  /** Reply to clipboardSync: the desktop clipboard now matches the host (or not); `paste` echoes the request. */
  | { type: 'clipboardSynced'; ok: boolean; paste: boolean };

// desktop webview → extension
export type FromDesktop =
  | { type: 'ready' }
  | { type: 'takeover' }
  | { type: 'handback' }
  | { type: 'startDesktop' }
  /** Ask the daemon to release all buttons/modifiers (a release event may have been lost). */
  | { type: 'releaseInput' }
  /** Push the host clipboard into the desktop; with `paste`, the pane sends Ctrl+V once that's done. */
  | { type: 'clipboardSync'; paste: boolean }
  /** The desktop's selection changed (VNC event); `text` is VNC's copy, the extension fetches the exact one. */
  | { type: 'clipboardChanged'; text: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
