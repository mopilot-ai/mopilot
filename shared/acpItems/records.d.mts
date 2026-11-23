// What an ACP chat's transcript and its permission cards hold, as main and the window read them.
import type { Emit } from '../model/window';
export type { Emit };
/** A line of threads/<key>.items.jsonl (electron/harness/acp.cjs writes them). */
export type AcpRecord =
  | {
      t: 'session';
      harness: string;
      sessionId: string;
      cwd: string;
      at?: number;
    }
  | {
      t: 'user';
      turnId: string;
      user: {
        id: string;
        clientId: string | null;
        content: unknown[];
      };
      at?: number;
    }
  | {
      t: 'update';
      turnId: string | null;
      update: unknown;
      at?: number;
    }
  | {
      t: 'end';
      turnId: string;
      stopReason: string;
      error?: string | null;
      /** the provider failure the harness was still retrying when the turn ended */
      providerError?: string;
      /** a chat on a machine: why the turn failed, as the Host typed it (shared/host/turnErrorCode.mjs) */
      turnErrorCode?: 'rate_limit' | 'auth' | 'context' | 'model_unavailable';
      /** a chat on a machine: the failure is that machine's, so nothing of this Mac's accounts is offered for it */
      onMachine?: true;
      at?: number;
    }
  | {
      /** what the turn changed in its folder: added when the transcript is read (not on disk) */
      t: 'diff';
      turnId: string;
      diff: string;
      at?: number;
    };
