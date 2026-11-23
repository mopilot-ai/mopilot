// window.native.pty's types (terminals), merged into NativeApi; the calls are declared in electron/bridge/pty.cjs.
import type { PtyEvent, PtySpawnOptions } from '../native';

declare module '../native' {
  interface NativeApi {
    /** Local pseudo-terminals (electron/platform/pty.cjs). Ids are this window's own. */
    pty: {
      /** Start `command`, or the user's login shell; a pty already under `id` is replaced. */
      spawn(id: string, opts: PtySpawnOptions): Promise<{ pid: number; file: string }>;
      write(id: string, data: string): void;
      resize(id: string, cols: number, rows: number): void;
      kill(id: string): Promise<boolean>;
      onEvent(cb: (e: PtyEvent) => void): () => void;
    };
  }
}
