// window.native.mopilot's types (the MoPilot account), merged into NativeApi; the calls are declared in electron/bridge/mopilot.cjs.
import type { MoPilotStatus } from '../native';

declare module '../native' {
  interface NativeApi {
    mopilot: {
      status(): Promise<MoPilotStatus>;
      refresh(): Promise<MoPilotStatus>;
      signIn(): Promise<{ ok: boolean; error?: string }>;
      cancelSignIn(): Promise<void>;
      signOut(): Promise<void>;
      /** open a mopilot.ai page (e.g. '/credits') in the default browser */
      openWeb(path: string): Promise<void>;
      /** the gateway's capability table by model (/v1/models), or null when unknown */
      onEvent(cb: (s: MoPilotStatus) => void): () => void;
    };
  }
}
