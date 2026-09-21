// The web page the gateway serves (src/gateway/web.ts through server.ts). The browser bundles are
// built into a scratch copy of the Deskfish folder first, as `npm run build` would. Without the token
// `/` is a 401 sign-in page that carries no bundle, no version and no data; with it (a link's
// `?token=`, a Bearer header, or the sign-in page's form post) `/` is one page with the shim and both
// views inlined — the chat and Desktop bodies from src/ui/bodies.ts, their stylesheets and bundles —
// under a policy whose nonce is the one on every script; the token itself is never in the page.
// `/docs` needs the token and its inline scripts are allowed by hash. Then the shim itself, in Node,
// against the real gateway: hello and the snapshot, a key saved through the real validator, New chat.
// Last, the *other* page — `dist/web/remote.html`, the one static file a relay's browser loads
// (scripts/build-remote.mjs): no token, no relay address of anybody's, a policy with no
// `unsafe-inline` and no nonce whose hashes are exactly the hashes of the scripts in the file
// (the two views' among them, as the parser will see them inside `srcdoc`), and the views held in
// a template until a password has been typed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { DeskfishService } from '../src/gateway/service';
import { GatewayServer } from '../src/gateway/server';
import { DEFAULT_CONFIG } from '../src/gateway/config';
import { WEB_FILES, WebClient } from '../src/gateway/web';
import { chatBody, desktopBody } from '../src/ui/bodies';
import { WebHost, type HostUi, type SocketLike } from '../web/shim';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}

// ---------- a Deskfish folder with the bundles built ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-webpage-'));
const webRoot = path.join(tmp, 'app');
for (const rel of [WEB_FILES.page, WEB_FILES.signin, WEB_FILES.css, WEB_FILES.chatCss, WEB_FILES.desktopCss, WEB_FILES.icon, WEB_FILES.docs]) {
  fs.mkdirSync(path.dirname(path.join(webRoot, rel)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), path.join(webRoot, rel));
}
const build = { absWorkingDir: ROOT, bundle: true, logLevel: 'silent' as const, platform: 'browser' as const, target: 'es2022', define: { __DESKFISH_VERSION__: '"9.9.9"', __DESKFISH_BUILD__: '"pagetest"' } };
await Promise.all([
  esbuild.build({ ...build, entryPoints: ['web/shim.ts'], outfile: path.join(webRoot, WEB_FILES.shim), format: 'iife' }),
  esbuild.build({ ...build, entryPoints: ['src/webview/chat.ts', 'src/webview/desktop.ts'], outdir: path.join(webRoot, 'dist/webview'), format: 'esm', sourcemap: true }),
]);

// ---------- the gateway ----------
const dataDir = path.join(tmp, 'home');
const service = new DeskfishService({
  dataDir, resourceDir: ROOT, config: { ...DEFAULT_CONFIG, autoStart: false, daemonUrl: 'http://127.0.0.1:1', vncUrl: 'ws://127.0.0.1:1/websockify' },
  createEngine: () => ({ isHealthy: async () => false, start: async () => {}, stop: async () => {}, inspectNetworkMode: async () => 'isolated' as const, networkMode: 'isolated' as const }),
});
service.init();
const TOKEN = crypto.randomBytes(32).toString('hex');
const server = new GatewayServer({ service, token: TOKEN, port: 0, webRoot });
const port = await server.listen();
const url = `http://127.0.0.1:${port}`;

const nonceOf = (csp: string) => csp.match(/'nonce-([^']+)'/)?.[1];
const unattr = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

