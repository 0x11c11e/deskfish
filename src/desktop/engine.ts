import { spawn } from 'node:child_process';
import { exec, onPath, portOf, probeDesktop, resolveContainerCli, type ContainerCli, type ContainerCliPreference } from './cli';
import { RECIPE_LABEL, recipeHash } from './recipe';

/**
 * Builds, starts, stops and health-checks the bot's desktop container with plain `podman`/`docker`
 * commands — no compose provider, no scripts. Pure Node (no `vscode` import) so it can be driven
 * headlessly; `DesktopManager` wraps it with VS Code UI.
 */

export const DESKTOP_IMAGE = 'localhost/deskfish-desktop:latest';
export const DESKTOP_CONTAINER = 'deskfish-desktop';
export const DESKTOP_VOLUME = 'deskfish-home';

export interface EngineConfig {
  /** Directory containing the Dockerfile (docker/desktop in the extension). */
  buildContext: string;
  cli: ContainerCliPreference;
  daemonUrl: string;
  daemonToken: string;
  vncPassword: string;
  screen: string;
}

export interface EngineLog {
  info(line: string): void;
  /** Coarse progress for the UI ("Building the image…"). */
  progress(message: string): void;
}

export class DesktopEngine {
  constructor(
    private readonly cfg: EngineConfig,
    private readonly log: EngineLog,
  ) {}

  async resolveCli(): Promise<ContainerCli> {
    const cli = await resolveContainerCli(this.cfg.cli);
    if (!cli) throw new Error('no container engine found — install Podman or Docker and try again');
    return cli;
  }

  isHealthy(timeoutMs = 1500): Promise<boolean> {
    return probeDesktop(this.cfg.daemonUrl, this.cfg.daemonToken, timeoutMs);
  }

  async imageExists(cli: ContainerCli): Promise<boolean> {
    return exec(cli, ['image', 'inspect', DESKTOP_IMAGE], { timeoutMs: 15_000 }).then(() => true, () => false);
  }

  /**
   * 'missing' | 'stale' | 'current': stale when the image was built from a different recipe than
   * the one shipped with this extension (its label differs, or it has none — images built before
   * labels existed). A stale image is rebuilt at the next start; the home volume is untouched.
   */
  async imageState(cli: ContainerCli): Promise<'missing' | 'stale' | 'current'> {
    const r = await exec(cli, ['image', 'inspect', '--format', `{{index .Config.Labels "${RECIPE_LABEL}"}}`, DESKTOP_IMAGE], { timeoutMs: 15_000 }).catch(() => undefined);
    if (!r) return 'missing';
    let wanted: string;
    try {
      wanted = recipeHash(this.cfg.buildContext);
    } catch (err) {
      this.log.info(`could not fingerprint the tank recipe (${err instanceof Error ? err.message : String(err)}); keeping the existing image`);
      return 'current';
    }
    return r.stdout.trim() === wanted ? 'current' : 'stale';
  }

