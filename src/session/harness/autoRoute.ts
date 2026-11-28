// The window's side of Auto model routing: a chat's (or new chats') Auto mode, the menu rows that stand for it, and the
// label its last decision gives the model button; main's electron/autoRoute picks the model, effort and harness.
import { useStore, setPrefs } from '../../store/core';
import { setChatConfig } from '../../store/projects';
import { useSessionField } from '../../store/session/useSession';
import { AUTO_MODEL_ID, autoModeOf, type AutoMode } from '../../../shared/autoRoute.mjs';
import { modelLabel } from '../../../shared/modelLabels.mjs';
import type { HarnessModel } from '../../harness/types';
import type { AutoRouteDecision } from '../../../shared/model/session';

export { AUTO_MODEL_ID, AUTO_HARNESS_ID } from '../../../shared/autoRoute.mjs';
export type { AutoMode };

/** The chat's Auto mode, or what new chats start in (no chat). */
export function useAutoMode(threadId: string | null): AutoMode | null {
  return useStore((s) => (threadId ? autoModeOf(s.chatConfig?.[threadId]) : autoModeOf({ autoRoute: s.prefs?.autoRouteNewChats })));
}

/** Turn Auto on (a mode) or off (null) for the chat, or for new chats when there is no chat. */
export function setAutoMode(threadId: string | null, mode: AutoMode | null) {
  if (threadId) setChatConfig(threadId, { autoRoute: mode });
  else setPrefs({ autoRouteNewChats: mode });
}

/** Auto's last decision for the chat, as main showed it. */
export function useAutoDecision(threadId: string | null): AutoRouteDecision | null {
  return useSessionField(threadId, (s) => s.autoRoute ?? null);
}

/** The model menu's Auto row: it saves no model; main picks one for each message (no hover note, as Default has none). */
export function autoModelRow(): HarnessModel {
  return {
    id: AUTO_MODEL_ID,
    label: 'Auto',
    efforts: [],
    defaultEffort: null,
    fast: false,
    more: false,
  };
}

/** What the model button says in Auto: the model the last message ran on (by the harness's own name for it), or Auto. */
export function autoButtonLabel(decision: AutoRouteDecision | null, models: readonly HarnessModel[] = []): string {
  if (!decision?.model || decision.fallback) return 'Auto';
  return `Auto · ${models.find((m) => m.id === decision.model)?.label ?? modelLabel(decision.model)}`;
}
