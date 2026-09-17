// Gateway step 7: the app's decisions, without Electron.
//
// 1. Find-or-start (`decide.ts`, shared by the extension's spawn and the app): same build → use; newer
//    running → use; idle older → replace; busy older → use (and say so); an older one that could not
//    be asked → use; none → start. "Older" is a lower version, then an earlier build time.
// 2. The app's login entry on Linux: `deskfish-app.desktop` in a temp home with the AppImage and
//    `--hidden`, no ELECTRON_RUN_AS_NODE, apart from the extension's `deskfish.desktop`; written and
//    removed through `LoginItem`; macOS and Windows go to the OS login item (a fake api).
// 3. "Install Podman": the terminal launch per platform; the Linux script passes `sh -n` and runs.
// 4. Podman's VM on macOS and Windows: the step from three `podman machine list` samples.
// 5. `serve` is `startGateway` (cli.ts builds no server or service of its own).
// 6. check-vsix refuses a package carrying app/ or dist/app/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoginItem, appBinary, linuxEntry, type LoginItemApi } from '../app/autostart';
import { posixScript, terminalLaunches } from '../app/terminal';
import { machineStep, needsMachine } from '../src/desktop/machine';
import { planForLinux } from '../src/desktop/runtime';
import { autostartPlan } from '../src/gateway/autostart';
import { decideGateway, isOlderBuild } from '../src/gateway/decide';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

// ---------- 1. the decision table ----------
const b = (t: number) => t.toString(36);
const T = Date.parse('2026-09-16T20:00:00Z');
const mine = `0.1.40+${b(T)}`;
ok(decideGateway(mine) === 'start', 'nothing answering → start');
ok(decideGateway(mine, { version: mine }) === 'use', 'the same build → use');
ok(decideGateway(mine, { version: `0.1.40+${b(T + 60_000)}` }) === 'use', 'a newer build of the same version → use');
ok(decideGateway(mine, { version: `0.1.41+${b(T - 86_400_000)}` }) === 'use', 'a newer version built earlier → use');
ok(decideGateway(mine, { version: `0.1.39+${b(T + 86_400_000)}`, busy: false }) === 'replace', 'an idle older version → replace');
ok(decideGateway(mine, { version: `0.1.40+${b(T - 60_000)}`, busy: false }) === 'replace', 'an idle older build of the same version → replace');
ok(decideGateway(mine, { version: `0.1.39+${b(T)}`, busy: true }) === 'use-busy', 'a busy older build → use, replaced at a later start');
ok(decideGateway(mine, { version: `0.1.39+${b(T)}` }) === 'use', 'an older build that could not be asked → use, never shut down blind');
ok(!isOlderBuild('0.1.40+dev', mine) && !isOlderBuild(mine, '0.1.40+dev') && isOlderBuild('0.1.39+dev', mine) && !isOlderBuild('garbage', mine) && decideGateway('0.0.0+dev', { version: '0.0.0+dev' }) === 'use', 'a build id that cannot be read is not "older" either way (the version still counts)');
ok(isOlderBuild('0.9.99+zzzz', '1.0.0+0') && isOlderBuild('0.1.9+a', '0.1.10+a') && !isOlderBuild('0.1.10+a', '0.1.9+a'), 'versions compare as numbers, not strings');
// The two builds of one release (the vsix and an app installer, built minutes apart): exactly one replaces the other.
const vsix = `0.1.40+${b(T)}`;
const appBuild = `0.1.40+${b(T + 7 * 60_000)}`;
ok(decideGateway(appBuild, { version: vsix, busy: false }) === 'replace' && decideGateway(vsix, { version: appBuild, busy: false }) === 'use', 'the extension and the app of one release: the later build replaces the earlier once, never back and forth');

