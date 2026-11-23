// A chat's context as its panels show it: main's snapshot (or a reading this window was reported), whether a turn runs, and a way to read a stale breakdown again.
import { useSession } from '../../store/session/useSession';
import { turnBusy } from '../../store/session/sessionState';
import { ignoring } from '../../lib/ignored';
import { useChatContextState } from '../../session/useChatContext';
import { askContext, useContextAsk, useContextOwner, useContextSnapshot } from '../../session/useContextSnapshot';
import { shownSnapshot } from './ContextBreakdown';

/** The chat's breakdown as it stands, whether a turn runs, and `retry`: ask main to read it again, where its harness has a breakdown to read. */
export function useContextView(threadId: string, purpose: string) {
  const snapshot = useContextSnapshot(threadId, purpose);
  const { reading, state } = useChatContextState(threadId, purpose);
  const running = turnBusy(useSession(threadId));
  // a chat id always has an owner
  const own = useContextOwner(threadId) as { owner: string; breakdown: boolean };
  // A renderer's token totals are usable while the first composition is still being read.
  const ask = useContextAsk(own.owner);
  const retry = own.breakdown ? () => void askContext(own.owner, true).catch(ignoring("read a chat's context breakdown again")) : null;
  return { snapshot: shownSnapshot(snapshot, reading), state: ask ?? state, running, retry };
}
