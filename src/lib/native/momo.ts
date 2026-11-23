// window.native.momo's types (MoMo's closed-alpha gate), merged into NativeApi; the calls are declared in electron/bridge/momo.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    momo: {
      /** whether MoMo exists for the signed-in account now */
      access(): Promise<boolean>;
      onAccess(cb: (allowed: boolean) => void): () => void;
    };
  }
}
