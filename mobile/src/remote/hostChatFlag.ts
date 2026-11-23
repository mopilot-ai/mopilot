// Whether this phone follows, sends to and starts a machine's chat itself (the `host.phoneChat` flag's phone side, X4): what the Mac last told it, a build default, and a developer override.

/** What persists the values on this phone (a string store, as the phone UI flag uses). */
export interface FlagStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string | null): Promise<void>;
}

export const TOLD = 'hostChatTold';
export const OVERRIDE = 'hostChat';

export interface HostChatFlag {
  /** Reads what was saved; call at launch. A store that fails leaves the build default; an answer told before it finished is not overwritten by an older one. */
  load(): Promise<void>;
  /** Whether machine chats go through the machine: an override ('on' or 'off') wins; otherwise a build made with it on, or a Mac having told it on. */
  on(): boolean;
  /** A Mac answered machine.hello: its `host.phoneChat` flag now, kept per Mac (another Mac's answer does not take it back) for the time it is away. */
  told(value: boolean, mac?: string): void;
  /** Where `on()` comes from, for Settings › About: the developer override, this build, a Mac that said so, or nothing (off). */
  why(): 'saved' | 'build' | 'mac' | 'off';
  /** The developer override for this phone (null clears it). */
  setOverride(value: boolean | null): Promise<void>;
  /** Called when `on()` may have changed (the saved values were read, a Mac told something new). Returns the stop. */
  subscribe(fn: () => void): () => void;
}

const asTold = (raw: string | null): Record<string, boolean> => {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>;
  } catch {
    return {};
  }
};

/** @param buildDefault the build's setting (Expo config `extra.hostChat`): true turns it on for a build made for the device check */
export function createHostChatFlag(store: FlagStore, buildDefault: unknown): HostChatFlag {
  let override: boolean | null = null;
  let told: Record<string, boolean> = {};
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());
  const parse = (v: string | null) => (v === 'on' ? true : v === 'off' ? false : null);
  return {
    async load() {
      override = parse(await store.read(OVERRIDE).catch(() => null));
      // what a Mac said since launch is newer than what was saved
      told = { ...asTold(await store.read(TOLD).catch(() => null)), ...told };
      changed();
    },
    on() {
      return override ?? (buildDefault === true || Object.values(told).includes(true));
    },
    why() {
      if (override !== null) return 'saved';
      if (buildDefault === true) return 'build';
      return Object.values(told).includes(true) ? 'mac' : 'off';
    },
    told(value, mac = '') {
      if (told[mac] === value) return;
      told = { ...told, [mac]: value };
      void store.write(TOLD, JSON.stringify(told)).catch(() => undefined);
      changed();
    },
    async setOverride(value) {
      override = value;
      await store.write(OVERRIDE, value === null ? null : value ? 'on' : 'off');
      changed();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/**
 * The build's setting: the Expo config's `extra.hostChat` (MOPILOT_HOST_CHAT=1 when the build was made) or, since Metro inlines it into the bundle
 * itself, EXPO_PUBLIC_MOPILOT_HOST_CHAT=1.
 */
export const buildDefaultOf = (config: unknown, publicEnv: string | undefined): boolean =>
  (config as { extra?: { hostChat?: unknown } } | undefined)?.extra?.hostChat === true || publicEnv === '1';
