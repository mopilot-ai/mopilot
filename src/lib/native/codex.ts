// window.native.codex's types (the Codex app-server and adapter), merged into NativeApi; the calls are declared in electron/bridge/codex.cjs.
import type { CodexEvent, CodexItem, CodexNegotiated } from '../native';
import type { ThreadForkResponse } from '../../protocol/v2/ThreadForkResponse';
import type { ThreadStartResponse } from '../../protocol/v2/ThreadStartResponse';
import type { ServerTurn } from '../../../shared/codexTurns.mjs';

declare module '../native' {
  interface NativeApi {
    codex: {
      start(): Promise<{ bin: string; status: string }>;
      restart(): Promise<boolean>;
      /** Codex has been used on this machine (its home folder is not empty) */
      used(): Promise<boolean>;
      binaries(): Promise<{ candidates: { path: string; version: string | null }[]; current: string }>;
      /** initialize the app-server (once per process; again after it failed or exited) */
      connect(): Promise<{ codexHome: string; userAgent: string } & Record<string, unknown>>;
      /** one app-server request, sent by the adapter in main; rejects with the app-server's error */
      request<T = unknown>(method: string, params?: unknown): Promise<T>;
      /** one of the Codex adapter's named calls (electron/harness/codex.cjs CODEX_API); typed in src/harness/adapters/codexApi.ts */
      api(name: string, args: unknown[]): Promise<unknown>;
      /** answer an approval or question card; false when main no longer holds it (answered, withdrawn, app-server restarted) */
      respond(id: number | string, result: unknown): Promise<boolean>;
      /** the app-server exited or failed to start */
      onStatus(cb: (e: CodexEvent) => void): () => void;
      /** what the Codex adapter in main reports: notifications under their chat, cards, leases, turn steps */
      onItem(cb: (e: CodexItem) => void): () => void;
      /** native threads Sage holds the writer lease of */
      leases(): Promise<string[]>;
      /** the running Codex's version status and probes (WP5-20) */
      negotiated(): Promise<CodexNegotiated>;
      /** take a thread's writer lease; `locked` when another Codex client holds it */
      resume(threadId: string): Promise<{ ok?: true; locked?: true }>;
      /** keep a lease regardless of activity (a voice session) */
      pinLease(threadId: string, on: boolean): Promise<void>;
      /** a write on the chat's current Codex thread (nativeOf in main), under its lease */
      leased<T = unknown>(chatId: string, method: string, params?: Record<string, unknown>): Promise<{ result?: T; locked?: true }>;
      startThread(params: Record<string, unknown>): Promise<ThreadStartResponse>;
      fork(params: Record<string, unknown>, hold?: boolean): Promise<ThreadForkResponse>;
      /** watch a thread's rollout file; `onRollout` fires (debounced) when it changes */
      watchRollout(threadId: string, file: string): Promise<boolean>;
      unwatchRollout(threadId: string): Promise<void>;
      onRollout(cb: (threadId: string) => void): () => void;
      /**
       * a thread's turns read from its rollout file (for while the app-server is down): the `limit` latest before
       * `cursor`, oldest first; null when it has no rollout
       */
      rolloutHistory(
        threadId: string,
        o?: { hint?: string | null; cursor?: string | null; limit?: number },
      ): Promise<{ path: string; cwd: string | null; turns: ServerTurn[]; nextCursor: string | null } | null>;
    };
  }
}
