import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chatBody, desktopBody } from '../ui/bodies';

/**
 * The web page the gateway serves at `/`: chat left, the live view right, both views built from the
 * same bodies, stylesheets and bundles as the VS Code webviews (`src/ui/bodies.ts`, `media/*.css`,
 * `dist/webview/*.js`) with `web/shim.ts` standing in for VS Code. Each view is an `<iframe srcdoc>`
 * (VS Code's webviews are iframes too; the two stylesheets would collide in one document), and
 * everything is inlined into one response, so no URL other than the page itself ever needs the
 * token. No string in the page comes from the model, a chat or a request: what changes is set by the
 * views' scripts with `textContent` (the assistant's markdown through `mdLite`, which escapes first).
 * No `vscode` import.
 */

/** The page's parts, relative to the Deskfish folder (the extension's, or a checkout after `npm run build`). */
export const WEB_FILES = {
  page: 'web/index.html',
  signin: 'web/signin.html',
  css: 'web/web.css',
  shim: 'dist/web/shim.js',
  chatJs: 'dist/webview/chat.js',
  chatCss: 'media/chat.css',
  desktopJs: 'dist/webview/desktop.js',
  desktopCss: 'media/desktop.css',
  icon: 'media/icon.svg',
  docs: 'docs/site/index.html',
} as const;

export interface WebResponse {
  html: string;
  headers: Record<string, string>;
}

/** Why the sign-in page is shown: no token yet, a link with a wrong one, or a token this browser kept that was refused. */
export type SignInReason = '' | 'link' | 'post';

const fill = (template: string, values: Record<string, string>) => template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? values[k] : m));
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
/** A bundle as the body of an inline <script>: no early `</script`, no source map comment. */
const inlineScript = (js: string) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
const inlineStyle = (css: string) => css.replace(/<\/(style)/gi, '<\\/$1');
const sha256 = (s: string) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;

const COMMON_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export class WebClient {
  constructor(private readonly root: string) {}

  private read(rel: string): string {
    return fs.readFileSync(path.join(this.root, rel), 'utf8');
  }

  /** The page can be served: its template, the shim and both bundles are there (a build ran). */
  available(): boolean {
    return [WEB_FILES.page, WEB_FILES.signin, WEB_FILES.shim, WEB_FILES.chatJs, WEB_FILES.desktopJs].every((f) => fs.existsSync(path.join(this.root, f)));
  }

  private icon(): string {
    try {
      return `data:image/svg+xml,${encodeURIComponent(this.read(WEB_FILES.icon))}`;
    } catch {
      return 'data:,';
    }
  }

  /** The inline scripts of the documentation, by hash: it opens in a tab that inherits the page's policy. */
  private docsScriptHashes(): string[] {
    let html: string;
    try {
      html = this.read(WEB_FILES.docs);
    } catch {
      return [];
    }
    return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => sha256(m[1]));
  }

  /** One view as a document for `srcdoc`: the palette, its stylesheet, its body, the stand-in for VS Code, its bundle. */
  private frame(pane: 'chat' | 'desktop', nonce: string, css: string): string {
    const body = pane === 'chat' ? chatBody('web') : desktopBody('web');
    const own = this.read(pane === 'chat' ? WEB_FILES.chatCss : WEB_FILES.desktopCss);
    const js = this.read(pane === 'chat' ? WEB_FILES.chatJs : WEB_FILES.desktopJs);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${inlineStyle(css)}</style>
<style>${inlineStyle(own)}</style>
</head>
<body class="web">
${body}<script nonce="${nonce}">window.acquireVsCodeApi = function () { return parent.deskfishHost.api(${JSON.stringify(pane)}); };</script>
<script type="module" nonce="${nonce}">${inlineScript(js)}</script>
</body>
</html>`;
  }

  /** The page (for a request that carried the token). `host` is the request's Host header, for the WebSocket rule. */
  page(host?: string): WebResponse {
    const nonce = crypto.randomBytes(18).toString('base64');
    const css = this.read(WEB_FILES.css);
    const html = fill(this.read(WEB_FILES.page), {
      nonce,
      icon: this.icon(),
      css: inlineStyle(css),
      shim: inlineScript(this.read(WEB_FILES.shim)),
      chat: attr(this.frame('chat', nonce, css)),
      desktop: attr(this.frame('desktop', nonce, css)),
    });
    const ws = host && /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i.test(host) ? ` ws://${host} wss://${host}` : '';
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' ${this.docsScriptHashes().join(' ')}`.trim(),
      "style-src 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      'img-src data: blob:',
      `connect-src 'self'${ws}`,
      "frame-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    return { html, headers: { ...COMMON_HEADERS, 'content-security-policy': csp } };
  }

  /** The page shown without a valid token: paste the token once, or send the one this browser kept. Says nothing about the gateway. */
  signIn(reason: SignInReason): WebResponse {
    const nonce = crypto.randomBytes(18).toString('base64');
    const html = fill(this.read(WEB_FILES.signin), { nonce, icon: this.icon(), css: inlineStyle(this.read(WEB_FILES.css)), refused: reason });
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
    return { html, headers: { ...COMMON_HEADERS, 'content-security-policy': csp } };
  }

  /** The documentation site, or undefined when it is not there. */
  docs(): WebResponse | undefined {
    let html: string;
    try {
      html = this.read(WEB_FILES.docs);
    } catch {
      return undefined;
    }
    const csp = `default-src 'none'; script-src ${this.docsScriptHashes().join(' ') || "'none'"}; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; frame-ancestors 'none'`;
    return { html, headers: { ...COMMON_HEADERS, 'content-security-policy': csp } };
  }
}
