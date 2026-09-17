import { DEFAULT_CONFIG, type DeskfishConfig } from './config';
import { CONFIG_KEYS, SETTINGS_KEYS } from './settingsSchema';

/**
 * One source of truth for settings (gateway plan step 6): the gateway's `config.json` is what she
 * runs on; VS Code's user settings mirror it. The rules, pure so they are tested without VS Code:
 *
 * - **Connect.** A gateway that has never saved a config is seeded once with VS Code's settings.
 *   Otherwise nothing is pushed, and every setting that differs from the gateway's is written.
 * - **A setting changed in VS Code** → only the keys that change names, and only where they differ
 *   from the gateway's last config, go out as one `config.set`.
 * - **A `config` event** (from any client) → only the keys that changed on the gateway, and only where
 *   they differ from the settings, are written.
 *
 * Why "only the keys that changed" both ways: a web save of two keys is written into settings.json one
 * key at a time, and the echo of the first write would otherwise find the second still old and push the
 * old value back; the model picker's three writes race their three events the same way. The echo of
 * a mirror write finds the setting equal to the gateway's value and pushes nothing — no ping-pong.
 * Only user (Global) settings take part: a workspace value is outside the mirror in both directions.
 *
 * **Edits made while VS Code was closed** (step 6B): the host keeps a *base*, the last config both sides
 * agreed on, and a connect merges per key — settings changed since the base and the gateway not →
 * pushed; the gateway changed and settings not → written; both changed to different values → the
 * gateway wins, one log line naming the setting. Without a base (a first connect) the gateway wins
 * every differing key, as before. The base is stored after every connect, push and `config` event.
 */

export type ConfigKey = keyof DeskfishConfig;

/** The keys whose values differ, optionally only among `keys`. */
export function changedKeys(prev: DeskfishConfig, next: DeskfishConfig, keys: readonly ConfigKey[] = CONFIG_KEYS): ConfigKey[] {
  return keys.filter((k) => prev[k] !== next[k]);
}

/** A patch of the keys (optionally only among `keys`) whose values differ; `{}` when nothing does. */
export function patchBetween(prev: DeskfishConfig, next: DeskfishConfig, keys?: readonly ConfigKey[]): Partial<DeskfishConfig> {
  const patch: Record<string, unknown> = {};
  for (const k of changedKeys(prev, next, keys)) patch[k] = next[k];
  return patch as Partial<DeskfishConfig>;
}

export interface SettingWrite {
  key: ConfigKey;
  setting: string;
  /** `undefined` removes the setting (the gateway's value is the default). */
  value: DeskfishConfig[ConfigKey] | undefined;
}

/** The settings writes that make VS Code's settings equal the gateway's config (optionally only among `keys`). */
export function writesFor(gateway: DeskfishConfig, settings: DeskfishConfig, defaults: DeskfishConfig = DEFAULT_CONFIG, keys?: readonly ConfigKey[]): SettingWrite[] {
  return changedKeys(settings, gateway, keys).map((key) => ({ key, setting: SETTINGS_KEYS[key], value: gateway[key] === defaults[key] ? undefined : gateway[key] }));
}

/** What the sync needs from its host (the controller in VS Code; fakes in the tests). */
export interface ConfigSyncIo {
  /** VS Code's user settings as a config (a missing setting reads as its default). */
  readSettings(): DeskfishConfig;
  /** `config.set {patch}`; rejects with the gateway's refusal. */
  push(patch: Partial<DeskfishConfig>): Promise<unknown>;
  /** Write one user setting. */
  write(w: SettingWrite): Promise<void>;
  /** The API key for this config's provider, when this host holds one. */
  pushKey(cfg: DeskfishConfig): Promise<void>;
  log(line: string): void;
  /** Keep the config both sides now agree on, for the next connect's merge. */
  saveBase?(cfg: DeskfishConfig): void;
}

/** A connect's merge, per key: what goes to the gateway, what is written into settings, and the keys both sides changed. */
export interface Merge {
  push: Partial<DeskfishConfig>;
  write: ConfigKey[];
  conflicts: ConfigKey[];
}

/**
 * The three-way merge on connect. `base` is the last config both sides agreed on; without one the
 * gateway wins every key that differs (the mirror before 6B).
 */
