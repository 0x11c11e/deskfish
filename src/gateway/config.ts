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
