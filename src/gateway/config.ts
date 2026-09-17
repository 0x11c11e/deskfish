/** The settings the service runs on, as a plain object: VS Code settings today (`readConfig()`), a file under the gateway later. No `vscode` import. */

export type ProviderName = 'openai-compatible' | 'anthropic' | 'mock';
export type ContainerCli = 'auto' | 'docker' | 'podman';

export interface DeskfishConfig {
  provider: ProviderName;
  /** `free`: no Deskfish-imposed rules inside the tank (default). `guided`: the cautious rules. */
  autonomy: 'free' | 'guided';
  baseUrl: string;
  model: string;
  /** Anthropic workspace ID for identity-linked API keys (sent as the anthropic-workspace-id header). */
  anthropicWorkspaceId: string;
  maxSteps: number;
  /** Per-task cost budget in USD (0 = none). Only effective for models with a known list price. */
  maxCostUsd: number;
  /** Cost budget for a run nobody is watching (a schedule): in USD, 0 = none. A schedule may carry its own. */
  unattendedMaxCostUsd: number;
  /** Reflect after this many finished tasks (0 = manual only). */
  reflectEvery: number;
  /** The person in the chat, by name, so the agent never takes them for a third party ('' = not told). */
  userName: string;
  /** Every this many steps of a task the agent writes a ledger and the conversation restarts from it (0 = never). */
  ledgerEvery: number;
  /** Also write a ledger when the conversation passes this many tokens (0 = only by steps). */
  ledgerTokens: number;
  /** Anthropic prompt-cache TTL: 1h (default) or 5m. */
  cacheTtl: '5m' | '1h';
  /** Anthropic thinking effort per turn; '' = the provider's default. */
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** A scheduled task still fires this many minutes after its due moment if Deskfish only just started; later it is missed. */
  scheduleGraceMinutes: number;
  /** Cache breakpoints on OpenAI-compatible endpoints: auto (OpenRouter only), on, off. */
  promptCaching: 'auto' | 'on' | 'off';
  /** Sampling temperature for OpenAI-compatible endpoints; null = not sent (provider default). */
  temperature: number | null;
  screenshotWidth: number;
  settleMs: number;
  daemonUrl: string;
  /** Bearer token for the desktop daemon (DAEMON_TOKEN in the container). Empty = no auth. */
  daemonToken: string;
  vncUrl: string;
  vncPassword: string;
  composeFile: string;
  containerCli: ContainerCli;
  /** Xvfb geometry for the bot's screen, e.g. 1280x800x24. */
  screen: string;
  /** Turn the desktop on automatically when the Deskfish view opens. */
  autoStart: boolean;
  /** Open the Desktop tab (live view) whenever a task is submitted. */
  openDesktopOnRun: boolean;
}

/** The websocket URL the desktop pane should use, with the daemon token attached if configured. */
export function vncUrlWithToken(cfg: DeskfishConfig): string {
  if (!cfg.daemonToken) return cfg.vncUrl;
  try {
    const u = new URL(cfg.vncUrl);
    u.searchParams.set('token', cfg.daemonToken);
    return u.toString();
  } catch {
    return cfg.vncUrl;
  }
}

/** The defaults, as in package.json's `contributes.configuration`: what a gateway runs on before any client pushed settings. */
export const DEFAULT_CONFIG: DeskfishConfig = {
  provider: 'anthropic',
  autonomy: 'free',
  baseUrl: '',
  model: 'claude-opus-5',
  anthropicWorkspaceId: '',
  maxSteps: 0,
  maxCostUsd: 0,
  unattendedMaxCostUsd: 2,
  reflectEvery: 5,
  scheduleGraceMinutes: 5,
  ledgerEvery: 40,
  ledgerTokens: 100000,
  cacheTtl: '1h',
  effort: '',
  userName: '',
  promptCaching: 'auto',
  temperature: null,
  screenshotWidth: 1280,
  settleMs: 800,
  daemonUrl: 'http://localhost:9990',
  daemonToken: '',
  vncUrl: 'ws://localhost:9990/websockify',
  vncPassword: '',
  composeFile: '',
  containerCli: 'auto',
  screen: '1280x800x24',
  autoStart: true,
  openDesktopOnRun: true,
};

const ENUMS: Partial<Record<keyof DeskfishConfig, readonly string[]>> = {
  provider: ['anthropic', 'openai-compatible', 'mock'],
  autonomy: ['free', 'guided'],
  cacheTtl: ['1h', '5m'],
  effort: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  promptCaching: ['auto', 'on', 'off'],
  containerCli: ['auto', 'docker', 'podman'],
};

/** `cfg` with `patch` applied; throws on an unknown key or a value of the wrong type. */
export function applyConfigPatch(cfg: DeskfishConfig, patch: Record<string, unknown>): DeskfishConfig {
  const next: Record<string, unknown> = { ...cfg };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) throw new Error(`unknown setting: ${key}`);
    const k = key as keyof DeskfishConfig;
    const ok = k === 'temperature' ? value === null || (typeof value === 'number' && Number.isFinite(value)) : typeof value === typeof DEFAULT_CONFIG[k] && (typeof value !== 'number' || Number.isFinite(value));
    if (!ok || (ENUMS[k] && !ENUMS[k]!.includes(value as string))) throw new Error(`bad value for ${key}`);
    next[key] = value;
  }
  return next as unknown as DeskfishConfig;
}
