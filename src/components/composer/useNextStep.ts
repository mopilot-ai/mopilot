// The composer's follow-up for the latest finished turn, including browser and desktop recovery hints.
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/core';
import { suggestNextStep } from '../../lib/nextStep';
import { refusedApps } from '../../lib/controlRefusal';
import { useSessionField } from '../../store/session/useSession';

const NO_IDS: string[] = [];

/**
 * The suggestion for the chat's latest turn once it has ended; null while it runs or with nothing to suggest. While a
 * turn runs every selection is a constant, so the composer does not render per streamed frame.
 */
export function useNextStep(threadId: string | null): string | null {
  const running = useStore((s) => (threadId ? !!s.runtime[threadId]?.activeTurnId : false));
  const nativeSuggestion = useSessionField(threadId, (s) => (s.turn === 'idle' && !s.compaction ? s.promptSuggestion : null));
  const turn = useStore((s) => (threadId && !running ? s.runtime[threadId]?.turns.at(-1) : undefined));
  // the apps computer use refused in it (the chat's saved notes) get no follow-up
  const notes = useStore((s) => (threadId ? s.chatNotes?.[threadId] : undefined));
  // refusedApps reads the turn ids only, and only when there are notes to match
  const turnIds = useStore(
    useShallow((s) => (threadId && !running && notes?.length ? (s.runtime[threadId]?.turns.map((t) => t.id) ?? NO_IDS) : NO_IDS)),
  );
  return useMemo(() => {
    if (running) return null;
    const refused = refusedApps(
      notes,
      turnIds.map((id) => ({ id })),
    );
    return suggestNextStep(turn?.items ?? [], refused, nativeSuggestion ?? null);
  }, [running, turn, turnIds, notes, nativeSuggestion]);
}