// ---------- 2. the login entry ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-app-home-'));
try {
  const env = { APPIMAGE: '/home/someone/Apps/Deskfish linux "x86_64".AppImage' };
  ok(appBinary('/tmp/.mount_Deskf1/deskfish', env) === env.APPIMAGE && appBinary('/opt/Deskfish/deskfish', {}) === '/opt/Deskfish/deskfish', 'the entry starts the AppImage file itself (its mount point changes), else the executable');
  const plan = linuxEntry({ execPath: '/tmp/.mount_Deskf1/deskfish', env, home });
  ok(plan.file === path.join(home, '.config', 'autostart', 'deskfish-app.desktop'), `the app's own file (${plan.file})`);
  ok(plan.contents!.includes('Exec="/home/someone/Apps/Deskfish linux \\\\"x86_64\\\\".AppImage" "--hidden"\n'), `Exec quotes the path by the desktop entry spec, then --hidden:\n${plan.contents}`);
  ok(!plan.contents!.includes('ELECTRON_RUN_AS_NODE') && plan.contents!.includes('Terminal=false') && plan.contents!.includes('Type=Application'), 'no ELECTRON_RUN_AS_NODE (the app is Electron as itself), a plain application entry');
  const ext = autostartPlan({ platform: 'linux', execPath: '/usr/share/code/code', entry: '/ext/dist/gateway.js', dataDir: '/d', port: 9980, home, desktopSession: true });
  ok(ext.file !== plan.file && ext.file!.endsWith('deskfish.desktop'), 'the extension keeps deskfish.desktop: neither overwrites the other');
  assert.throws(() => autostartPlan({ platform: 'darwin', execPath: '', entry: '', dataDir: '', port: 0, home, argv: ['/Applications/Deskfish.app'] }), /login item/);
  n++;

  const calls: unknown[] = [];
  let openAtLogin = false;
  const api: LoginItemApi = {
    getLoginItemSettings: (o) => { calls.push(['get', o]); return { openAtLogin }; },
    setLoginItemSettings: (s) => { calls.push(['set', s]); openAtLogin = s.openAtLogin; },
  };
  const linux = new LoginItem({ platform: 'linux', execPath: '/opt/Deskfish/deskfish', env: {}, home, api });
  ok(!linux.isOn(), 'Linux: off before anything was written');
  const where = linux.set(true);
  const written = fs.readFileSync(path.join(home, '.config', 'autostart', 'deskfish-app.desktop'), 'utf8');
  ok(linux.isOn() && where.endsWith('deskfish-app.desktop') && written.includes('Exec="/opt/Deskfish/deskfish" "--hidden"'), 'Linux: on writes the entry');
  linux.set(false);
  ok(!linux.isOn() && !fs.existsSync(path.join(home, '.config', 'autostart', 'deskfish-app.desktop')) && calls.length === 0, 'Linux: off removes it, and the OS login item api is never used');
  const win = new LoginItem({ platform: 'win32', execPath: 'C:\\Deskfish\\Deskfish.exe', env: {}, home, api });
  win.set(true);
  ok(win.isOn() && JSON.stringify(calls) === JSON.stringify([['set', { openAtLogin: true, args: ['--hidden'] }], ['get', { args: ['--hidden'] }]]), `Windows: the login item with --hidden (${JSON.stringify(calls)})`);
  calls.length = 0;
  const mac = new LoginItem({ platform: 'darwin', execPath: '/Applications/Deskfish.app/Contents/MacOS/Deskfish', env: {}, home, api });
  mac.set(false);
  ok(!mac.isOn() && JSON.stringify(calls) === '[["set",{"openAtLogin":false}],["get",null]]', `macOS: the login item without arguments (${JSON.stringify(calls)})`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

// ---------- 3. the install terminal ----------
const debian = planForLinux('ID=debian\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n').command!;
const linuxLaunches = terminalLaunches('linux', debian);
ok(linuxLaunches[0].file === 'x-terminal-emulator' && JSON.stringify(linuxLaunches[0].args.slice(0, 3)) === JSON.stringify(['-e', 'sh', '-c']) && linuxLaunches.map((l) => l.file).join(',') === 'x-terminal-emulator,gnome-terminal,konsole,xfce4-terminal,xterm', 'Linux: x-terminal-emulator first, then terminals by name, each running sh -c');
ok(linuxLaunches.every((l) => l.args[l.args.length - 1] === posixScript(debian)), 'every Linux launch runs the same script');
const syntax = spawnSync('sh', ['-n', '-c', posixScript(debian)], { encoding: 'utf8' });
ok(syntax.status === 0, `the Linux script passes sh -n (${syntax.stderr})`);
const ran = spawnSync('sh', ['-c', posixScript("echo 'installing it'")], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/true' } });
ok(ran.status === 0 && ran.stdout.includes('installing it') && ran.stdout.includes('click Check again'), `the script runs the command, says what next, then hands over to the shell (${JSON.stringify(ran.stdout)})`);
const macLaunch = terminalLaunches('darwin', 'brew install podman || echo "Could not finish"');
const apple = macLaunch[0].args[1];
const literal = /^tell application "Terminal" to do script "((?:[^"\\]|\\.)*)"$/.exec(apple);
const unescaped = literal?.[1].replace(/\\(.)/g, '$1');
ok(macLaunch[0].file === 'osascript' && !!literal && macLaunch[0].args[3] === 'tell application "Terminal" to activate', `macOS: osascript tells Terminal to run one escaped AppleScript string (${apple})`);
ok(spawnSync('sh', ['-n', '-c', unescaped!]).status === 0 && unescaped!.startsWith("sh -c '") && unescaped!.includes('Could not finish'), 'macOS: the string AppleScript hands the shell is valid sh');
const w = terminalLaunches('win32', 'winget install -e --id RedHat.Podman')[0];
ok(w.file === 'cmd.exe' && w.verbatim && w.args.join(' ') === '/d /s /c "start "Deskfish: install Podman" cmd /k winget install -e --id RedHat.Podman"', `Windows: start a console that stays open (${w.args.join(' ')})`);

