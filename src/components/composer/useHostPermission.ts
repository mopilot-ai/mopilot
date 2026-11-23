// The permission mode a chat on a machine runs under: the pick kept for that machine and agent, else what the Host reported, else this Mac's default (the mode a message there would start in).
import { useStore } from '../../store/core';
import { useSessionField } from '../../store/session/useSession';
import type { HarnessId } from '../../harness/types';
import { isHostPermission, hostPermissionOf, startingHostMode } from '../../../shared/host/permissions.mjs';
import type { PermissionMode } from '../../../shared/model/store';

export function useHostPermission(threadId: string | null, family: HarnessId, hostId: string): PermissionMode {
  const saved = useStore((s) =>
    threadId ? s.chatConfig[threadId]?.hostPermission : s.newChatHost?.id === hostId ? s.newChatHost.permission : null,
  );
  const told = useSessionField(threadId, (s) => s.permission);
  const mine = useStore((s) => s.prefs.permission);
  const picked = hostPermissionOf(saved, hostId, family);
  return picked ?? (isHostPermission(told) ? (told as PermissionMode) : startingHostMode({ hostId, harness: family, macDefault: mine }));
}
