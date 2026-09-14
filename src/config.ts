import * as vscode from 'vscode';

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

/** Key under which the LLM API key is kept in VS Code's SecretStorage (OS keychain). */
export const API_KEY_SECRET = 'deskfish.apiKey';

export function readConfig(): DeskfishConfig {
  const c = vscode.workspace.getConfiguration('deskfish');
  return {
    provider: c.get<ProviderName>('provider', 'anthropic'),
    autonomy: c.get<'free' | 'guided'>('autonomy', 'free'),
    baseUrl: c.get<string>('baseUrl', ''),
    model: c.get<string>('model', 'claude-opus-5'),
    anthropicWorkspaceId: c.get<string>('anthropicWorkspaceId', '').trim(),
    maxSteps: c.get<number>('maxSteps', 0),
    maxCostUsd: c.get<number>('maxCostUsd', 0),
    reflectEvery: c.get<number>('reflectEvery', 5),
    scheduleGraceMinutes: c.get<number>('scheduleGraceMinutes', 5),
    ledgerEvery: c.get<number>('ledgerEvery', 40),
    ledgerTokens: c.get<number>('ledgerTokens', 100000),
    cacheTtl: c.get<'5m' | '1h'>('cacheTtl', '1h'),
    effort: c.get<'' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>('effort', ''),
    userName: c.get<string>('userName', '').trim(),
    promptCaching: c.get<'auto' | 'on' | 'off'>('promptCaching', 'auto'),
    temperature: c.get<number | null>('temperature', null),
    screenshotWidth: c.get<number>('screenshotWidth', 1280),
    settleMs: c.get<number>('settleMs', 800),
    daemonUrl: c.get<string>('desktop.daemonUrl', 'http://localhost:9990'),
    daemonToken: c.get<string>('desktop.token', ''),
    vncUrl: c.get<string>('desktop.vncUrl', 'ws://localhost:9990/websockify'),
    vncPassword: c.get<string>('desktop.vncPassword', ''),
    composeFile: c.get<string>('desktop.composeFile', ''),
    containerCli: c.get<ContainerCli>('desktop.containerCli', 'auto'),
    screen: c.get<string>('desktop.screen', '1280x800x24'),
    autoStart: c.get<boolean>('desktop.autoStart', true),
    openDesktopOnRun: c.get<boolean>('desktop.openOnRun', true),
  };
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
