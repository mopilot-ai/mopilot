// window.native.prefs's types (preferences), merged into NativeApi; the calls are declared in electron/bridge/prefs.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    /** prefs in ui-state.json, merged per key by main */
    prefs: {
      recording(on: boolean): Promise<boolean>;
      binding(id: string, key?: string | null): Promise<boolean>;
      patch(set: Record<string, unknown>, unset: string[]): Promise<boolean>;
      onChanged(
        cb: (d: { set: Record<string, unknown>; unset: string[]; binding?: { id: string; key?: string | null } }) => void,
      ): () => void;
    };
  }
}
