/**
 * Headless check of the exact code path the sidebar's power button uses:
 * stop → start (build if the image is missing) → health → stop → start again.
 *
 *   npm run build && node dist/smokeDesktop.js [path/to/docker/desktop]
 */
import path from 'node:path';
import { DesktopEngine } from './desktop/engine';

async function main(): Promise<number> {
  const buildContext = process.argv[2] ?? path.resolve(process.cwd(), 'docker', 'desktop');
  const engine = new DesktopEngine(
    {
      buildContext,
      cli: (process.env.DESKFISH_CONTAINER_CLI as 'auto' | 'docker' | 'podman') ?? 'auto',
      daemonUrl: process.env.DESKFISH_DAEMON_URL ?? 'http://localhost:9990',
      daemonToken: process.env.DESKFISH_DAEMON_TOKEN ?? '',
      vncPassword: process.env.DESKFISH_VNC_PASSWORD ?? '',
      screen: process.env.DESKFISH_SCREEN ?? '1280x800x24',
    },
    { info: (l) => console.log(`  ${l}`), progress: (m) => console.log(`▶ ${m}`) },
  );
  const cli = await engine.resolveCli();
  console.log(`cli=${cli} image exists=${await engine.imageExists(cli)} healthy=${await engine.isHealthy()}`);

  const t0 = Date.now();
  console.log('--- stop');
  await engine.stop();
  console.log(`healthy after stop: ${await engine.isHealthy()}`);
  console.log('--- start');
  await engine.start();
  console.log(`healthy after start: ${await engine.isHealthy()}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return (await engine.isHealthy()) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
