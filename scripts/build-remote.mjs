// The one static file the relay page is: `dist/web/remote.html`.
//
// At home the gateway builds its page per request (`src/gateway/web.ts`) and can use a fresh nonce
// each time. The page that reaches her through a relay has no server of its own — that is the whole
// point, because a relay that served the page could hand your browser code that leaks the key — so
// it is built once, here, from exactly the same parts: `web/index.html`, `web/web.css`, the two
// view bodies and bundles, their stylesheets, the icon, and `web/remote.ts` in place of the shim.
// Its policy names every script by hash instead of by nonce, and the suite checks that the hashes
// in the file are the hashes of the scripts in the file.
//
// The release attaches this file; whoever publishes it puts it at `remote.<their domain>`, which is
// how the page finds its relay by default. Nothing about any one relay or any one person is in it.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** A bundle as the body of an inline <script>: no early `</script`, no source-map comment. */
const inlineScript = (js) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
const inlineStyle = (css) => css.replace(/<\/(style)/gi, '<\\/$1');
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
/** The other way, for a reader (the suite) that has only the built file and must find the real scripts. */
export const unattr = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
export const sha256 = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/** Every inline script in a document, in order — what the policy has to name. */
export const inlineScripts = (html) => [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

/**
 * The scripts a browser will actually run, as it will see them: the page's own, and then the two
 * views' — which live inside `srcdoc` attributes, so the text to hash is the text *after* the
 * parser has put the quotes and ampersands back, not the escaped form in the file. Hashing the
 * escaped form would produce a policy that looks right and blocks both views.
 */
export function pageScripts(html) {
  const outer = html.replace(/\ssrcdoc="[^"]*"/gi, '');
  const frames = [...html.matchAll(/\ssrcdoc="([^"]*)"/gi)].map((m) => unattr(m[1]));
  return [...inlineScripts(outer), ...frames.flatMap(inlineScripts)];
}

/** One view as a document for `srcdoc`, exactly as `web.ts` builds it, minus the nonce. */
function frame(pane, css, bodies) {
  const body = pane === 'chat' ? bodies.chatBody('web') : bodies.desktopBody('web');
  const own = read(pane === 'chat' ? 'media/chat.css' : 'media/desktop.css');
  const js = read(pane === 'chat' ? 'dist/webview/chat.js' : 'dist/webview/desktop.js');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${inlineStyle(css)}</style>
<style>${inlineStyle(own)}</style>
</head>
<body class="web">
${body}<script>window.acquireVsCodeApi = function () { return parent.deskfishHost.api(${JSON.stringify(pane)}); };</script>
<script type="module">${inlineScript(js)}</script>
</body>
</html>`;
}

/**
 * The policy. It differs from the gateway's page in four places, each for a reason:
 * `'wasm-unsafe-eval'` because the OPAQUE library's WebAssembly is compiled in the page (inlined as
 * base64 — nothing is fetched); hashes instead of a nonce because a static file cannot have a fresh
 * one; `connect-src` allowing any `wss:` because the relay is whichever one the person typed, plus
 * loopback `ws:` so the live check can run a relay on this machine; and no font hosts, because this
 * page's documentation button goes to the site rather than serving docs of its own.
 *
 * `script-src` names every script by hash and nothing else. `style-src` keeps `'unsafe-inline'`,
 * which is the one place this policy is not hash-tight: the markup the views share with VS Code
 * (`src/ui/bodies.ts`) carries a `style="display:none"` that no hash can cover, and hardening it
 * would mean changing a view that two hosts render. It buys nothing here anyway — with
 * `default-src 'none'` and `img-src data: blob:` a stylesheet has nowhere to send what it sees.
 */
export function policy(hashes) {
  return [
    "default-src 'none'",
    `script-src 'wasm-unsafe-eval' ${hashes.join(' ')}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    "connect-src wss: ws://127.0.0.1:* ws://localhost:*",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export async function buildRemote() {
  const bodies = await import(new URL('../dist/web/bodies.mjs', import.meta.url).href).catch(() => undefined);
  if (!bodies) throw new Error('dist/web/bodies.mjs is missing: run the esbuild step first');
  const css = read('web/web.css');
  const icon = `data:image/svg+xml,${encodeURIComponent(read('media/icon.svg'))}`;
  const signin = read('web/remote.html');

  // Every structural edit happens on the template *before* the two `srcdoc` documents are pasted
  // in, because those hold `</main>` and `</body>` of their own and a plain replace would find the
  // wrong one. The placeholders go last, when nothing structural is looking for a tag any more.
  let html = read('web/index.html');
  // The page says what it is, so the shared shim does not boot itself over the sign-in.
  html = html.replace('<html lang="en">', '<html lang="en" data-page="remote">');
  // The views are kept inert until a password has been typed: their scripts ask `parent.deskfishHost`
  // for the bridge, and until the channel exists there is nothing for them to ask.
  html = html.replace('<main id="panes">', '<template id="page"><main id="panes">').replace('</main>', '</main></template>');
  html = html.replace('</body>', `${signin}\n</body>`);
  html = html.replace('<title>Deskfish</title>', '<title>Deskfish</title>\n<meta name="robots" content="noindex">');
  html = html
    .replace('<script nonce="{{nonce}}">{{shim}}</script>', `<script>${inlineScript(read('dist/web/remote.js'))}</script>`)
    .replace('{{icon}}', icon)
    .replace('{{css}}', inlineStyle(css))
    .replace('{{chat}}', attr(frame('chat', css, bodies)))
    .replace('{{desktop}}', attr(frame('desktop', css, bodies)));
  if (/\{\{\w+\}\}/.test(html)) throw new Error(`build-remote: a placeholder was left in the page: ${/\{\{\w+\}\}/.exec(html)[0]}`);

  const csp = policy(pageScripts(html).map(sha256));
  html = html.replace('<meta name="referrer" content="no-referrer">', `<meta name="referrer" content="no-referrer">\n<meta http-equiv="content-security-policy" content="${attr(csp)}">`);

  const out = join(ROOT, 'dist/web/remote.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  return { file: out, bytes: Buffer.byteLength(html), scripts: pageScripts(html).length };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const r = await buildRemote();
  console.log(`remote page: ${r.scripts} inline scripts → dist/web/remote.html (${Math.round(r.bytes / 1024)} KB)`);
}
