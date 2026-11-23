// window.native.dialog's types (open and save dialogs), merged into NativeApi; the calls are declared in electron/bridge/dialog.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    dialog: {
      openFolder(): Promise<string | null>;
      openFiles(opts?: { images?: boolean; defaultPath?: string }): Promise<string[]>;
      saveText(name: string, text: string): Promise<string | null>;
    };
  }
}
