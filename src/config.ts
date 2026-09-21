import * as vscode from 'vscode';
import { DEFAULT_CONFIG as D, type DeskfishConfig } from './gateway/config';
import { CONFIG_KEYS, SETTINGS_KEYS } from './gateway/settingsSchema';

export type { ContainerCli, DeskfishConfig, ProviderName } from './gateway/config';
export { vncUrlWithToken } from './gateway/config';

/** Key under which the LLM API key is kept in VS Code's SecretStorage (OS keychain). */
export const API_KEY_SECRET = 'deskfish.apiKey';

/** Trimmed on read: a pasted name or workspace ID often carries a space. */
const TRIMMED = new Set<keyof DeskfishConfig>(['anthropicWorkspaceId', 'userName', 'remoteRelay', 'remoteUsername']);

/**
 * VS Code's Deskfish settings as a config (the table in `settingsSchema.ts` names each setting).
 * `effective`: what VS Code resolves (workspace over user); `user`: the user (Global) settings only,
 * which is what the gateway's config is mirrored into (`configSync.ts`).
 */
export function readConfig(scope: 'effective' | 'user' = 'effective'): DeskfishConfig {
  const c = vscode.workspace.getConfiguration('deskfish');
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const name = SETTINGS_KEYS[key].slice('deskfish.'.length);
    let v: unknown = scope === 'user' ? (c.inspect(name)?.globalValue ?? D[key]) : c.get(name, D[key]);
    if (TRIMMED.has(key) && typeof v === 'string') v = v.trim();
    out[key] = v;
  }
  return out as unknown as DeskfishConfig;
}
