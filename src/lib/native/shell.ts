// window.native.shell's types (opening links, files and folders in other apps), merged into NativeApi; the calls are declared in electron/bridge/shell.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    shell: {
      openExternal(u: string): Promise<void>;
      openPath(p: string): Promise<string>;
      reveal(p: string): Promise<void>;
      openIn(target: string, p: string): Promise<unknown>;
    };
  }
}
