import * as vscode from 'vscode';
import type { ContainerCli, DeskfishConfig, ProviderName } from './gateway/config';

export type { ContainerCli, DeskfishConfig, ProviderName } from './gateway/config';
export { vncUrlWithToken } from './gateway/config';

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
