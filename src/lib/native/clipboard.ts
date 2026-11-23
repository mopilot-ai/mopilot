// window.native.clipboard's types (the clipboard), merged into NativeApi; the calls are declared in electron/bridge/clipboard.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    clipboard: { write(t: string): Promise<void> };
  }
}
