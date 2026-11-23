// Appearance: follow the phone (System), or always Light or Dark. The choice is kept on this phone and applied when the app starts.
export type Appearance = 'system' | 'light' | 'dark';
export const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark'];
export const APPEARANCE_WORD: Record<Appearance, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/** Anything unreadable is System, so a bad store never forces a scheme. */
export const parseAppearance = (raw: string | null): Appearance => APPEARANCES.find((a) => a === raw) ?? 'system';

export interface AppearanceControl {
  read(): Promise<Appearance>;
  /** Apply and keep the choice; rejects when it could not be kept. */
  set(value: Appearance): Promise<void>;
}

/** The control over a string store and the system's scheme setter (null: follow the phone). */
export function createAppearance(o: {
  store: { read(): Promise<string | null>; write(value: string): Promise<void> };
  apply(scheme: 'light' | 'dark' | null): void;
}): AppearanceControl {
  const show = (value: Appearance) => o.apply(value === 'system' ? null : value);
  return {
    async read() {
      const value = parseAppearance(await o.store.read().catch(() => null));
      show(value);
      return value;
    },
    async set(value) {
      await o.store.write(value);
      show(value);
    },
  };
}