// ---------- 4. Podman's VM ----------
const none = '[]\n';
const stopped = JSON.stringify([{ Name: 'podman-machine-default*', Default: true, Running: false, Starting: false, VMType: 'applehv', LastUp: '2026-09-10T10:00:00Z' }]);
const running = JSON.stringify([{ Name: 'podman-machine-default*', Default: true, Running: true, Starting: false, VMType: 'wsl' }]);
ok(machineStep(none).action === 'init', 'no machine → init (then start)');
const st = machineStep(stopped);
ok(st.action === 'start' && st.name === 'podman-machine-default', `a stopped machine → start it, by name without the default mark (${JSON.stringify(st)})`);
ok(machineStep(running).action === 'none', 'a running machine → nothing');
ok(machineStep(JSON.stringify([{ Name: 'other', Running: false }, { Name: 'mine*', Default: true, Running: false }])).action === 'start' && (machineStep(JSON.stringify([{ Name: 'other' }, { Name: 'mine*', Default: true }])) as { name: string }).name === 'mine', 'several machines: the default one is started');
ok(machineStep('Error: something').action === 'none' && machineStep('{"a":1}').action === 'none', 'output that cannot be read → nothing (podman reports the real error later)');
ok(needsMachine('darwin', 'podman') && needsMachine('win32', 'podman') && !needsMachine('linux', 'podman') && !needsMachine('darwin', 'docker'), 'only macOS and Windows with Podman need the VM step');
const engineSrc = fs.readFileSync(path.join(ROOT, 'src/desktop/engine.ts'), 'utf8');
const startBody = engineSrc.slice(engineSrc.indexOf('async start(): Promise<void>'));
ok(startBody.indexOf('ensurePodmanMachine') > 0 && startBody.indexOf('ensurePodmanMachine') < startBody.indexOf('imageState') && startBody.indexOf('imageState') < startBody.indexOf('this.run(cli)'), 'the engine asks for the VM before it looks at the image, builds or runs');

// ---------- 5. serve is startGateway ----------
const cli = fs.readFileSync(path.join(ROOT, 'src/gateway/cli.ts'), 'utf8');
const serve = cli.slice(cli.indexOf('async function serve('), cli.indexOf('/* ---------- the client commands'));
ok(/await startGateway\(\{ \.\.\.o, resourceDir: path\.resolve\(__dirname, '\.\.'\)/.test(serve), 'serve calls startGateway with its own folder as the resources');
ok(!/new GatewayServer|new DeskfishService|takeLock|writePrivate|loadConfig/.test(cli), 'cli.ts builds no server, no service, takes no lock and writes no config of its own');
const main = fs.readFileSync(path.join(ROOT, 'app/main.ts'), 'utf8');
ok(/await startGateway\(\{ dir: DIR, port: PORT, resourceDir: RESOURCES/.test(main) && main.includes("settleLocalGateway({ url: URL_BASE, token, version: VERSION, client: 'app'"), 'the app starts the same function after the same decision');
ok(/contextIsolation: true, nodeIntegration: false, sandbox: true/.test(main) && !/preload/.test(main.replace(/no preload/g, '')), 'the window: context isolation, no Node, sandboxed, no preload');
ok(main.includes("session.fromPartition('deskfish-app')") && !main.includes("fromPartition('persist:"), 'the page session is in memory only (the token stays in gateway.token on disk)');

// ---------- 6. check-vsix ----------
const zips = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-vsix-'));
try {
  const makeZip = (name: string, entries: string[]) => {
    const file = path.join(zips, name);
    const r = spawnSync('python3', ['-c', 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor e in sys.argv[2:]: z.writestr(e,"x")\nz.close()', file, ...entries]);
    assert.equal(r.status, 0, String(r.stderr));
    return file;
  };
  const check = (file: string) => spawnSync('node', [path.join(ROOT, 'scripts/check-vsix.mjs'), file], { encoding: 'utf8' });
  const base = ['extension/package.json', 'extension/dist/extension.js', 'extension/dist/gateway.js', 'extension/media/icon.png'];
  ok(check(makeZip('clean.vsix', base)).status === 0, 'a clean package passes');
  const withApp = check(makeZip('app.vsix', [...base, 'extension/app/main.ts']));
  ok(withApp.status === 1 && withApp.stderr.includes('extension/app/main.ts'), 'a package carrying app/ is refused');
  const withDistApp = check(makeZip('distapp.vsix', [...base, 'extension/dist/app/main.js']));
  ok(withDistApp.status === 1 && withDistApp.stderr.includes('extension/dist/app/main.js'), 'a package carrying dist/app/ is refused');
  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n');
  ok(ignore.includes('app/**') && ignore.includes('dist/app/**'), '.vscodeignore leaves both out');
} finally {
  fs.rmSync(zips, { recursive: true, force: true });
}

console.log(`app: ${n} checks passed`);
