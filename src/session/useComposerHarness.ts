// One current-or-pending destination for the composer's model, permission and command controls.
import { useStore } from '../store/core';
import { chatBasicHarness, newChatBasic } from '../store/chats';
import { useSessionField } from '../store/session/useSession';
import { harnessKindFrom, pendingBasic } from '../harness/family';
import { useComposerFirstTier } from './harness/select';
import { effectivePermission } from '../../shared/effectivePermission.mjs';
import type { PermissionMode } from '../../shared/model/store';

/** The permission the native session currently enforces, before saved next-turn choices. */
export function useChatPermission(threadId: string | null): PermissionMode | 'plan' {
  const config = useStore((s) => (threadId ? s.chatConfig[threadId] : null));
  const fallback = useStore((s) => s.prefs.permission);
  const session = useSessionField(threadId, (s) => ({ permission: s.permission, pendingSwitch: s.pendingSwitch }));
  return effectivePermission(config, fallback, session);
}

export function useComposerHarness(threadId: string | null) {
  const session = useSessionField(threadId, (s) => ({ pendingSwitch: s.pendingSwitch, acp: s.acp }));
  const current = useStore((s) => (threadId ? chatBasicHarness(threadId, s) : newChatBasic(s)));
  const harness = useComposerFirstTier(threadId);
  const basic = pendingBasic(session.pendingSwitch?.harness, current);
  // the caps hint names the harness only once one has resolved: never 'acp:null' (#2862); main then reads the chat's own
  const kind = harnessKindFrom(harness, basic);
  return { harness, basic, hint: kind ? { kind } : undefined, acpCommands: basic === current ? (session.acp?.commands ?? null) : null };
}
