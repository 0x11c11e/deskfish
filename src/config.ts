import * as vscode from 'vscode';
import { DEFAULT_CONFIG as D, type ContainerCli, type DeskfishConfig, type ProviderName } from './gateway/config';

export type { ContainerCli, DeskfishConfig, ProviderName } from './gateway/config';
export { vncUrlWithToken } from './gateway/config';

/** Key under which the LLM API key is kept in VS Code's SecretStorage (OS keychain). */
export const API_KEY_SECRET = 'deskfish.apiKey';

export function readConfig(): DeskfishConfig {
  const c = vscode.workspace.getConfiguration('deskfish');
  return {
    provider: c.get<ProviderName>('provider', D.provider),
    autonomy: c.get<'free' | 'guided'>('autonomy', D.autonomy),
    baseUrl: c.get<string>('baseUrl', D.baseUrl),
    model: c.get<string>('model', D.model),
    anthropicWorkspaceId: c.get<string>('anthropicWorkspaceId', D.anthropicWorkspaceId).trim(),
    maxSteps: c.get<number>('maxSteps', D.maxSteps),
    maxCostUsd: c.get<number>('maxCostUsd', D.maxCostUsd),
    reflectEvery: c.get<number>('reflectEvery', D.reflectEvery),
    scheduleGraceMinutes: c.get<number>('scheduleGraceMinutes', D.scheduleGraceMinutes),
    ledgerEvery: c.get<number>('ledgerEvery', D.ledgerEvery),
    ledgerTokens: c.get<number>('ledgerTokens', D.ledgerTokens),
    cacheTtl: c.get<'5m' | '1h'>('cacheTtl', D.cacheTtl),
    effort: c.get<'' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>('effort', D.effort),
    userName: c.get<string>('userName', D.userName).trim(),
    promptCaching: c.get<'auto' | 'on' | 'off'>('promptCaching', D.promptCaching),
    temperature: c.get<number | null>('temperature', D.temperature),
    screenshotWidth: c.get<number>('screenshotWidth', D.screenshotWidth),
    settleMs: c.get<number>('settleMs', D.settleMs),
    daemonUrl: c.get<string>('desktop.daemonUrl', D.daemonUrl),
    daemonToken: c.get<string>('desktop.token', D.daemonToken),
    vncUrl: c.get<string>('desktop.vncUrl', D.vncUrl),
    vncPassword: c.get<string>('desktop.vncPassword', D.vncPassword),
    composeFile: c.get<string>('desktop.composeFile', D.composeFile),
    containerCli: c.get<ContainerCli>('desktop.containerCli', D.containerCli),
    screen: c.get<string>('desktop.screen', D.screen),
    autoStart: c.get<boolean>('desktop.autoStart', D.autoStart),
    openDesktopOnRun: c.get<boolean>('desktop.openOnRun', D.openDesktopOnRun),
  };
}
