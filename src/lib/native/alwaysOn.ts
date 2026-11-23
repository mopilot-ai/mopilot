// window.native.alwaysOn's types (Mobile Remote kept reachable with no window open), merged into NativeApi; the calls are declared in electron/bridge/alwaysOn.cjs.
export interface AlwaysOnPrefs {
  /** closing the last window leaves the app running in the menu bar */
  keepRunning: boolean;
  /** the OS starts the app at login, in the menu bar with no window */
  loginItem: boolean;
  /** the Mac does not idle-sleep while it is plugged in with a phone paired */
  preventSleep: boolean;
  /** the first pairing has put these on once: a later one leaves what the person chose */
  offered: boolean;
}

export interface AlwaysOnState {
  prefs: AlwaysOnPrefs;
  /** Mobile Remote is running (remote.enabled is on and its runtime started) */
  remoteOn: boolean;
  /** the app stays up with every window closed */
  active: boolean;
  paired: number;
  connected: boolean;
  /** false where the OS has no login item API (Linux) */
  loginItemSupported: boolean;
}

declare module '../native' {
  interface NativeApi {
    alwaysOn: {
      get(): Promise<AlwaysOnState | null>;
      set(patch: Partial<AlwaysOnPrefs>): Promise<AlwaysOnState>;
      onChanged(cb: (state: AlwaysOnState) => void): () => void;
    };
  }
}