export function mergeOnConnect(gateway: DeskfishConfig, settings: DeskfishConfig, base: DeskfishConfig | undefined): Merge {
  const out: Merge = { push: {}, write: [], conflicts: [] };
  for (const k of changedKeys(settings, gateway)) {
    const settingsMoved = !!base && settings[k] !== base[k];
    const gatewayMoved = !base || gateway[k] !== base[k];
    if (settingsMoved && !gatewayMoved) (out.push as Record<string, unknown>)[k] = settings[k];
    else {
      out.write.push(k);
      if (settingsMoved) out.conflicts.push(k);
    }
  }
  return out;
}

const refusal = /^(bad value for|unknown setting:) /;
const text = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class ConfigSync {
  /** The gateway's config as last received (snapshot or event). */
  last?: DeskfishConfig;

  /** `base`: the config both sides last agreed on, as the host stored it (undefined the first time). */
  constructor(
    private readonly io: ConfigSyncIo,
    private base?: DeskfishConfig,
  ) {}

  /** Connected (again). `configSaved` absent means a gateway from before this rule: seeded as before. */
  async connected(snap: { config: DeskfishConfig; configSaved?: boolean }): Promise<'seeded' | 'mirrored' | 'merged'> {
    this.last = snap.config;
    if (!snap.configSaved) {
      const seed = this.io.readSettings();
      await this.send(seed);
      await this.io.pushKey(seed);
      this.agreed(seed);
      return 'seeded';
    }
    const had = this.base;
    const merge = mergeOnConnect(snap.config, this.io.readSettings(), had);
    for (const k of merge.conflicts) this.io.log(`— ${SETTINGS_KEYS[k]} was changed in VS Code's settings while it was away and on the gateway too; the gateway's value is kept —`);
    const pushed = Object.keys(merge.push).length > 0;
    if (pushed) await this.send(merge.push);
    // A pushed provider or base URL is followed by its key when the config event comes back.
    if (!pushed || !('provider' in merge.push || 'baseUrl' in merge.push)) await this.io.pushKey(this.last ?? snap.config);
    await this.mirror(this.last ?? snap.config, merge.write);
    this.agreed({ ...(this.last ?? snap.config) });
    return had ? 'merged' : 'mirrored';
  }

  /** A `config` event: the gateway changed (whoever asked). */
  async config(cfg: DeskfishConfig): Promise<void> {
    const prev = this.last;
    this.last = cfg;
    const keys = prev ? changedKeys(prev, cfg) : undefined;
    if (keys && !keys.length) return;
    if (!prev || prev.provider !== cfg.provider || prev.baseUrl !== cfg.baseUrl) await this.io.pushKey(cfg);
    await this.mirror(cfg, keys);
    this.agreed(cfg);
  }

  private agreed(cfg: DeskfishConfig): void {
    this.base = cfg;
    this.io.saveBase?.(cfg);
  }

  /** VS Code's settings changed; `affects(setting)` as `ConfigurationChangeEvent.affectsConfiguration`. */
  async settingsChanged(affects: (setting: string) => boolean): Promise<void> {
    if (!this.last) return; // not connected yet: the connect seeds or mirrors
    const keys = CONFIG_KEYS.filter((k) => affects(SETTINGS_KEYS[k]));
    if (!keys.length) return;
    await this.send(patchBetween(this.last, this.io.readSettings(), keys));
  }

  private async mirror(cfg: DeskfishConfig, keys?: readonly ConfigKey[]): Promise<void> {
    for (const w of writesFor(cfg, this.io.readSettings(), DEFAULT_CONFIG, keys)) {
      try {
        await this.io.write(w);
      } catch (err) {
        this.io.log(`gateway settings → ${w.setting} failed: ${text(err)}`);
      }
    }
  }

  /** A patch; refused as a whole for one bad value, so then key by key, and each refusal is one log line. */
  private async send(patch: Partial<DeskfishConfig>): Promise<void> {
    const entries = Object.entries(patch);
    if (!entries.length) return;
    try {
      await this.io.push(patch);
    } catch (err) {
      if (entries.length > 1 && refusal.test(text(err))) {
        for (const [k, v] of entries) await this.send({ [k]: v } as Partial<DeskfishConfig>);
        return;
      }
      this.io.log(`settings → gateway: ${text(err)}${entries.length === 1 ? ` (${SETTINGS_KEYS[entries[0][0] as ConfigKey] ?? entries[0][0]} not applied)` : ''}`);
    }
  }
}
