// The one switch between the classic phone screens and the rebuilt ones: one value per launch, a saved override for the next launch, the build default otherwise.

export type PhoneUi = 'classic' | 'v2';

/** What persists the developer override on this phone (a string store, as the haptics setting uses). */
export interface FlagStore {
  read(): Promise<string | null>;
  write(value: string | null): Promise<void>;
}

const isPhoneUi = (value: unknown): value is PhoneUi => value === 'classic' || value === 'v2';

/** The value for a launch: a valid saved override wins, anything else falls back to the build default. */
export function resolvePhoneUi(override: string | null | undefined, buildDefault: string | null | undefined): PhoneUi {
  if (isPhoneUi(override)) return override;
  return isPhoneUi(buildDefault) ? buildDefault : 'classic';
}

export interface PhoneUiFlag {
  /** Reads the saved override once; call before the first screen renders. A store that fails to read leaves the build default. */
  load(): Promise<void>;
  /** The launch's value. The first call fixes it for the rest of the launch, whether or not `load` has finished. */
  get(): PhoneUi;
  /** The saved override, or null; what the developer switch shows. */
  override(): Promise<PhoneUi | null>;
  /** Saves the override for the next launch (null clears it). The value of this launch does not change. */
  setOverride(value: PhoneUi | null): Promise<void>;
}

/**
 * `development` is false in a store build: it has no switch, so an override a development build saved earlier (the keychain outlives an update) is
 * ignored and cleared, and the build default is the UI. Development builds keep the override.
 */
export function createPhoneUiFlag(store: FlagStore, buildDefault: string | null | undefined, development = true): PhoneUiFlag {
  let chosen: PhoneUi | undefined;
  let loaded: string | null = null;
  return {
    async load() {
      if (!development) {
        loaded = null;
        await store.write(null).catch(() => undefined);
        return;
      }
      loaded = await store.read().catch(() => null);
    },
    get() {
      chosen ??= resolvePhoneUi(loaded, buildDefault);
      return chosen;
    },
    async override() {
      if (!development) return null;
      const saved = await store.read().catch(() => null);
      return isPhoneUi(saved) ? saved : null;
    },
    async setOverride(value) {
      if (!development) return;
      await store.write(value);
    },
  };
}

/** What the Phone UI switch needs of the flag: this launch's value, the saved choice and a way to save one. */
export type PhoneUiControl = Pick<PhoneUiFlag, 'get' | 'override' | 'setOverride'>;

/** The choice to show as picked (the saved one, else what this launch draws) and whether it waits for the next launch. */
export function phoneUiChoice(active: PhoneUi, saved: PhoneUi | null): { picked: PhoneUi; pending: boolean } {
  const picked = saved ?? active;
  return { picked, pending: picked !== active };
}

/** The ids a v2 screen's root carries, so a device test can tell which UI is drawn: `thread-v2`, `composer-v2`, ... */
export const v2Id = (screen: string): string => `${screen}-v2`;
