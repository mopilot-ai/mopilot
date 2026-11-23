// Typed neutral facts for optional main-process observers; local ownership IDs never belong in upload payloads.
export type UsageFact =
  | {
      kind: 'session';
      chatId: string;
      segment: string;
      harness: string;
      running: boolean;
      human: boolean;
      crashed: boolean;
      plan: boolean;
      goal: boolean;
      scheduled: boolean;
      queued: boolean;
      remote: boolean;
    }
  | { kind: 'run-end'; chatId: string; outcome: 'completed' | 'failed' | 'cancelled' }
  | { kind: 'tool'; chatId: string; tool: string; ok: boolean; code?: string; durationMs: number }
  | { kind: 'chat'; action: 'created' | 'archived' | 'restored' }
  | { kind: 'lifecycle'; action: 'opened' | 'quitting' };
export function observe(fact: UsageFact): void;
export function observeWith(observer: (fact: UsageFact) => void): () => void;
export function observeSession(
  chatId: string,
  read: () => {
    turn: string;
    activeTurn: { human?: boolean } | null;
    plan: boolean;
    goal: unknown;
    scheduled: unknown;
    queue: unknown[];
    runningElsewhere: boolean;
  },
  ref: () => { id: string; kind: string; instance?: string | null },
): void;
