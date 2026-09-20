import type { DeskfishConfig } from './config';

/**
 * The settings as a client renders them: which VS Code setting holds each config key, and the
 * schema of the web page's Settings dialog, derived from `package.json`'s
 * `contributes.configuration` (the same type, enum, default and words VS Code shows). The gateway
 * reads its own `package.json` once and answers `config.schema`. `deskfish.gateway.*` are VS Code's
 * alone (where the gateway is) and never appear here. Pure: no `vscode`, no `fs` (the page bundles it).
 */

/** Each config key's VS Code setting. Nine live under `desktop.`, two of them under another name. */
export const SETTINGS_KEYS: Record<keyof DeskfishConfig, string> = {
  provider: 'deskfish.provider',
  model: 'deskfish.model',
  baseUrl: 'deskfish.baseUrl',
  auth: 'deskfish.auth',
  autonomy: 'deskfish.autonomy',
  maxSteps: 'deskfish.maxSteps',
  maxCostUsd: 'deskfish.maxCostUsd',
  unattendedMaxCostUsd: 'deskfish.unattendedMaxCostUsd',
  effort: 'deskfish.effort',
  reflectEvery: 'deskfish.reflectEvery',
  userName: 'deskfish.userName',
  containerCli: 'deskfish.desktop.containerCli',
  screen: 'deskfish.desktop.screen',
  autoStart: 'deskfish.desktop.autoStart',
  openDesktopOnRun: 'deskfish.desktop.openOnRun',
  screenshotWidth: 'deskfish.screenshotWidth',
  settleMs: 'deskfish.settleMs',
  vncPassword: 'deskfish.desktop.vncPassword',
  daemonUrl: 'deskfish.desktop.daemonUrl',
  daemonToken: 'deskfish.desktop.token',
  vncUrl: 'deskfish.desktop.vncUrl',
  composeFile: 'deskfish.desktop.composeFile',
  anthropicWorkspaceId: 'deskfish.anthropicWorkspaceId',
  temperature: 'deskfish.temperature',
  promptCaching: 'deskfish.promptCaching',
  cacheTtl: 'deskfish.cacheTtl',
  ledgerEvery: 'deskfish.ledgerEvery',
  ledgerTokens: 'deskfish.ledgerTokens',
  scheduleGraceMinutes: 'deskfish.scheduleGraceMinutes',
};

/** Every config key, in the order the dialog shows them. */
export const CONFIG_KEYS = Object.keys(SETTINGS_KEYS) as (keyof DeskfishConfig)[];

/** `model`: listed, not rendered (the model dialog owns provider, model and base URL). `advanced` is folded. */
export type SettingsGroup = 'model' | 'work' | 'desktop' | 'advanced';

const GROUPS: [SettingsGroup, (keyof DeskfishConfig)[]][] = [
  ['model', ['provider', 'model', 'baseUrl', 'auth']],
  ['work', ['autonomy', 'maxSteps', 'maxCostUsd', 'unattendedMaxCostUsd', 'effort', 'reflectEvery', 'userName']],
  ['desktop', ['containerCli', 'screen', 'autoStart', 'openDesktopOnRun', 'screenshotWidth', 'settleMs', 'vncPassword']],
  ['advanced', ['daemonUrl', 'daemonToken', 'vncUrl', 'composeFile', 'anthropicWorkspaceId', 'temperature', 'promptCaching', 'cacheTtl', 'ledgerEvery', 'ledgerTokens', 'scheduleGraceMinutes']],
];

export const GROUP_TITLES: Record<Exclude<SettingsGroup, 'model'>, string> = { work: 'How she works', desktop: 'Her desktop', advanced: 'Advanced' };

export interface SettingsEntry {
  key: keyof DeskfishConfig;
  /** The VS Code setting, e.g. `deskfish.desktop.openOnRun`. */
  setting: string;
  type: 'string' | 'number' | 'boolean';
  /** `null` is a value too (temperature: not sent). */
  nullable?: boolean;
  enum?: string[];
  enumDescriptions?: string[];
  default: string | number | boolean | null;
  description: string;
  minimum?: number;
  maximum?: number;
  group: SettingsGroup;
}

export type SettingsSchema = SettingsEntry[];

interface PackageProperty {
  type?: string | string[];
  enum?: string[];
  enumDescriptions?: string[];
  markdownEnumDescriptions?: string[];
  default?: string | number | boolean | null;
  description?: string;
  markdownDescription?: string;
  minimum?: number;
  maximum?: number;
}

/** The dialog's schema from a parsed `package.json`, in group order. A key the file does not describe is left out. */
export function settingsSchema(pkg: unknown): SettingsSchema {
  const props = ((pkg as { contributes?: { configuration?: { properties?: Record<string, PackageProperty> } } })?.contributes?.configuration?.properties ?? {}) as Record<string, PackageProperty>;
  const out: SettingsSchema = [];
  for (const [group, keys] of GROUPS) {
    for (const key of keys) {
      const setting = SETTINGS_KEYS[key];
      const p = props[setting];
      if (!p) continue;
      const types = Array.isArray(p.type) ? p.type : [p.type];
      const type = types.find((t) => t !== 'null') as SettingsEntry['type'];
      const entry: SettingsEntry = { key, setting, type, default: p.default ?? null, description: p.description ?? p.markdownDescription ?? '', group };
      if (types.includes('null')) entry.nullable = true;
      if (p.enum) entry.enum = p.enum;
      const enumDescriptions = p.enumDescriptions ?? p.markdownEnumDescriptions;
      if (enumDescriptions) entry.enumDescriptions = enumDescriptions;
      if (p.minimum !== undefined) entry.minimum = p.minimum;
      if (p.maximum !== undefined) entry.maximum = p.maximum;
      out.push(entry);
    }
  }
  return out;
}

/** The label VS Code's settings editor shows for a setting: `deskfish.desktop.openOnRun` → "Desktop: Open On Run". */
export function settingLabel(setting: string): string {
  const parts = setting.replace(/^deskfish\./, '').split('.');
  const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  const last = words(parts.pop() ?? '');
  return parts.length ? `${parts.map(words).join(' › ')}: ${last}` : last;
}
