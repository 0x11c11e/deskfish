// The web page the gateway serves (src/gateway/web.ts through server.ts). The browser bundles are
// built into a scratch copy of the Deskfish folder first, as `npm run build` would. Without the token
// `/` is a 401 sign-in page that carries no bundle, no version and no data; with it (a link's
// `?token=`, a Bearer header, or the sign-in page's form post) `/` is one page with the shim and both
// views inlined — the chat and Desktop bodies from src/ui/bodies.ts, their stylesheets and bundles —
// under a policy whose nonce is the one on every script; the token itself is never in the page.
// `/docs` needs the token and its inline scripts are allowed by hash. Then the shim itself, in Node,
// against the real gateway: hello and the snapshot, a key saved through the real validator, New chat.
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

console.log(`webpage: ${n} checks passed`);
process.exit(0);
