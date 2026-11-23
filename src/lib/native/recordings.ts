// window.native.recordings's types (dictation recordings), merged into NativeApi; the calls are declared in electron/bridge/recordings.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    recordings: {
      save(bytes: Uint8Array, text: string): Promise<void>;
      list(): Promise<{ id: string; text: string; at: number }[]>;
      read(id: string): Promise<string | null>;
      clear(): Promise<void>;
    };
  }
}
