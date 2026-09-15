import { EventEmitter } from 'node:events';
import type { DeskfishConfig } from '../gateway/config';
import { DesktopEngine, type EngineConfig, type EngineLog } from './engine';
import { detectRuntime, type RuntimeStatus } from './runtime';

/**
 * Owner of the desktop, without VS Code: keeps a state machine the UI can render (off / starting /
 * on / stopping / error), runs the engine, and polls the daemon so the state stays truthful even if
 * the container was started or stopped elsewhere. `DesktopManager` adds the VS Code parts on top
 * (progress notification, error popups, the passt warning, the visible install terminal).
 *
 * Events: `change` (DesktopStatus, only on real changes), `hostNetwork` (the running tank shares the
 * host's network; fired after a start and on the first look at a tank that was already running),
 * `startFailed` / `stopFailed` (the first line of the error).
 */

export type DesktopState = 'unknown' | 'off' | 'starting' | 'on' | 'stopping' | 'error';

export interface DesktopStatus {
  state: DesktopState;
  message?: string;
  /** Which container engine is available; `none` carries an install plan for the UI. */
  runtime?: RuntimeStatus;
}

/** The part of `DesktopEngine` the supervisor uses; tests pass a fake. */
export type EngineLike = Pick<DesktopEngine, 'isHealthy' | 'start' | 'stop' | 'inspectNetworkMode' | 'networkMode'>;

export interface SupervisorOptions {
  /** Directory containing the Dockerfile (docker/desktop in the extension). */
  buildContext: string;
  /** Read fresh for every engine: settings can change between a stop and a start. */
  config: () => Pick<DeskfishConfig, 'containerCli' | 'daemonUrl' | 'daemonToken' | 'vncPassword' | 'screen'>;
  log: (line: string) => void;
  /** Tests replace the engine (no podman on the test path). */
  createEngine?: (cfg: EngineConfig, log: EngineLog) => EngineLike;
}

export class DesktopSupervisor extends EventEmitter {
  private status: DesktopStatus = { state: 'unknown' };
  private busy?: Promise<void>;
  private poll?: NodeJS.Timeout;
  private runtimeStatus?: RuntimeStatus;

  constructor(private readonly opts: SupervisorOptions) {
    super();
  }

  get current(): DesktopStatus {
    return this.status;
  }

  get runtime(): RuntimeStatus | undefined {
    return this.runtimeStatus;
  }

  private engine(): EngineLike {
    const cfg = this.opts.config();
    const engineCfg: EngineConfig = {
      buildContext: this.opts.buildContext,
      cli: cfg.containerCli,
      daemonUrl: cfg.daemonUrl,
      daemonToken: cfg.daemonToken,
      vncPassword: cfg.vncPassword,
      screen: cfg.screen,
    };
    const log: EngineLog = {
      info: (line) => this.opts.log(line),
      progress: (message) => this.set({ state: 'starting', message }),
    };
    return this.opts.createEngine ? this.opts.createEngine(engineCfg, log) : new DesktopEngine(engineCfg, log);
  }

  /** Probe the daemon. If it answers we are "on", however it was started. */
  async refresh(): Promise<DesktopStatus> {
    if (this.busy) return this.status;
    const healthy = await this.engine().isHealthy();
    if (healthy) {
      this.set({ state: 'on' });
      this.lookupNetworkMode();
      return this.status;
    }
    await this.detectRuntime();
    if (this.status.state !== 'error') this.set({ state: 'off' });
    return this.status;
  }

  get runtimeMissing(): boolean {
    return this.runtimeStatus?.cli === 'none';
  }

  /** podman/docker present? Cheap (`--version` calls); emits a status change when the answer changes. */
  async detectRuntime(): Promise<RuntimeStatus> {
    this.runtimeStatus = await detectRuntime(this.opts.config().containerCli);
    this.set({ ...this.status });
    return this.runtimeStatus;
  }

  /** How the running tank is networked: known after a start in this session, or looked up once for a tank that was already running. */
  private lastNetworkMode?: 'isolated' | 'host';
  private lookingUpNetworkMode = false;

  get networkMode(): 'isolated' | 'host' | undefined {
    return this.lastNetworkMode;
  }

  private lookupNetworkMode(): void {
    if (this.lastNetworkMode !== undefined || this.lookingUpNetworkMode) return;
    this.lookingUpNetworkMode = true;
    void this.engine()
      .inspectNetworkMode()
      .then((mode) => {
        if (mode) {
          this.lastNetworkMode = mode;
          if (mode === 'host') this.emit('hostNetwork');
        }
      })
      .finally(() => (this.lookingUpNetworkMode = false));
  }

  startPolling(intervalMs = 15_000): void {
    this.stopPolling();
    this.poll = setInterval(() => void this.refresh(), intervalMs);
  }

  stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  /** Turn on if needed. Resolves true when the desktop is usable. */
  async ensureOn(): Promise<boolean> {
    if ((await this.refresh()).state === 'on') return true;
    return this.start();
  }

  async start(): Promise<boolean> {
    if (this.busy) {
      await this.busy;
      return this.status.state === 'on';
    }
    this.busy = this.doStart();
    try {
      await this.busy;
    } finally {
      this.busy = undefined;
    }
    return this.status.state === 'on';
  }

  private async doStart(): Promise<void> {
    const engine = this.engine();
    if ((await this.detectRuntime()).cli === 'none') {
      // The sidebar shows the install card; no error notification needed on top.
      this.opts.log('✖ no container engine (podman/docker) found');
      this.set({ state: 'off', message: 'Podman (or Docker) is not installed yet' });
      return;
    }
    this.set({ state: 'starting', message: 'Turning on the desktop…' });
    this.opts.log('▶ turning on the desktop');
    try {
      await engine.start();
      this.set({ state: 'on' });
      this.opts.log('● desktop is on');
      this.lastNetworkMode = engine.networkMode;
      if (engine.networkMode === 'host') this.emit('hostNetwork');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log(`✖ desktop start failed: ${message}`);
      this.set({ state: 'error', message: message.split('\n')[0] });
      this.emit('startFailed', message.split('\n')[0]);
    }
  }

  async stop(): Promise<void> {
    if (this.busy) await this.busy;
    this.lastNetworkMode = undefined;
    this.set({ state: 'stopping', message: 'Turning off the desktop…' });
    this.opts.log('■ turning off the desktop');
    try {
      await this.engine().stop();
      this.set({ state: 'off' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.set({ state: 'error', message });
      this.emit('stopFailed', message);
    }
  }

  async toggle(): Promise<void> {
    const s = (await this.refresh()).state;
    if (s === 'on') await this.stop();
    else if (s === 'off' || s === 'error' || s === 'unknown') await this.start();
  }

  /** Emits only on real changes — listeners reconnect/re-render on events, so no noise. */
  private set(status: DesktopStatus): void {
    const next: DesktopStatus = { ...status, runtime: this.runtimeStatus };
    if (this.status.state === next.state && this.status.message === next.message && this.status.runtime?.cli === next.runtime?.cli) return;
    this.status = next;
    this.emit('change', next);
  }

  dispose(): void {
    this.stopPolling();
    this.removeAllListeners();
  }
}
