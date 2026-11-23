// window.native.browserUse's types (Codex Browser Use settings), merged into NativeApi; the calls are declared in electron/bridge/browserUse.cjs.
import type { BrowserUseDecision, BrowserUsePref, BrowserUseResource, BrowserUseState } from '../native';

declare module '../native' {
  interface NativeApi {
    /** Codex Browser Use settings; a change answers with the new state, or throws (code 'locked', 'invalid', 'unreadable', 'save_failed'). */
    browserUse: {
      state(): Promise<BrowserUseState>;
      setPreference(name: BrowserUsePref, value: string | boolean): Promise<BrowserUseState>;
      setRule(resource: BrowserUseResource, origin: string, decision: BrowserUseDecision): Promise<BrowserUseState>;
      forget(origin: string): Promise<BrowserUseState>;
    };
  }
}
