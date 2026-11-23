// window.native.context's types (context snapshots, electron/context), merged into NativeApi; the calls are declared in electron/bridge/context.cjs.
import type { ContextSnapshot } from '../../../shared/contextSnapshot.mjs';

export type { ContextSnapshot };

declare module '../native' {
  interface NativeApi {
    context: {
      /** The owner's snapshot ([chat, harness, native id], src/store/contextUsage.ts contextUsageKey), or null. */
      get(owner: string): Promise<ContextSnapshot | null>;
      /** Read the owner's breakdown again where its harness has one; the snapshot as it stands elsewhere. */
      refresh(owner: string, detail?: 'summary' | 'full'): Promise<ContextSnapshot | null>;
      /** Each snapshot main publishes; returns the unsubscribe. */
      onSnapshot(fn: (e: { chatId: string; snapshot: ContextSnapshot }) => void): () => void;
    };
  }
}
