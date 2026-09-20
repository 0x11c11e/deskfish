/**
 * "Sign in with Grok": xAI's OAuth device-code flow, so her model calls draw the person's SuperGrok
 * pool instead of billing an xAI API key. Pure Node (`fetch`, no dependency), no `vscode`, and it
 * never touches disk — the gateway owns the tokens and is the only writer (`service.ts`).
 *
 * What was measured against the real endpoint on 2026-09-18 (probe in decision 112):
 *  - discovery at `https://auth.x.ai/.well-known/openid-configuration` gives the token, device,
 *    userinfo and revocation endpoints; the token endpoint is not hard-coded here;
 *  - the client id below is xAI's *shared* client for outside apps (Hermes Agent, OpenClaw, Kilo
 *    Code use the same one). Its consent screen is titled "Grok Build" — the dialog says so before
 *    the person sees it, because an unexplained app name on a sign-in page is how phishing looks;
 *  - access tokens live 6 hours (not the ~15 minutes some clients report); refresh returns a new
 *    refresh token every time, but the old one still worked on reuse — so rotation is real and
 *    single-use is not, and storing the new one on every refresh is the safe behaviour either way;
 *  - no `email` claim comes back in the id_token or from userinfo, despite the granted scope; the
 *    display name is what there is, so that is what the UI shows.
 */

/** xAI's shared OAuth client for outside apps. Not ours: xAI hands this id out and hosts the consent screen. */
export const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
/** What the consent screen calls this client. Said in the dialog so the name is not a surprise. */
export const XAI_CONSENT_NAME = 'Grok Build';
export const XAI_ISSUER = 'https://auth.x.ai';
/** The same set every outside client asks for; `api:access` is what makes `api.x.ai` answer. */
export const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';

/** The endpoints, from discovery. The fallbacks are what discovery returned on 2026-09-18. */
export interface XaiEndpoints {
  device: string;
  token: string;
  userinfo?: string;
  revoke?: string;
}

/** The tokens as they sit in the secrets file, under `deskfish.oauth.<host>`, as one JSON string. */
export interface XaiTokens {
  access: string;
  refresh: string;
  /** Epoch ms at which the access token expires. */
  expiresAt: number;
  /** Where to refresh — kept with the tokens so a moved issuer does not strand them. */
  tokenEndpoint: string;
  /** Who this is, for "Signed in as …". xAI gives a display name, not an email. */
  who?: string;
}

/** What `auth.poll` is waiting on, between `auth.start` and the tokens. */
export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Epoch ms after which xAI will refuse the device code. */
  expiresAt: number;
  intervalMs: number;
  endpoints: XaiEndpoints;
}

export type PollState = 'pending' | 'done' | 'expired' | 'denied' | 'gated';

/** The body of a 403 that means "this account may not have sign-in tokens". */
const GATED = /run out of available resources|do not have an active|not have an active grok subscription/i;

export type Fetch = typeof fetch;

function form(fields: Record<string, string>): { method: string; headers: Record<string, string>; body: string } {
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() };
}

/** The whole body (a token answer carries a JWT and is long), and never a throw. */
async function readBody(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return '';
  }
}

/** Never let a provider's HTML error page become a 200 kB error message. */
const shortBody = (body: string) => body.slice(0, 500);

/**
 * The issuer's endpoints. A failed discovery is not fatal — the well-known paths are the ones xAI
 * serves today — so a sign-in still works when only the discovery document is down.
 */
export async function discover(issuer = XAI_ISSUER, f: Fetch = fetch): Promise<XaiEndpoints> {
  const fallback: XaiEndpoints = { device: `${issuer}/oauth2/device/code`, token: `${issuer}/oauth2/token`, userinfo: `${issuer}/oauth2/userinfo`, revoke: `${issuer}/oauth2/revoke` };
  try {
    const r = await f(`${issuer}/.well-known/openid-configuration`);
    if (!r.ok) return fallback;
    const d = (await r.json()) as Record<string, unknown>;
    const pick = (k: string, or: string) => (typeof d[k] === 'string' && d[k] ? (d[k] as string) : or);
    return {
      device: pick('device_authorization_endpoint', fallback.device),
      token: pick('token_endpoint', fallback.token),
      userinfo: pick('userinfo_endpoint', fallback.userinfo!),
      revoke: pick('revocation_endpoint', fallback.revoke!),
    };
  } catch {
    return fallback;
  }
}

