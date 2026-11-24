// window.native.perf's types (performance samples), merged into NativeApi; the calls are declared in electron/bridge/perf.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    perf: {
      samples(batch: Record<string, unknown>[]): void;
      /** one content-free line about what this window could not do in time or what its composer refused (electron/perf/rendererLog.cjs) */
      record(line: Record<string, unknown>): void;
    };
  }
}