  /**
   * Streams build output to the log. Progress says what the build is doing and how long it takes:
   * the prefix first ("… — a few minutes the first time"), then "<prefix> — step X of Y" on every
   * STEP line, and inside a step what apt is doing (the one long step, the package install, runs for
   * minutes and would otherwise look stuck). At most one progress call per second; STEP lines at once.
   */
  build(cli: ContainerCli, verb: 'Building' | 'Updating' = 'Building'): Promise<void> {
    let label: string[] = [];
    try {
      label = ['--label', `${RECIPE_LABEL}=${recipeHash(this.cfg.buildContext)}`];
    } catch {
      // unlabelled image: rebuilt at every start until the recipe can be read — better than never
    }
    const prefix = verb === 'Updating' ? 'Updating the desktop image after the update — a few minutes' : 'Building the desktop image — a few minutes the first time';
    let base = prefix;
    let shown = '';
    let shownAt = 0;
    let pending: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const emit = (message: string) => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      if (message === shown) return;
      shown = message;
      shownAt = Date.now();
      this.log.progress(message);
    };
    const offer = (message: string) => {
      const wait = shownAt + 1000 - Date.now();
      if (wait <= 0) return emit(message);
      pending = message;
      timer ??= setTimeout(() => pending !== undefined && emit(pending), wait);
    };
    emit(prefix);
    this.log.info(`${cli} build ${label.join(' ')} -t ${DESKTOP_IMAGE} ${this.cfg.buildContext}`);
    return new Promise((resolve, reject) => {
      const child = spawn(cli, ['build', ...label, '-t', DESKTOP_IMAGE, this.cfg.buildContext], { stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      const onData = (chunk: Buffer) => {
        for (const raw of chunk.toString().split(/\r?\n/)) {
          const line = raw.trim();
          if (!line) continue;
          tail = line;
          this.log.info(`  ${line}`);
          // podman/buildah and the classic builder print "STEP 3/24: …"; BuildKit "#7 [3/24] RUN …"
          // and prefixes a command's output with "#7 12.3 ".
          const step = line.match(/^(?:STEP|Step)\s+(\d+)\/(\d+)/i) ?? line.match(/^#\d+ \[(?:[^\]\s]+ )?(\d+)\/(\d+)\]/);
          if (step) {
            base = `${prefix} — step ${step[1]} of ${step[2]}`;
            emit(base);
            continue;
          }
          const output = line.replace(/^#\d+ \d+(?:\.\d+)? /, '');
          const get = output.match(/^Get:(\d+) /);
          if (get) offer(`${base} · downloading packages (${get[1]})`);
          else if (/^Unpacking /.test(output)) offer(`${base} · unpacking packages`);
          else if (/^Setting up /.test(output)) offer(`${base} · setting up packages`);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const done = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      };
      child.on('error', (err) => { done(); reject(err); });
      child.on('close', (code) => { done(); if (code === 0) resolve(); else reject(new Error(`image build failed (exit ${code}): ${tail}`)); });
    });
  }

  /** How the last start networked the tank: its own namespace, or the host's (the rootless-without-passt fallback). */
  networkMode: 'isolated' | 'host' = 'isolated';

  /** The running container's actual network mode, for a tank started before this session. */
  async inspectNetworkMode(): Promise<'isolated' | 'host' | undefined> {
    try {
      const cli = await this.resolveCli();
      const r = await exec(cli, ['inspect', '--format', '{{.HostConfig.NetworkMode}}', DESKTOP_CONTAINER], { timeoutMs: 10_000 });
      const mode = r.stdout.trim();
      if (!mode) return undefined;
      return mode === 'host' ? 'host' : 'isolated';
    } catch {
      return undefined;
    }
  }

  /** Rootless Podman without pasta/slirp4netns cannot publish ports → host network bound to 127.0.0.1. */
  private async networkArgs(cli: ContainerCli, port: number): Promise<string[]> {
    if (cli === 'podman' && process.platform === 'linux') {
      const [pasta, slirp] = await Promise.all([onPath('pasta'), onPath('slirp4netns')]);
      if (!pasta && !slirp) {
        this.log.info('podman: neither pasta nor slirp4netns is installed — using --network host bound to 127.0.0.1 (install the "passt" package for normal port publishing)');
        this.networkMode = 'host';
        return ['--network', 'host', '-e', 'DAEMON_BIND=127.0.0.1', '-e', `DAEMON_PORT=${port}`];
      }
    }
    this.networkMode = 'isolated';
    return ['-p', `127.0.0.1:${port}:9990`];
  }

  async run(cli: ContainerCli): Promise<void> {
    await exec(cli, ['rm', '-f', DESKTOP_CONTAINER]).catch(() => undefined);
    const port = portOf(this.cfg.daemonUrl);
    const args = [
      'run', '-d',
      '--name', DESKTOP_CONTAINER,
      '--hostname', 'computer',
      '--shm-size', '1g',
      ...(await this.networkArgs(cli, port)),
      '-e', `SCREEN=${this.cfg.screen}`,
      '-e', `DAEMON_TOKEN=${this.cfg.daemonToken}`,
      '-e', `VNC_PASSWORD=${this.cfg.vncPassword}`,
      '-v', `${DESKTOP_VOLUME}:/home/bot`,
      DESKTOP_IMAGE,
    ];
    this.log.info(`${cli} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
    await exec(cli, args, { timeoutMs: 60_000 });
  }

  async waitHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy(1500)) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  async containerLogs(cli: ContainerCli, lines = 30): Promise<string> {
    return exec(cli, ['logs', '--tail', String(lines), DESKTOP_CONTAINER], { timeoutMs: 10_000 }).then((r) => (r.stdout + r.stderr).trim(), () => '');
  }

  /** The whole "turn on" sequence. Returns when the daemon answers. */
  async start(): Promise<void> {
    const cli = await this.resolveCli();
    const state = await this.imageState(cli);
    if (state === 'missing') {
      await this.build(cli);
    } else if (state === 'stale') {
      // The extension was updated with a new tank recipe: rebuild (cached layers make it quick).
      await this.build(cli, 'Updating');
    }
    this.log.progress('Starting the desktop container…');
    await this.run(cli);
    this.log.progress('Waiting for the desktop to come up…');
    if (!(await this.waitHealthy(90_000))) {
      const logs = await this.containerLogs(cli);
      throw new Error(`the desktop did not come up within 90 s${logs ? `\n${logs}` : ''}`);
    }
  }

  /** Stop gracefully (Firefox saves its session/logins), then remove the container. */
  async stop(): Promise<void> {
    const cli = await this.resolveCli();
    this.log.info(`${cli} stop -t 15 ${DESKTOP_CONTAINER}`);
    await exec(cli, ['stop', '-t', '15', DESKTOP_CONTAINER], { timeoutMs: 40_000 }).catch(() => undefined);
    await exec(cli, ['rm', '-f', DESKTOP_CONTAINER], { timeoutMs: 30_000 }).catch(() => undefined);
  }
}
