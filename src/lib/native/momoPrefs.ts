// window.native.momoPrefs's types (MoMo's settings, #2139), merged into NativeApi; the calls are declared in electron/bridge/momoPrefs.cjs.
import type { MomoPrefKey, MomoPrefValues } from '../../../shared/momoPrefs.mjs';

declare module '../native' {
  interface NativeApi {
    momoPrefs: {
      /**
       * merged by main into prefs.momo as saved now; throws `not_allowed` while MoMo is off, `bad_args` for a value it
       * can't hold, `busy` for a resume while a reset runs (Reset MoMo: window.native.momoReset)
       */
      set<K extends MomoPrefKey>(key: K, value: MomoPrefValues[K]): Promise<true>;
    };
  }
}
