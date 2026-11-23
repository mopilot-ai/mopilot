// window.native.perf's types (performance samples), merged into NativeApi; the calls are declared in electron/bridge/perf.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    perf: {
      samples(batch: Record<string, unknown>[]): void;
    };
  }
}
