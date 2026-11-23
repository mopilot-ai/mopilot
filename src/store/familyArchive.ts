// A parent archive asks once for its retained family; main owns the effect and renderer replies never restamp metadata.
import { native } from '../lib/native';
import { requestArchiveFamilyChoice } from '../lib/archiveFamilyChoice';
import { get, threadTitle, toast } from './core';

export async function archiveWithFamily(threadId: string, archiveSingle: (id: string) => Promise<void>) {
  const view = await native.orchestration.snapshot();
  if (
    !view.families?.includes(threadId) &&
    !view.children[threadId] &&
    !Object.values(view.children).some((c) => c.parentId === threadId && !c.detached)
  )
    return archiveSingle(threadId);
  let result = await native.orchestration.archiveFamily(threadId);
  if (result.needsChoice) {
    const choice = await requestArchiveFamilyChoice({
      title: threadTitle(get().threads[threadId]),
      total: result.remaining.length + 1,
      working: result.working,
    });
    if (!choice) return;
    result = await native.orchestration.archiveFamily(threadId, choice, result.remaining);
  }
  // The ordered chats:changed stream already reflects the current owner, including a restore before this reply.
  if (result.archived.some((id) => get().claudeArchived[id] != null))
    toast(result.archived.length === 1 ? 'Archived session' : `Archived ${result.archived.length} sessions`);
}
