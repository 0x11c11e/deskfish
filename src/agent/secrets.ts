/**
 * Credentials that must never land in a log, a transcript or the chat. The model still receives
 * the real text (it needs it to work); everything that is written down or shown is masked here.
 *
 * Why: on 2026-09-13 she pasted two GitHub tokens into push URLs and one into a reply, and they
 * ended up in the daemon log, the output channel and the saved transcript. Pure Node, no vscode.
 */

/** Well-known token shapes, masked whole (a recognisable prefix is kept so the log still reads). */
const TOKENS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub classic tokens: ghp_ gho_ ghu_ ghs_ ghr_
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic (sk-ant-…), OpenRouter (sk-or-v1-…)
  /\bxai-[A-Za-z0-9]{20,}/g, // xAI
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/** `Authorization: Bearer …` and friends. */
const AUTH_HEADER = /(\b(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{16,}/g;
/** `scheme://user:secret@host` — the way a token ends up on a git push line. */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@/]+(@)/gi;
/** `TOKEN=…`, `--password=…`, `api_key = '…'`: shell, env and query-string style. */
const KEY_EQUALS = /(\b(?:[A-Za-z0-9_-]*(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]*)\s*=\s*["']?)([^\s"'&;]{6,})/gi;
/**
 * The sign-in tokens as they are serialized into their slot (`{"access":"…","refresh":"…"}`). The
 * access token is a JWT and is caught above; `refresh` is opaque at xAI and its field name carries
 * none of the words below, so it gets a pattern of its own. Quoted and 16+ characters, so ordinary
 * prose ("access: public") is left alone.
 */
const OAUTH_FIELDS = /(["'](?:access|refresh)["']\s*:\s*["'])([^"']{16,})(["'])/g;
/** `"token": "…"` in JSON and `oauth_token: …` / `password: …` on a line of YAML or config. */
const KEY_COLON = /((?:^|[\s{,])["']?(?:[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]*)["']?\s*:\s*["']?)([^\s"',}]{6,})/gim;
/** "the password is …" in prose (she and the user both typed one into the chat once). */
const PROSE = /(\bpassword\s+(?:is|was|will be)\s+["'“]?)([^\s"'”]{6,})/gi;

/** A value looks like a credential rather than a word: digits or symbols in it, or long. */
function secretish(value: string): boolean {
  return value.length >= 16 || /[0-9@#$%^&*+/=_-]/.test(value);
}

function keepPrefix(match: string): string {
  const m = match.match(/^([A-Za-z]{2,5}[_-])/);
  return `${m ? m[1] : match.slice(0, 4)}***`;
}

/** Mask every credential this module recognises. Idempotent; leaves ordinary text alone. */
export function maskSecrets(text: string): string {
  if (!text || text.length < 6) return text;
  let out = text;
  for (const re of TOKENS) out = out.replace(re, keepPrefix);
  out = out.replace(AUTH_HEADER, '$1***');
  out = out.replace(OAUTH_FIELDS, '$1***$3');
  out = out.replace(URL_CREDENTIALS, '$1***$2');
  out = out.replace(KEY_EQUALS, (m, k: string, v: string) => (secretish(v) ? `${k}***` : m));
  out = out.replace(KEY_COLON, (m, k: string, v: string) => (secretish(v) ? `${k}***` : m));
  out = out.replace(PROSE, (m, k: string, v: string) => (secretish(v) ? `${k}***` : m));
  return out;
}

/** Whether masking would change the text. */
export function hasSecret(text: string): boolean {
  return maskSecrets(text) !== text;
}

/**
 * A copy of any event/object with every string masked. Keys in `skip` (image data) are passed
 * through untouched; Buffers too. Used on every event the loop emits, so the chat, the output
 * log and the transcript all see the masked text and the model's copy is the only real one.
 */
export function maskDeep<T>(value: T, skip: ReadonlySet<string> = SKIP_KEYS): T {
  if (typeof value === 'string') return maskSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, skip)) as unknown as T;
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = skip.has(k) ? v : maskDeep(v, skip);
    return out as T;
  }
  return value;
}

const SKIP_KEYS: ReadonlySet<string> = new Set(['jpegBase64', 'jpeg', 'png', 'image']);
