// window.native.updates's types (app updates), merged into NativeApi; the calls are declared in electron/bridge/updates.cjs.
import type { UpdateState } from '../native';

declare module '../native' {
  interface NativeApi {
    updates: {
      state(): Promise<UpdateState>;
      check(): Promise<UpdateState>;
      /** Restart to update through the exit gate; 'idle' waits until nothing would stop. */
      install(opts?: { when: 'now' | 'idle' }): Promise<boolean>;
      configure(opts: { auto: boolean; channel: 'stable' | 'beta' | 'dogfood' }): Promise<UpdateState>;
      onState(cb: (s: UpdateState) => void): () => void;
    };
  }
}