/** Step one: ask xAI for a device code. The person then approves it in their own browser. */
export async function startDeviceFlow(opts: { issuer?: string; clientId?: string; scope?: string; fetch?: Fetch; now?: () => number } = {}): Promise<DeviceGrant> {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const endpoints = await discover(opts.issuer ?? XAI_ISSUER, f);
  const r = await f(endpoints.device, form({ client_id: opts.clientId ?? XAI_CLIENT_ID, scope: opts.scope ?? XAI_SCOPE }));
  const startBody = await readBody(r);
  if (r.status === 403) throw new Error(gatedMessage(shortBody(startBody)));
  if (!r.ok) throw new Error(`xAI refused to start the sign-in (HTTP ${r.status} ${shortBody(startBody)})`);
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(startBody) as Record<string, unknown>;
  } catch {
    throw new Error(`xAI answered the sign-in request with something that is not JSON (HTTP ${r.status})`);
  }
  const deviceCode = String(d.device_code ?? '');
  const userCode = String(d.user_code ?? '');
  const verificationUri = String(d.verification_uri_complete ?? d.verification_uri ?? '');
  if (!deviceCode || !userCode || !verificationUri) throw new Error('xAI answered the sign-in request without a device code');
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresAt: now() + Math.max(60, Number(d.expires_in) || 600) * 1000,
    intervalMs: Math.max(1000, (Number(d.interval) || 5) * 1000),
    endpoints,
  };
}

/** The sentence shown when xAI refuses this account. Plain, and it names the way out. */
export function gatedMessage(detail = ''): string {
  const tail = detail.trim() ? ` xAI said: ${detail.trim().slice(0, 200)}` : '';
  return `xAI decides which accounts get sign-in tokens; this one was refused (HTTP 403). You can use an xAI API key instead.${tail}`;
}

