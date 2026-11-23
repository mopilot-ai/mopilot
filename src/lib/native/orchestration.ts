// window.native.orchestration's types (linked sessions), merged into NativeApi; the calls are declared in electron/bridge/orchestration.cjs.
import type { OrchestrationView, SessionWorkResult } from '../../../shared/orchestration';

declare module '../native' {
  interface NativeApi {
    /** linked sessions: which chat started which, and the briefs, wake-ups and family messages main delivered */
    orchestration: {
      snapshot(): Promise<OrchestrationView>;
      /** a click on a proposal's card: start it (resolves to the started session), dismiss it, do it here, reopen an offer "Do it here" claimed when the chat refused its message, or hold an offer's countdown while the user decides */
      task(
        id: string,
        action: 'start' | 'dismiss' | 'here' | 'reopen' | 'hold',
        /** for start: the harness and worktree the user picked on the card */
        options?: { harness?: string | null; useWorktree?: boolean; model?: string; effort?: string; permission?: string } | null,
      ): Promise<unknown>;
      /** a click on a started session's card: merge its worktree branch into this chat's folder, or open a pull request for it */
      child<A extends 'merge' | 'pr' | 'detach'>(
        id: string,
        action: A,
      ): Promise<A extends 'detach' ? { detached: true } : SessionWorkResult>;
      archiveFamily(
        id: string,
        mode?: 'quiet' | 'all' | 'parent',
        expectedIds?: string[],
      ): Promise<{
        archived: string[];
        remaining: string[];
        needsChoice: boolean;
        working: number;
      }>;
      onChanged(cb: (view: OrchestrationView) => void): () => void;
    };
  }
}
