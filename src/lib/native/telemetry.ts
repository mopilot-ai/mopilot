// window.native.telemetry's types (usage data), merged into NativeApi; the calls are declared in electron/bridge/telemetry.cjs.
export {};

declare module '../native' {
  interface NativeApi {
    telemetry: {
      track(name: string, props: Record<string, unknown>): void;
      /** a reply's rating: sent even with sharing off, since the click is consent for that one rating */
      rate(props: Record<string, unknown>): void;
      error(err: { message: string; stack: string; process: string; kind?: string; component?: string }): void;
      shareTurn(turn: Record<string, unknown>): void;
      /** apply the "share usage data" choice in the main process and mirror it to the MoPilot account */
      setConsent(v: boolean | null): Promise<void>;
    };
  }
}