/** Whether a failed model call is xAI saying the subscription's pool is spent. */
export function isPoolExhausted(status: number, body: string): boolean {
  return status === 429 || (status === 403 && GATED.test(body));
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

function tokensFrom(a: TokenAnswer, tokenEndpoint: string, previousRefresh: string, now: number): XaiTokens {
  return {
    access: String(a.access_token),
    // A refresh that answers without a new refresh token keeps the old one (xAI does rotate, but the
    // grant is the thing we must not lose).
    refresh: a.refresh_token ? String(a.refresh_token) : previousRefresh,
    expiresAt: now + Math.max(60, Number(a.expires_in) || 3600) * 1000,
    tokenEndpoint,
    ...(a.id_token ? { who: nameFromIdToken(a.id_token) } : {}),
  };
}

/** The display name out of an id_token, without verifying it — it is a label, never a permission. */
export function nameFromIdToken(idToken: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
    for (const k of ['email', 'name', 'preferred_username', 'given_name']) {
      const v = claims[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {
    /* an opaque or malformed id_token: the UI says "Signed in" without a name */
  }
  return undefined;
}

/** One poll of the token endpoint. The caller decides how often; `intervalMs` may grow on `slow_down`. */
export async function pollOnce(grant: DeviceGrant, opts: { clientId?: string; fetch?: Fetch; now?: () => number } = {}): Promise<{ state: PollState; tokens?: XaiTokens; detail?: string; slowDown?: boolean }> {
  const f = opts.fetch ?? fetch;
  const now = (opts.now ?? Date.now)();
  if (now > grant.expiresAt) return { state: 'expired' };
  const r = await f(grant.endpoints.token, form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.deviceCode, client_id: opts.clientId ?? XAI_CLIENT_ID }));
  const body = await readBody(r);
  let a: TokenAnswer = {};
  try {
    a = JSON.parse(body) as TokenAnswer;
  } catch {
    /* not JSON: `error` stays empty and the status decides */
  }
  if (r.ok && a.access_token) return { state: 'done', tokens: tokensFrom(a, grant.endpoints.token, '', now) };
  const err = a.error ?? '';
  if (err === 'authorization_pending') return { state: 'pending' };
  if (err === 'slow_down') return { state: 'pending', slowDown: true };
  if (err === 'expired_token') return { state: 'expired' };
  if (err === 'access_denied') return { state: 'denied' };
  if (r.status === 403) return { state: 'gated', detail: gatedMessage(a.error_description ?? shortBody(body)) };
  return { state: 'denied', detail: a.error_description || err || `HTTP ${r.status} ${shortBody(body)}` };
}

/**
 * A new access token from the refresh token. The rotated refresh token comes back in the result and
 * the caller must store it *before* the call that used it returns — losing it means signing in again.
 */
export async function refreshTokens(tokens: XaiTokens, opts: { clientId?: string; fetch?: Fetch; now?: () => number } = {}): Promise<XaiTokens> {
  const f = opts.fetch ?? fetch;
  const now = (opts.now ?? Date.now)();
  const r = await f(tokens.tokenEndpoint, form({ grant_type: 'refresh_token', client_id: opts.clientId ?? XAI_CLIENT_ID, refresh_token: tokens.refresh }));
  const body = await readBody(r);
  let a: TokenAnswer = {};
  try {
    a = JSON.parse(body) as TokenAnswer;
  } catch {
    /* not JSON */
  }
  if (r.ok && a.access_token) return { ...tokensFrom(a, tokens.tokenEndpoint, tokens.refresh, now), who: tokens.who ?? nameFromIdToken(a.id_token ?? '') };
  if (r.status === 403) throw new Error(gatedMessage(a.error_description ?? shortBody(body)));
  throw new Error(`Your Grok sign-in could not be renewed (HTTP ${r.status}${a.error ? ` ${a.error}` : ''}). Sign in again in Settings.`);
}

/** Tell xAI to forget the grant on sign-out. Best effort: the slot is cleared either way. */
export async function revoke(tokens: XaiTokens, endpoints: XaiEndpoints, opts: { clientId?: string; fetch?: Fetch } = {}): Promise<boolean> {
  if (!endpoints.revoke) return false;
  const f = opts.fetch ?? fetch;
  try {
    const r = await f(endpoints.revoke, form({ client_id: opts.clientId ?? XAI_CLIENT_ID, token: tokens.refresh, token_type_hint: 'refresh_token' }));
    return r.ok;
  } catch {
    return false;
  }
}

/** Refresh this long before the access token expires (xAI issues 6-hour ones). */
export const REFRESH_MARGIN_MS = 60 * 60 * 1000;

/** Whether the access token is close enough to its end to renew it before the next call. */
export function needsRefresh(tokens: XaiTokens, now = Date.now()): boolean {
  return tokens.expiresAt - now <= REFRESH_MARGIN_MS;
}

export function parseTokens(raw: string | undefined): XaiTokens | undefined {
  if (!raw) return undefined;
  try {
    const t = JSON.parse(raw) as Partial<XaiTokens>;
    if (typeof t.access === 'string' && typeof t.refresh === 'string' && typeof t.tokenEndpoint === 'string') {
      return { access: t.access, refresh: t.refresh, expiresAt: Number(t.expiresAt) || 0, tokenEndpoint: t.tokenEndpoint, ...(t.who ? { who: t.who } : {}) };
    }
  } catch {
    /* an old or hand-edited slot: treated as signed out */
  }
  return undefined;
}

export function serializeTokens(t: XaiTokens): string {
  return JSON.stringify(t);
}
