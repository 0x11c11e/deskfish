import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Everything the relay remembers — which is as little as a relay can remember and still be one:
 * a username against the public key that may hold its uplink, the enrolment codes not yet spent,
 * and a daily count of seconds and bytes so whoever runs it can bill and cap. No frame, no message,
 * no address, nothing a session contained.
 *
 * It is an interface with one implementation on purpose. `JsonUsers` is a file, which is right for
 * one person's own relay; a service would put SQLite or a hosted database behind the same five
 * methods and change nothing in the forwarding code, which is the part that must stay dull.
 *
 * ```
 * get(username)                      → { username, publicKey, enrolledAt } | undefined
 * claim(username, publicKey, code)   → the same, or throws with the reason
 * revoke(username)                   → true when there was one
 * mintCode(username?)                → a one-time code (an operator's only power over enrolment)
 * addUsage(username, seconds, up, down)
 * usage(username)                    → { username, days: { 'YYYY-MM-DD': {seconds, up, down} } }
 * ```
 */

/** A username: lowercase, starts with a letter or digit, 3 to 32 characters. */
export const USERNAME = /^[a-z0-9][a-z0-9-]{2,31}$/;

/** An Ed25519 public key as base64url of 32 raw bytes, or a base64 SPKI — both are 40-90 characters. */
const PUBLIC_KEY = /^[A-Za-z0-9+/_-]{40,120}={0,2}$/;

const today = () => new Date().toISOString().slice(0, 10);

export class JsonUsers {
  #file;
  #data;

  constructor(file) {
    this.#file = file;
    this.#data = { users: {}, codes: {}, usage: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      this.#data = { users: parsed.users ?? {}, codes: parsed.codes ?? {}, usage: parsed.usage ?? {} };
    } catch {
      /* nothing enrolled yet */
    }
  }

  /**
   * Fail at the start rather than at the first enrolment. A rootless container given a bind mount
   * cannot usually write to it — the user inside is not the user who owns the folder outside — and
   * the raw EACCES that comes back hours later, from a `curl` that looks like it should work, is not
   * an answer anybody can act on.
   */
  checkWritable() {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const probe = `${this.#file}.probe`;
      writeFileSync(probe, '', { mode: 0o600 });
      rmSync(probe, { force: true });
    } catch (err) {
      throw new Error(
        `the relay cannot write to ${dirname(this.#file)} (${err?.code ?? err?.message ?? err}). ` +
          'Give it a named volume rather than a folder of your own: a rootless container runs as a user your host does not share, ' +
          'so a bind mount it did not create is not its to write. `podman volume create deskfish-relay-data` and `-v deskfish-relay-data:/data`, ' +
          'or chown the folder to the container user first.',
      );
    }
  }

  #write() {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data, null, 1) + '\n', { mode: 0o600 });
    renameSync(tmp, this.#file);
  }

  get(username) {
    return this.#data.users[username];
  }

  /** An operator's one power over enrolment: mint a code. Optionally tied to a username in advance. */
  mintCode(username) {
    if (username !== undefined && !USERNAME.test(username)) throw new Error('that is not a username');
    const code = randomBytes(16).toString('base64url');
    this.#data.codes[code] = { username: username ?? null, mintedAt: new Date().toISOString() };
    this.#write();
    return code;
  }

  /**
   * Spend a code and take a username. A username is claimed once, globally on this relay: taking it
   * again needs a revoke first, so nobody enrols over somebody else's name with a fresh code.
   */
  claim(username, publicKey, code) {
    if (!USERNAME.test(username)) throw new Error('a username is 3 to 32 characters: lowercase letters, digits and dashes, starting with a letter or a digit');
    if (!PUBLIC_KEY.test(publicKey)) throw new Error('that is not a public key');
    const entry = code && Object.prototype.hasOwnProperty.call(this.#data.codes, code) ? this.#data.codes[code] : undefined;
    if (!entry) throw new Error('that enrolment code is not one of ours, or it has been used already');
    if (entry.username && entry.username !== username) throw new Error(`that enrolment code is for ${entry.username}`);
    if (this.#data.users[username]) throw new Error(`${username} is taken on this relay`);
    delete this.#data.codes[code];
    const user = { username, publicKey, enrolledAt: new Date().toISOString() };
    this.#data.users[username] = user;
    this.#write();
    return user;
  }

  revoke(username) {
    if (!this.#data.users[username]) return false;
    delete this.#data.users[username];
    this.#write();
    return true;
  }

  /** Daily totals, added to as sessions end. Seconds connected and bytes each way, and nothing else. */
  addUsage(username, seconds, up, down) {
    const day = today();
    const days = (this.#data.usage[username] ??= {});
    const row = (days[day] ??= { seconds: 0, up: 0, down: 0 });
    row.seconds += Math.round(seconds);
    row.up += up;
    row.down += down;
    this.#write();
  }

  usage(username) {
    return { username, days: this.#data.usage[username] ?? {} };
  }
}

/** Constant-time string comparison, for the admin key. */
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    // Still do the work, so the answer takes the same time either way.
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}
