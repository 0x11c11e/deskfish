// Credentials never reach a log, the chat or a transcript: the masker recognises the common token
// shapes, URL credentials, headers and key=value pairs, leaves prose alone, masks every string in
// an event (image data untouched), and the transcript writer masks on the way to disk.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasSecret, maskDeep, maskSecrets } from '../src/agent/secrets';
import { ChatTranscript } from '../src/agent/chats';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };
const eq = (a: string, b: string, m: string) => { assert.equal(a, b, m); n++; };

const GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
const PAT = 'github_pat_' + '11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789_ABCDEFGHIJ';
const SK = 'sk-ant-api03-' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
const OR = 'sk-or-v1-' + '0123456789abcdef0123456789abcdef0123456789abcdef';
const XAI = 'xai-' + 'abcdefghijklmnopqrstuvwxyz0123456789';

// ---------- token shapes ----------
eq(maskSecrets(`git push https://deskfish-sh:${GH}@github.com/deskfish-sh/deskfish.git main`), 'git push https://deskfish-sh:***@github.com/deskfish-sh/deskfish.git main', 'a token in a push URL is masked whole');
eq(maskSecrets(`export GH_TOKEN=${GH}`), 'export GH_TOKEN=***', 'a token in an env assignment');
eq(maskSecrets(`the token is ${GH}, keep it`), 'the token is ghp_***, keep it', 'a bare GitHub token keeps its prefix');
eq(maskSecrets(PAT), 'gith***', 'a fine-grained GitHub token');
eq(maskSecrets(`ANTHROPIC_API_KEY=${SK}`), 'ANTHROPIC_API_KEY=***', 'an Anthropic key');
eq(maskSecrets(`Authorization: Bearer ${OR}`), 'Authorization: Bearer sk-***', 'a bearer header with a known token shape keeps the prefix');
eq(maskSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'), 'Authorization: Bearer ***', 'a bearer header with an unknown token is masked whole');
eq(maskSecrets(`curl -H "x-api-key: ${XAI}"`), 'curl -H "x-api-key: ***"', 'an xAI key after a colon');
eq(maskSecrets('keys AKIAIOSFODNN7EXAMPLE and AIzaSyA-1234567890abcdefghijklmnopqrstu here'), 'keys AKIA*** and AIza*** here', 'AWS and Google keys');
eq(maskSecrets('oauth_token: gho_' + 'abcdefghijklmnopqrstuvwxyz0123456789'), 'oauth_token: ***', 'gh hosts.yml style');
eq(maskSecrets('{"token":"' + 'p4ssw0rd-with-symbols' + '","user":"bot"}'), '{"token":"***","user":"bot"}', 'JSON key/value');
eq(maskSecrets('I made the account and the password is DEskfish@12 so log in'), 'I made the account and the password is *** so log in', 'a password said in prose');
eq(maskSecrets(`https://${GH}@github.com/x/y`), 'https://ghp_***@github.com/x/y', 'a token alone before @');
eq(maskSecrets('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'), 'eyJh***', 'a JWT');

// ---------- prose stays prose ----------
for (const plain of [
  'API key: stored in your keychain',
  'the password is saved in Firefox, not here',
  'password: the six-digit code on your phone',
  'author=Iman Reihanian wrote the token parser',
  'run: npm test → exit 0 · 48.1 s · 30 lines',
  'Set-Cookie headers, tokens and secrets are common words',
  'She read about:logins and copied the saved password.',
  'https://example.com/path?q=deskfish&page=2',
  'ssh-keygen -t ed25519',
]) eq(maskSecrets(plain), plain, `untouched: ${plain}`);
ok(!hasSecret('nothing here') && hasSecret(`token=${GH}`), 'hasSecret');
eq(maskSecrets(maskSecrets(`x ${GH} y`)), maskSecrets(`x ${GH} y`), 'idempotent');

// ---------- events ----------
const jpegBase64 = 'ZmFrZQ==';
const ev = maskDeep({
  type: 'action', step: 3,
  action: { type: 'run_command', command: `git push https://deskfish-sh:${GH}@github.com/deskfish-sh/deskfish.git`, timeoutSeconds: 60 },
  result: { ok: true, message: 'exit 0 · 1.2 s · 2 lines', command: { stdout: `remote: token ${GH} accepted`, stderr: '', exit: 0, ms: 1200, timedOut: false }, image: Buffer.from('abc') },
  jpegBase64,
});
ok(ev.action.command === 'git push https://deskfish-sh:***@github.com/deskfish-sh/deskfish.git' && ev.result.command.stdout === 'remote: token ghp_*** accepted', 'every string in an action event is masked');
ok(ev.jpegBase64 === jpegBase64 && Buffer.isBuffer(ev.result.image) && ev.result.command.exit === 0 && ev.step === 3, 'image data, buffers and numbers pass through');
const typed = maskDeep({ type: 'action', step: 1, action: { type: 'type', text: `${SK}\n` }, result: { ok: true } });
ok(typed.action.text === 'sk-***\n', 'text typed on the desktop is masked in the event');

// ---------- transcript ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskfish-secrets-'));
const file = path.join(dir, 'chat.md');
fs.writeFileSync(file, '# Chat\n\n');
const t = new ChatTranscript(file);
t.user(`the password is DEskfish@12 and the token ${GH}`);
t.action(1, `run: git push https://x:${GH}@github.com/a/b`, true);
t.assistant(`Done. I used ${GH} to push.`);
const text = fs.readFileSync(file, 'utf8');
ok(!text.includes(GH) && !text.includes('DEskfish@12'), 'no credential in the transcript');
ok(text.includes('password is ***') && text.includes('https://x:***@github.com') && text.includes('I used ghp_*** to push'), `masked forms are there: ${text.split('\n').filter((l) => l.includes('***')).length} lines`);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`secrets: ${n} checks passed`);