try {
  // 1. no token: the sign-in page, and nothing else
  for (const [what, res, reason] of [
    ['no token', await fetch(`${url}/`), ''],
    ['a wrong token in the link', await fetch(`${url}/?token=wrong`), 'link'],
    ['a wrong Bearer header', await fetch(`${url}/`, { headers: { authorization: 'Bearer wrong' } }), ''],
  ] as const) {
    const html = await res.text();
    const csp = res.headers.get('content-security-policy') ?? '';
    ok(res.status === 401 && /Paste the gateway's token/.test(html) && html.includes(`data-refused="${reason}"`), `${what}: 401 with the sign-in page (${reason || 'no reason'})`);
    ok(!html.includes('deskfishHost') && !html.includes('Newer messages') && !html.includes('9.9.9') && !html.includes(dataDir) && !html.includes(TOKEN), `${what}: no bundle, no version, no data folder, no token`);
    ok(csp.includes("default-src 'none'") && csp.includes(`'nonce-${nonceOf(csp)}'`) && html.includes(`<script nonce="${nonceOf(csp)}">`) && csp.includes("frame-ancestors 'none'") && res.headers.get('x-frame-options') === 'DENY', `${what}: locked down (CSP nonce on its one script, no framing)`);
  }
  ok((await (await fetch(`${url}/`)).text()).includes('method="post" action="/"') , 'the sign-in page posts the token in a form, not in a URL');

  // 2. with the token: the page
  const res = await fetch(`${url}/?token=${TOKEN}`);
  const page = await res.text();
  const csp = res.headers.get('content-security-policy') ?? '';
  const nonce = nonceOf(csp)!;
  ok(res.status === 200 && res.headers.get('content-type')?.startsWith('text/html') && res.headers.get('cache-control') === 'no-store', 'a link with the token: 200, HTML, not cached');
  ok(!page.includes(TOKEN) && !page.includes(dataDir), 'the token and the data folder are not in the page');
  ok(page.includes('.deskfishHost = host') && page.includes('id="newChat"') && page.includes('id="modelDialog"') && page.includes('id="keyDialog"'), 'the shim is inlined, with the page\'s title bar and dialogs');
  const bar = page.slice(page.indexOf('<header id="bar">'), page.indexOf('</header>', page.indexOf('<header id="bar">')));
  ok(['history', 'schedules', 'settings', 'files', 'newChat'].every((id) => bar.includes(`<button id="${id}"`)) && (bar.match(/<button id="/g) ?? []).length === 6 && bar.includes('id="menuBtn"'), 'the title bar: History, Schedules, Settings, Her files, New chat and the … menu');
  ok(['reflect', 'export', 'import', 'deleteChats', 'log', 'docs'].every((m) => bar.includes(`data-menu="${m}"`)) && page.includes('id="confirmDialog"') && page.includes('openPanel') && page.includes('importMemory'), 'the … menu\'s six items and the page\'s confirm, wired by the inlined shim');
  const outside = page.replace(/srcdoc="[^"]*"/g, '');
  ok(!/settingsDialog|schedulesDialog|dialog\.sheet|id="scheduleList"/.test(outside) && (outside.match(/<dialog id="/g) ?? []).length === 5, 'the page has no settings or schedules dialog of its own any more (model, key, sign-in, confirm, log)');
  ok(page.includes('id="signInDialog"') && page.includes('id="signInCode"') && /Grok Build/.test(page), 'the Grok sign-in dialog is there, with the code and the name xAI\'s consent screen shows');
  ok(!/<form[^>]*>(?:(?!<\/form>)[\s\S])*type="password"/.test(page.replace(/srcdoc="[^"]*"/g, '')) && !/<script\b[^>]*\bsrc=/.test(page), 'no password field inside a form (the browser would offer to keep it as a login), no script source');
  const frames = [...page.matchAll(/<iframe id="(chat|desktop)" title="[^"]*" srcdoc="([^"]*)"><\/iframe>/g)];
  ok(frames.length === 2 && frames[0][1] === 'chat' && frames[1][1] === 'desktop', `two views as srcdoc frames, the attribute intact (${frames.map((f) => f[1]).join(', ')})`);
  const chatDoc = unattr(frames[0][2]);
  const deskDoc = unattr(frames[1][2]);
  const chatJs = fs.readFileSync(path.join(webRoot, WEB_FILES.chatJs), 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
  const deskJs = fs.readFileSync(path.join(webRoot, WEB_FILES.desktopJs), 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
  ok(chatDoc.includes(chatJs.replace(/<\/(script)/gi, '<\\/$1')) && chatDoc.includes('Newer messages'), `the chat bundle, whole (${chatJs.length} chars)`);
  ok(deskDoc.includes(deskJs.replace(/<\/(script)/gi, '<\\/$1')) && deskDoc.length > 300_000, `the Desktop bundle with noVNC, whole (${deskJs.length} chars)`);
  ok(!chatDoc.includes('sourceMappingURL') && !deskDoc.includes('sourceMappingURL'), 'no source map comments (they would ask for a URL without the token)');
  ok(chatDoc.includes(chatBody('web')) && chatDoc.includes(fs.readFileSync(path.join(ROOT, WEB_FILES.chatCss), 'utf8')), 'the chat body and stylesheet, the same source as VS Code');
  ok(['panel-history', 'panel-settings', 'panel-schedules', 'panel-files', 'pastBar', 'settingsFields', 'schedKind'].every((id) => chatDoc.includes(`id="${id}"`)) && chatBody('vscode').includes('id="panel-settings"'), 'the four panels and the past-chat bar live in the chat body, for both hosts');
  ok(deskDoc.includes(desktopBody('web')) && desktopBody('web').indexOf('id="stage"') < desktopBody('web').indexOf('id="toolbar"') && desktopBody('vscode').indexOf('id="toolbar"') < desktopBody('vscode').indexOf('id="stage"'), 'the Desktop body: status line and Take over under the screen on the web, above it in VS Code');
  ok(chatDoc.includes('parent.deskfishHost.api("chat")') && deskDoc.includes('parent.deskfishHost.api("desktop")'), 'each view gets acquireVsCodeApi from the page');
  const scripts = [page.replace(/srcdoc="[^"]*"/g, ''), chatDoc, deskDoc].flatMap((d) => [...d.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]));
  ok(scripts.length === 5 && scripts.every((a) => a.includes(`nonce="${nonce}"`)), `every script (${scripts.length}) carries the response's nonce`);
  for (const [name, doc] of [['chat', chatDoc], ['desktop', deskDoc]] as const) {
    const opens = (doc.match(/<script\b/g) ?? []).length;
    const closes = (doc.match(/<\/script>/g) ?? []).length;
    ok(opens === 2 && closes === 2, `${name}: no early </script> inside an inlined bundle (${opens} open, ${closes} close)`);
  }
  ok(csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'") && csp.includes("base-uri 'none'") && /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ wss:/.test(csp) && !csp.includes('unsafe-eval') && !/script-src[^;]*unsafe-inline/.test(csp), `the page's policy: ${csp.replace(/'sha256-[^']+'/g, 'sha…')}`);
  const odd = new WebClient(webRoot).page("evil; script-src *").headers['content-security-policy'];
  ok(!odd.includes('evil') && /connect-src 'self';/.test(odd), 'a Host header that is not a host does not reach the policy');
  const bearer = await fetch(`${url}/`, { headers: { authorization: `Bearer ${TOKEN}` } });
  ok(bearer.status === 200 && (await bearer.text()).includes('deskfishHost'), 'a Bearer header works too');

  // 3. the sign-in page's form post
  const form = (body: string, type = 'application/x-www-form-urlencoded') => fetch(`${url}/`, { method: 'POST', headers: { 'content-type': type }, body });
  let r = await form(`token=${TOKEN}`);
  ok(r.status === 200 && (await r.text()).includes('deskfishHost'), 'POST / with the token: the page');
  r = await form('token=wrong');
  ok(r.status === 401 && (await r.text()).includes('data-refused="post"'), 'POST / with a wrong token: sign-in, "refused" (the page forgets the stored one)');
  r = await form(`{"token":"${TOKEN}"}`, 'application/json');
  ok(r.status === 401, 'POST / as JSON is not a sign-in');
  r = await form(`token=${'x'.repeat(10_000)}`);
  ok(r.status === 401, 'an oversized form is refused');

  // 4. the documentation
  ok((await fetch(`${url}/docs`)).status === 401 && (await fetch(`${url}/docs?token=wrong`)).status === 401, '/docs needs the token');
  const docs = await fetch(`${url}/docs`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const docsHtml = await docs.text();
  const docsCsp = docs.headers.get('content-security-policy') ?? '';
  const hashes = [...docsHtml.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  ok(docs.status === 200 && docsHtml === fs.readFileSync(path.join(ROOT, WEB_FILES.docs), 'utf8'), 'with the token: the documentation site');
  ok(hashes.length > 0 && hashes.every((h) => docsCsp.includes(h) && csp.includes(h)), `its ${hashes.length} inline scripts are allowed by hash (on /docs, and on the page whose tab it opens in)`);
  ok((await fetch(`${url}/docs`, { method: 'HEAD' })).status === 401 && (await fetch(`${url}/docs`, { method: 'HEAD', headers: { authorization: `Bearer ${TOKEN}` } })).status === 404, 'HEAD /docs: 401 without the token, 404 with it (the page\'s token check)');

  // 5. a Deskfish folder without a build: the placeholder behind the token, as before
  const bare = new GatewayServer({ service, token: TOKEN, port: 0, webRoot: path.join(tmp, 'nothing') });
  const barePort = await bare.listen();
  ok((await fetch(`http://127.0.0.1:${barePort}/`)).status === 401 && (await fetch(`http://127.0.0.1:${barePort}/?token=${TOKEN}`)).status === 200, 'no build: / is the placeholder, still behind the token');
  await bare.close();

  // 6. the shim in Node against this gateway
  const posts: { pane: string; m: any }[] = [];
  const toasts: string[] = [];
  const ui = { visible: () => true, connection() {}, toast: (t: string) => toasts.push(t), knock() {}, askKey: async () => 'sk-ant-from-the-page', reload() {} } as unknown as HostUi;
  const host = new WebHost({
    wsUrl: `ws://127.0.0.1:${port}/ws?token=${TOKEN}`, vncUrl: `ws://127.0.0.1:${port}/vnc?token=${TOKEN}`, token: TOKEN,
    openSocket: (u) => new WebSocket(u) as unknown as SocketLike,
    post: (pane, m) => posts.push({ pane, m }),
    fetch: (u, init) => fetch(new URL(u, url), init),
    ui,
  });
  host.api('chat').postMessage({ type: 'ready' });
  host.api('desktop').postMessage({ type: 'ready' });
  host.start();
  await until(() => posts.some((p) => p.pane === 'chat' && p.m.type === 'config'), 'the chat header from the real snapshot');
  ok(posts.some((p) => p.pane === 'chat' && p.m.type === 'newChat') && posts.find((p) => p.m.type === 'config')!.m.config.hasApiKey === false, 'hello → snapshot → the chat rebuilt, no key yet');
  host.api('chat').postMessage({ type: 'setApiKey' });
  await until(() => toasts.some((t) => /saved/.test(t)), 'the key saved');
  const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
  ok(secrets.keys['deskfish.apiKey.anthropic'] === 'sk-ant-from-the-page', 'the key reached secrets.json through key.set and the validator');
  ok(posts.filter((p) => p.m.type === 'config').at(-1)!.m.config.hasApiKey === true, 'and the key row says stored');
  const before = posts.length;
  host.newChat();
  await until(() => posts.slice(before).some((p) => p.pane === 'chat' && p.m.type === 'newChat'), 'New chat comes back as reset → newChat');
  ok(true, 'New chat goes out as a command and comes back as the reset event');
  host['ws']?.close();
} finally {
  await server.close();
  service.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- the page a relay's browser loads ----------
{
  const { buildRemote, pageScripts, sha256 } = await import('../scripts/build-remote.mjs');
  const needed = ['dist/web/remote.js', 'dist/web/bodies.mjs', 'dist/webview/chat.js', 'dist/webview/desktop.js'];
  if (!needed.every((f) => fs.existsSync(path.join(ROOT, f)))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const real = { absWorkingDir: ROOT, bundle: true, logLevel: 'silent' as const, target: 'es2022', define: { __DESKFISH_VERSION__: JSON.stringify(pkg.version), __DESKFISH_BUILD__: '"suite"' } };
    await Promise.all([
      esbuild.build({ ...real, entryPoints: ['web/remote.ts'], outfile: 'dist/web/remote.js', platform: 'browser', format: 'iife' }),
      esbuild.build({ ...real, entryPoints: ['src/ui/bodies.ts'], outfile: 'dist/web/bodies.mjs', platform: 'node', format: 'esm' }),
      esbuild.build({ ...real, entryPoints: ['src/webview/chat.ts', 'src/webview/desktop.ts'], outdir: 'dist/webview', platform: 'browser', format: 'esm' }),
    ]);
  }
  const built = await buildRemote();
  const html = fs.readFileSync(built.file, 'utf8');
  const csp = /content-security-policy" content="([^"]+)"/.exec(html)?.[1] ?? '';

  ok(html.startsWith('<!DOCTYPE html>') && / data-page="remote"/.test(html), 'one document, and it says which page it is so the shared shim does not boot over the sign-in');
  // `boot()` travels in the bundle (the shared shim is one file) but is guarded off on this page,
  // so the *word* token appears; what must not is a token — any 32 random bytes as hex.
  ok(!html.includes(TOKEN) && !/\b[0-9a-f]{64}\b/.test(html) && !/localStorage\.getItem\("deskfish\.token"\)/.test(html.replace(/\s+/g, '')), 'no token anywhere in it — there is none to have');
  // `relay.example.com` is the input's placeholder; what must not be here is a working address.
  ok(!html.includes('wss://relay.deskfish.sh') && !/wss:\/\/relay\.[a-z0-9-]+\.[a-z]{2,}/.test(html.replace(/placeholder="[^"]*"/g, '')), 'and no relay of anybody’s baked in: the page finds its own, or is told one');

  const hashes = pageScripts(html).map(sha256);
  ok(hashes.length === 5, `five scripts: the page’s own and two in each view (${hashes.length})`);
  ok(hashes.every((h) => csp.includes(h)), 'every script in the file is named by the policy — the views’ two as the parser will see them, not as the file escapes them');
  ok((csp.match(/'sha256-/g) ?? []).length === hashes.length, 'and the policy names nothing else');
  const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? '';
  ok(!/unsafe-inline|'nonce-/.test(scriptSrc) && !/'unsafe-eval'/.test(scriptSrc), `script-src: hashes only — no unsafe-inline, no nonce, no unsafe-eval (${scriptSrc.slice(0, 40)}…)`);
  // The one `unsafe-inline` left is for styles, and it is fenced in: with `default-src 'none'` and
  // `img-src data: blob:` a stylesheet has nowhere to send anything, and the markup the views share
  // with VS Code carries one `style="display:none"` that a hash cannot cover.
  ok((csp.match(/unsafe-inline/g) ?? []).length === 1 && /style-src 'unsafe-inline'/.test(csp), 'the only unsafe-inline is style-src, where nothing can be fetched');
  ok(csp.includes("default-src 'none'") && csp.includes("'wasm-unsafe-eval'") && /connect-src wss:/.test(csp) && csp.includes("frame-ancestors 'none'"), 'default-src none, wasm allowed (the OPAQUE library compiles inlined WebAssembly), wss: reachable, never framed');
  ok(!/https:\/\/fonts\./.test(csp), 'and no font host: this page’s documentation button goes to the site');

  ok(/<template id="page">[\s\S]*<main id="panes">/.test(html) && /<\/main><\/template>/.test(html), 'the views wait in a template: nothing asks for the bridge before there is one');
  ok(/<input id="user"/.test(html) && /<input id="pass"[^>]*type="password"/.test(html) && /<input id="relay"/.test(html) && /id="signinGo"/.test(html), 'the sign-in card asks for her name, a password and (folded away) a relay');
  ok(html.includes('https://deskfish.sh/docs'), 'the documentation button points at the site, not at a gateway’s /docs');
  ok(html.includes('@media (max-width: 760px)'), 'the phone-width layout is in it (the same stylesheet the page at home uses)');
  // The sign-in card ships in the same chat bundle as everywhere else, so the phone gets it for
  // free — the card's own words and its stylesheet are in this one file, with no second UI.
  ok(html.includes('Deskfish needs a login') && html.includes('current-password') && /\.needs-user \.field input/.test(html), 'the sign-in card travels in it: the card, its masked input and its stylesheet');
  ok(html.includes('acquireVsCodeApi') && html.includes('deskfishHost.api('), 'the views get the same bridge as at home: one implementation, two ways in');
  ok(built.bytes < 4 * 1024 * 1024, `one file, ${Math.round(built.bytes / 1024)} KB, with the WebAssembly inlined`);
}

console.log(`webpage: ${n} checks passed`);
process.exit(0);
