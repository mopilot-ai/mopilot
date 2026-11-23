// window.native.voice's types (the voice hotkey), merged into NativeApi; the calls are declared in electron/bridge/voice.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    voice: {
      setHotkey(accelerator: string | null): Promise<boolean>;
    };
  }
}
