// A new chat on another machine, renderer side: main records its folder with the machine and lists it (electron/app/ipc/host.cjs host:startChat); the thread here is made like any basic chat's, for a basic agent and for Claude Code or Codex alike (the machine runs it; this app draws its transcript).
import { appIdPrefix } from '../../../shared/host/chatIds.mjs';
import { native } from '../../lib/native';
import { noteHostChat } from '../../lib/hostChats';
import { patchRuntime, upsertThread } from '../../store/core';
import { rememberChatProject } from '../../store/projects';
import type { Thread } from '../../store/types';
import { acpThread, fresh } from './acp';

/**
 * A new chat on a machine, on a basic agent or on `claude`/`codex`. Main records the folder with the machine and lists the chat; the chat's first message
 * starts it there (electron/host/remoteSend.cjs). Rejects with main's refusal (the machine is not listed, the agent is not installed on it).
 */
export async function startHostAcpThread(o: {
  host: { id: string; path: string; scope?: string };
  projectId?: string | null;
  harness: string;
}): Promise<string> {
  const id = `${appIdPrefix(o.harness)}${crypto.randomUUID()}`;
  await native.host.startChat({
    chatId: id,
    hostId: o.host.id,
    folder: o.host.path,
    harness: o.harness,
    projectId: o.projectId ?? null,
    ...(o.host.scope !== undefined && { scope: o.host.scope }),
  });
  fresh.add(id);
  noteHostChat(id, o.host.id);
  const now = Date.now();
  // the folder is the machine's: it is no path on this Mac, so nothing here is unhidden or looked up in it
  upsertThread({ ...acpThread({ id, cwd: o.host.path, createdAt: now, updatedAt: now }), projectId: o.projectId ?? null } as Thread, true);
  // the machine's folder matches no project root here, so the project the chat was started in is what keeps it there after a restart
  rememberChatProject(id, o.projectId);
  patchRuntime(id, () => ({ loaded: true, loading: false }));
  return id;
}
