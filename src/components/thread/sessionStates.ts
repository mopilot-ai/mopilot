// The live states a list of session cards reports (SessionCard.tsx onState), kept by chat id for the list that groups,
// folds or counts them: a session stack, the Background tasks tab's groups, the status line's count.
import { useCallback, useState } from 'react';
import type { SessionCardState } from './SessionCard';

/** Each reported state by chat id, and the callback cards report through; an equal state changes nothing. */
export function useSessionStates(): [Record<string, SessionCardState>, (chatId: string, state: SessionCardState) => void] {
  const [states, setStates] = useState<Record<string, SessionCardState>>({});
  const onState = useCallback(
    (chatId: string, state: SessionCardState) => setStates((was) => (was[chatId] === state ? was : { ...was, [chatId]: state })),
    [],
  );
  return [states, onState];
}
