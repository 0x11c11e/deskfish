// "Sign in with Grok" (src/gateway/xaiOauth.ts) against a fake auth.x.ai: discovery, the device
// code, every RFC 8628 poll answer, the 403 account gate, refresh rotation, and the token slot's
// round trip through the secrets file. Plus the two halves that live elsewhere: the masker on a
// JWT and on the serialized token blob, and the adapter's one retry after a 401.
// Self-contained: a Node http server in-process, a temp data dir, no network and no container.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRunner, type AgentEvent } from '../src/agent/loop';
import { DesktopDaemonComputer } from '../src/computer/daemon';
import { isPoolExhaustedError, PoolExhaustedError, type ModelAdapter } from '../src/agent/adapters/types';
import { maskSecrets } from '../src/agent/secrets';
import { OpenAICompatAdapter } from '../src/agent/adapters/openaiCompat';
import { SecretsFile } from '../src/gateway/storage';
import { discover, isPoolExhausted, nameFromIdToken, needsRefresh, parseTokens, pollOnce, refreshTokens, revoke, serializeTokens, startDeviceFlow, XAI_CLIENT_ID, XAI_SCOPE, type XaiTokens } from '../src/gateway/xaiOauth';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (c: unknown, m: string) => {
  assert.ok(c, m);
  n++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A token shaped like the real thing: three base64url parts, header and payload both `eyJ…`. */
const jwt = (claims: Record<string, unknown>) => `${b64({ typ: 'at+jwt', alg: 'ES256', kid: 'oauth2-production' })}.${b64(claims)}.${'AbCdEfGhIjKlMnOpQrStUv'}`;

/* ---------- the fake auth.x.ai ---------- */

interface Script {
  /** What the token endpoint answers, in order; the last entry repeats. */
  token: { status: number; body: unknown }[];
  device?: { status: number; body: unknown };
}
const script: Script = { token: [] };
/** Every request the fake saw: [path, parsed form body]. */
const seen: [string, Record<string, string>][] = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url ?? '';
    seen.push([url, Object.fromEntries(new URLSearchParams(body))]);
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    if (url.startsWith('/.well-known/openid-configuration')) {
      return send(200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth2/authorize`,
        device_authorization_endpoint: `${base}/oauth2/device/code`,
        token_endpoint: `${base}/oauth2/token`,
        userinfo_endpoint: `${base}/oauth2/userinfo`,
        revocation_endpoint: `${base}/oauth2/revoke`,
      });
    }
    if (url.startsWith('/oauth2/device/code')) {
      const d = script.device ?? { status: 200, body: { device_code: 'DEV-1', user_code: '6VV5-EQWA', verification_uri: `${base}/device`, verification_uri_complete: `${base}/device?user_code=6VV5-EQWA`, expires_in: 1800, interval: 5 } };
      return send(d.status, d.body);
    }
    if (url.startsWith('/oauth2/token')) {
      const step = script.token.length > 1 ? script.token.shift()! : script.token[0];
      return send(step.status, step.body);
    }
    if (url.startsWith('/oauth2/revoke')) return send(200, {});
    return send(404, { error: 'not found' });
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

/* ---------- discovery ---------- */

const endpoints = await discover(base);
ok(endpoints.token === `${base}/oauth2/token` && endpoints.device === `${base}/oauth2/device/code` && endpoints.revoke === `${base}/oauth2/revoke`, 'discovery: the endpoints come from the issuer, not from a hard-coded path');

const offline = await discover('http://127.0.0.1:1/nope');
ok(offline.token === 'http://127.0.0.1:1/nope/oauth2/token' && offline.device.endsWith('/oauth2/device/code'), 'discovery: a failure falls back to the well-known paths rather than stopping a sign-in');

/* ---------- the device code ---------- */

seen.length = 0;
const grant = await startDeviceFlow({ issuer: base });
ok(grant.userCode === '6VV5-EQWA' && grant.verificationUri.includes('user_code=6VV5-EQWA') && grant.intervalMs === 5000, 'device code: the code, the complete URL and the interval come back');
ok(grant.expiresAt > Date.now() + 1700_000, 'device code: expires_in becomes an absolute deadline');
const deviceReq = seen.find(([u]) => u.startsWith('/oauth2/device/code'))![1];
ok(deviceReq.client_id === XAI_CLIENT_ID && deviceReq.scope === XAI_SCOPE, "device code: xAI's shared client id and the full scope are what is asked for");

script.device = { status: 403, body: { error: 'forbidden', error_description: 'You have either run out of available resources or do not have an active Grok subscription' } };
await assert.rejects(() => startDeviceFlow({ issuer: base }), /xAI decides which accounts get sign-in tokens/, 'device code: a 403 at the very start is the account gate, in the sentence the UI shows');
n++;
script.device = undefined;

/* ---------- polling: every answer RFC 8628 has ---------- */

const g = await startDeviceFlow({ issuer: base });

script.token = [{ status: 400, body: { error: 'authorization_pending' } }];
ok((await pollOnce(g)).state === 'pending', 'poll: authorization_pending keeps waiting');

script.token = [{ status: 400, body: { error: 'slow_down' } }];
const slow = await pollOnce(g);
ok(slow.state === 'pending' && slow.slowDown === true, 'poll: slow_down waits too, and says to poll less often');

script.token = [{ status: 400, body: { error: 'access_denied' } }];
ok((await pollOnce(g)).state === 'denied', 'poll: access_denied is a refusal');

script.token = [{ status: 400, body: { error: 'expired_token' } }];
ok((await pollOnce(g)).state === 'expired', 'poll: expired_token ends the attempt');

script.token = [{ status: 403, body: { error: 'forbidden', error_description: 'You have either run out of available resources or do not have an active Grok subscription' } }];
const gated = await pollOnce(g);
ok(gated.state === 'gated' && /xAI decides which accounts get sign-in tokens; this one was refused \(HTTP 403\)\. You can use an xAI API key instead\./.test(gated.detail ?? ''), 'poll: a 403 is the account gate, with the exact sentence the plan specifies');

ok((await pollOnce({ ...g, expiresAt: Date.now() - 1 })).state === 'expired', 'poll: a device code past its deadline is expired without asking xAI again');

// …and the one that succeeds. xAI returns no `email` claim, so the display name is what is shown.
const access = jwt({ iss: base, sub: 'e98b72e6', exp: Math.floor(Date.now() / 1000) + 21600, tier: 1 });
script.token = [{ status: 200, body: { access_token: access, refresh_token: 'rt-first-0123456789abcdef', token_type: 'Bearer', expires_in: 21600, scope: XAI_SCOPE, id_token: jwt({ name: 'Solvoryn' }) } }];
const done = await pollOnce(g);
ok(done.state === 'done' && done.tokens?.access === access && done.tokens?.refresh === 'rt-first-0123456789abcdef', 'poll: the grant comes back as both tokens');
ok(done.tokens!.who === 'Solvoryn' && done.tokens!.expiresAt > Date.now() + 21_000_000, 'poll: the display name rides along (xAI sends no email) and the 6-hour life becomes a deadline');
ok(nameFromIdToken(jwt({ email: 'a@b.c', name: 'Ignored' })) === 'a@b.c' && nameFromIdToken('not-a-jwt') === undefined, 'the name: an email wins when there is one, and a malformed id_token is simply nameless');

/* ---------- refresh: it rotates, and the new one is what is kept ---------- */

const first = done.tokens!;
script.token = [{ status: 200, body: { access_token: jwt({ iss: base, n: 2 }), refresh_token: 'rt-second-fedcba9876543210', token_type: 'Bearer', expires_in: 21600 } }];
const second = await refreshTokens(first);
ok(second.refresh === 'rt-second-fedcba9876543210' && second.access !== first.access, 'refresh: a new access token and the rotated refresh token');
ok(second.who === 'Solvoryn', 'refresh: the name survives a refresh (xAI sends no id_token on one)');

script.token = [{ status: 200, body: { access_token: jwt({ iss: base, n: 3 }), token_type: 'Bearer', expires_in: 21600 } }];
const third = await refreshTokens(second);
ok(third.refresh === second.refresh, 'refresh: an answer without a new refresh token keeps the old one rather than losing the grant');

script.token = [{ status: 403, body: { error: 'forbidden', error_description: 'do not have an active Grok subscription' } }];
await assert.rejects(() => refreshTokens(third), /xAI decides which accounts get sign-in tokens/, 'refresh: a 403 later is the same gate, said the same way');
n++;
script.token = [{ status: 400, body: { error: 'invalid_grant' } }];
await assert.rejects(() => refreshTokens(third), /Sign in again/, 'refresh: any other failure tells the person to sign in again');
n++;

ok(needsRefresh({ ...first, expiresAt: Date.now() + 30 * 60 * 1000 }) && !needsRefresh({ ...first, expiresAt: Date.now() + 5 * 60 * 60 * 1000 }), 'refresh: renewed with under an hour left, not with five hours left');

ok((await revoke(first, endpoints)) === true && (await revoke(first, { device: '', token: '' })) === false, 'sign out: the revocation endpoint is called when there is one, and its absence is not an error');

/* ---------- the slot: a round trip through secrets.json, 0600 ---------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-oauth-'));
const file = path.join(dir, 'secrets.json');
const secrets = new SecretsFile(file);
secrets.set('deskfish.oauth.api.x.ai', serializeTokens(first));
const back = parseTokens(secrets.get('deskfish.oauth.api.x.ai'));
ok(back?.access === first.access && back?.refresh === first.refresh && back?.tokenEndpoint === first.tokenEndpoint && back?.who === 'Solvoryn', 'slot: the tokens round-trip through the secrets file unchanged');
ok((fs.statSync(file).mode & 0o077) === 0, 'slot: the tokens land in a file only their owner can read (0600)');
ok(secrets.slots().includes('deskfish.oauth.api.x.ai') && !secrets.slots().includes('deskfish.apiKey.api.x.ai'), 'slot: the sign-in has a slot of its own, beside any API key');
secrets.set('deskfish.apiKey.api.x.ai', 'xai-1234567890abcdefghijklmn');
secrets.set('deskfish.oauth.api.x.ai', undefined);
ok(secrets.get('deskfish.apiKey.api.x.ai') === 'xai-1234567890abcdefghijklmn' && secrets.get('deskfish.oauth.api.x.ai') === undefined, 'slot: signing out leaves an xAI API key that was there before untouched');
ok(parseTokens(undefined) === undefined && parseTokens('not json') === undefined && parseTokens('{"access":"a"}') === undefined, 'slot: an empty, broken or half-written slot reads as signed out');
fs.rmSync(dir, { recursive: true, force: true });

/* ---------- the masker: neither token can reach a log ---------- */

ok(maskSecrets(`bearer is ${access}`).includes('***') && !maskSecrets(`bearer is ${access}`).includes(access.split('.')[1]), 'masker: an access token (a JWT) is masked wherever it appears');
const blob = serializeTokens(first);
ok(!maskSecrets(blob).includes(first.refresh) && !maskSecrets(blob).includes(first.access), 'masker: the serialized slot leaks neither the access nor the opaque refresh token');
ok(maskSecrets('access: public') === 'access: public' && maskSecrets('the refresh rate is 60') === 'the refresh rate is 60', 'masker: ordinary prose with those words is left alone');

/* ---------- the pool: 429 and the 403 body xAI uses ---------- */

ok(isPoolExhausted(429, '{}') && isPoolExhausted(403, 'You have either run out of available resources or do not have an active Grok subscription'), 'pool: a 429, and a 403 carrying that body, both mean the pool');
ok(!isPoolExhausted(403, 'invalid token') && !isPoolExhausted(401, 'run out of available resources'), 'pool: another 403, or a 401, is not the pool');

/* ---------- the adapter: one fresh bearer after a 401, and the pool as a PoolExhaustedError ---------- */

let handed: string[] = [];
let bodies: string[] = [];
let calls = 0;
const models = http.createServer((req, res) => {
  calls++;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    handed.push(String(req.headers.authorization ?? ''));
    bodies.push(body);
    const reply = modelScript(calls);
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
});
let modelScript: (call: number) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
await new Promise<void>((r) => models.listen(0, '127.0.0.1', r));
const modelsUrl = `http://127.0.0.1:${(models.address() as { port: number }).port}/v1`;

const obs = { image: { jpeg: Buffer.from('jpeg'), width: 1280, height: 800 }, results: [] } as never;
const answer = { choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };

// A 401 mid-task: the adapter asks for a fresh bearer (force = true) and tries once more.
let forced: boolean[] = [];
modelScript = (call) => (call === 1 ? { status: 401, body: { error: 'expired' } } : { status: 200, body: answer });
const a1 = new OpenAICompatAdapter({
  provider: 'openai-compatible',
  model: 'grok-4.6',
  baseUrl: modelsUrl,
  bearer: async (force?: boolean) => {
    forced.push(!!force);
    return force ? 'token-after-refresh' : 'token-stale';
  },
});
a1.start('task', { width: 1280, height: 800 });
const turn = await a1.step(obs);
ok(turn.done && calls === 2 && handed[0] === 'Bearer token-stale' && handed[1] === 'Bearer token-after-refresh', 'adapter: a 401 buys one retry, with a bearer it asked to be refreshed');
ok(forced.length === 2 && forced[0] === false && forced[1] === true, 'adapter: the retry is the only call that forces a refresh');

// A second 401 is not retried again: it becomes the sign-in error, not an endless loop.
calls = 0;
handed = [];
forced = [];
modelScript = () => ({ status: 401, body: { error: 'expired' } });
const a2 = new OpenAICompatAdapter({ provider: 'openai-compatible', model: 'grok-4.6', baseUrl: modelsUrl, bearer: async () => 'tok' });
a2.start('task', { width: 1280, height: 800 });
await assert.rejects(() => a2.step(obs), /refused the Grok sign-in \(HTTP 401\)/, 'adapter: a second 401 stops, and says to sign in again rather than "set an API key"');
n++;
ok(calls === 2, 'adapter: exactly one retry, never a loop');

// The pool: the 403 body and a 429 both surface as the error the loop turns into a knock.
calls = 0;
modelScript = () => ({ status: 403, body: { error: 'You have either run out of available resources or do not have an active Grok subscription' } });
const a3 = new OpenAICompatAdapter({ provider: 'openai-compatible', model: 'grok-4.6', baseUrl: modelsUrl, bearer: async () => 'tok' });
a3.start('task', { width: 1280, height: 800 });
await assert.rejects(() => a3.step(obs), (err: unknown) => isPoolExhaustedError(err) && /pool is used up/.test(err.message), 'adapter: the pool 403 is a PoolExhaustedError, never a plain failure');
n++;
calls = 0;
modelScript = () => ({ status: 429, body: { error: 'rate limited' } });
const a4 = new OpenAICompatAdapter({ provider: 'openai-compatible', model: 'grok-4.6', baseUrl: modelsUrl, bearer: async () => 'tok' });
a4.start('task', { width: 1280, height: 800 });
await assert.rejects(() => a4.step(obs), (err: unknown) => isPoolExhaustedError(err), 'adapter: a 429 on a sign-in is the pool too');
n++;

// The step the pool refused is tried again after the knock, and the adapter's history must read as
// if the refused call never happened: one copy of the task message, then one copy of each tool
// result — never two (a conversation xAI would refuse, or answer from a corrupted context).
calls = 0;
bodies = [];
const toolTurn = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'computer', arguments: '{"action":"screenshot"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const pool = { status: 403, body: { error: 'You have either run out of available resources or do not have an active Grok subscription' } };
modelScript = (call) => (call === 1 ? pool : call === 2 ? { status: 200, body: toolTurn } : call === 3 ? pool : { status: 200, body: answer });
const a6 = new OpenAICompatAdapter({ provider: 'openai-compatible', model: 'grok-4.6', baseUrl: modelsUrl, bearer: async () => 'tok' });
a6.start('task', { width: 1280, height: 800 });
a6.addUserMessage('hurry');
await assert.rejects(() => a6.step(obs), isPoolExhaustedError, 'retry: the first call is refused by the pool');
n++;
const t2 = await a6.step(obs);
const m2 = JSON.parse(bodies[1]).messages as { role: string; content: unknown }[];
ok(t2.actions.length === 1 && m2.filter((m) => m.role === 'user').length === 1 && JSON.stringify(m2[m2.length - 1].content).includes('User: hurry'), `retry after the knock: one task message, and the queued user text survived (${m2.map((m) => m.role).join(',')})`);
await assert.rejects(() => a6.step({ ...(obs as object), results: [{ ok: true }] } as never), isPoolExhaustedError, 'retry: the call after a tool turn is refused by the pool');
n++;
const t4 = await a6.step({ ...(obs as object), results: [{ ok: true }] } as never);
const m4 = JSON.parse(bodies[3]).messages as { role: string; tool_call_id?: string }[];
ok(t4.done && m4.filter((m) => m.role === 'tool').length === 1 && m4.filter((m) => m.role === 'user').length === 2, `retry after a tool turn: exactly one tool result and one screenshot per step, no duplicates (${m4.map((m) => m.role).join(',')})`);

// The same 403, with an API key instead of a sign-in, stays the old error: no key path changed.
calls = 0;
modelScript = () => ({ status: 403, body: { error: 'You have either run out of available resources' } });
const a5 = new OpenAICompatAdapter({ provider: 'openai-compatible', model: 'grok-4.6', baseUrl: modelsUrl, apiKey: 'xai-key' });
a5.start('task', { width: 1280, height: 800 });
await assert.rejects(() => a5.step(obs), (err: unknown) => !isPoolExhaustedError(err) && /rejected the API key/.test((err as Error).message), 'adapter: an API key sees the error it always saw — the pool path belongs to the sign-in alone');
n++;

/* ---------- the loop: a spent pool is a knock on the glass, never a silent switch ---------- */

// The real runner against the mock daemon, with an adapter that answers the pool's 403 once. The
// person "hands back" (resume) and the same step is tried again — the run must finish, and the
// chat must carry the knock with the pool's own words.
const mockPort = 9975;
const mock = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-daemon.mjs')], { env: { ...process.env, MOCK_PORT: String(mockPort) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
try {
  let step = 0;
  const adapter = {
    name: 'scripted',
    start() {},
    addUserMessage() {},
    async step() {
      step++;
      if (step === 2) throw new PoolExhaustedError("Your Grok subscription's pool is used up. Say when to continue, or switch to an API key in Settings.");
      if (step >= 3) return { text: 'Finished after you handed back.', actions: [], done: true };
      return { text: '', actions: [{ type: 'click', x: 100, y: 200, button: 'left', count: 1 }], done: false };
    },
  } as unknown as ModelAdapter;
  const events: AgentEvent[] = [];
  const runner = new AgentRunner({ computer: new DesktopDaemonComputer(`http://127.0.0.1:${mockPort}`), adapter, maxSteps: 8, settleMs: 0, onEvent: (e) => events.push(e) });
  const run = runner.run('a task on the subscription');
  // The knock: the loop pauses and waits for a person, exactly as it does for a login.
  await until(() => events.some((e) => e.type === 'needs_user'), 'the knock');
  const knock = events.find((e) => e.type === 'needs_user') as Extract<AgentEvent, { type: 'needs_user' }>;
  ok(/pool is used up/.test(knock.reason) && /switch to an API key in Settings/.test(knock.reason), 'loop: the spent pool knocks on the glass with the pool\'s own sentence');
  await until(() => runner.currentStatus === 'paused', 'the loop to settle into paused');
  ok(runner.currentStatus === 'paused', 'loop: it waits for the person rather than ending the task');
  ok(step === 2, 'loop: nothing was retried behind the person\'s back while it waited');
  runner.resume();
  await run;
  const last = events.filter((e) => e.type === 'status').pop() as Extract<AgentEvent, { type: 'status' }>;
  ok(last.status === 'done' && step === 3, 'loop: handing back retries the step the pool refused, and the task finishes');
  ok(!events.some((e) => e.type === 'status' && e.status === 'error'), 'loop: a spent pool is never an error, and never a quiet switch to a paid key');
} finally {
  mock.kill();
}

server.close();
models.close();
console.log(`oauth: ${n} checks passed`);
