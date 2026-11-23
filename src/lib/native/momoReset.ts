// window.native.momoReset's types (Reset MoMo, #2139), merged into NativeApi; the calls are declared in electron/bridge/momoReset.cjs.

/** One of MoMo's stores (electron/momo/stores.cjs MOMO_STORES), or its settings, as the user is told it. */
export interface MomoResetPart {
  id: string;
  label: string;
}
/** What a reset did: what was deleted, and what wasn't (absent: this build has no way to reach it; failed: it couldn't). */
export interface MomoResetResult {
  reset: MomoResetPart[];
  notReset: (MomoResetPart & { reason: 'absent' | 'failed' })[];
}

declare module '../native' {
  interface NativeApi {
    momoReset: {
      /** throws `not_allowed` while MoMo is off, `save_failed` when MoMo couldn't be paused (nothing was reset then) */
      run(): Promise<MomoResetResult>;
    };
  }
}
