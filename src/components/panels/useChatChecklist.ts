// The checklist shared by a chat's rail and Plan pane, including the list the agent keeps in main.
import { authoredFor, markedInputFor } from '../../lib/authoredInput';
import { sideSessionForItem, useOrchestration } from '../../lib/sideSessions';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/core';
import { boxPlan } from '../../store/turnPlan';

const NO_TURNS: never[] = [];

export function useChatChecklist(threadId: string) {
  const view = useOrchestration();
  return useStore(
    useShallow((s) =>
      boxPlan(
        s.runtime[threadId]?.turns ?? NO_TURNS,
        view.plans[threadId],
        (item) => !!sideSessionForItem(view, item) || !!authoredFor(s.authoredInputs, threadId, item) || !!markedInputFor(item),
      ),
    ),
  );
}
