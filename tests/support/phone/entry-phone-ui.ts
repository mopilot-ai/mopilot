// The production Phone UI flag as the entry test sees it, with the real one's contract: nothing saved (the build default is Classic), the launch's value fixed at the first `get()`, and a saved New override that only counts once `load` has finished.
let loaded = false;
let fixed: 'classic' | 'v2' | undefined;
export const phoneUiFlag = {
  loads: 0,
  load: async () => {
    phoneUiFlag.loads++;
    // the keychain answers later than the first render, as the real read does
    await Promise.resolve();
    loaded = true;
  },
  get: () => (fixed ??= loaded ? 'v2' : 'classic'),
  override: async () => null,
  setOverride: async () => undefined,
};
/** What Settings is given: a development build's control (the entry tests run as one). */
export const phoneUiControl = phoneUiFlag;
