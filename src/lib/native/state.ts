// window.native.state's types (ui-state.json), merged into NativeApi; the calls are declared in electron/bridge/state.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    state: {
      read(): Promise<unknown>;
      /** this window's own keys; prefs and per-chat state go through prefs/chats */
      write(s: unknown): Promise<void>;
    };
  }
}
