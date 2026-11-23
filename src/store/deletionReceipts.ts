// Apply native whole-chat completion consistently to local IPC replies, broadcasts and startup snapshots: the chat is hidden everywhere and leaves the panes.
import { deletionVisibility } from './deletionVisibility';
import { recordThreadDeletion } from './archiveOwnership';
import { set } from './core';
import { retireChatFromView } from './splitView';

export function acceptChatDeletion(receipt: unknown) {
  const ids = deletionVisibility.accept(receipt);
  if (!ids.length) return;
  for (const id of ids) {
    recordThreadDeletion(id);
    // a deleted chat leaves every pane that showed it, as an archived one does: a split pane closes, the primary goes home
    retireChatFromView(id);
  }
  // The common ingress filter removes existing rows and prevents all later state writers from restoring them.
  set((state) => ({ ...state }));
}
