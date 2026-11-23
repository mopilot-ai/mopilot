// Project immutable phone UI state from durable pair knowledge and the current pairing lifecycle.
import type { MobileSnapshot } from './contracts';

export type MobileState = Omit<MobileSnapshot, 'pairCleanup' | 'pairingCommit'>;
export function phoneSnapshot(state: MobileState, pairingStatus?: string, processingFrame?: boolean): MobileSnapshot {
  const waiting = state.phase === 'pairing' && pairingStatus === 'waiting';
  const committing =
    !!state.user && (pairingStatus === 'committing' || (state.phase === 'pairing' && pairingStatus === 'idle' && !!processingFrame));
  const starting = state.phase === 'pairing' && pairingStatus === 'starting';
  return {
    ...state,
    user: state.user && { ...state.user },
    pairs: state.pairs.map((pair) => ({ ...pair })),
    presence: Object.fromEntries(Object.entries(state.presence).map(([pair, entry]) => [pair, { ...entry }])),
    reconnect: state.reconnect && { ...state.reconnect },
    outbox: state.outbox.map((item) => ({
      ...item,
      attachments: [...item.attachments],
      ...(item.skills ? { skills: [...item.skills] } : {}),
    })),
    pairCleanup: state.pendingPair && !waiting && !starting && !committing,
    pairingCommit: committing,
    safetyNumber: state.phase === 'pairing' && (waiting || committing) ? state.safetyNumber : null,
  };
}
