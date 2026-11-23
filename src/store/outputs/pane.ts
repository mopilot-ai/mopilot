// Output and usage tabs belong to stable chats; file opens recheck their originating view.
import { identityKey } from '../../../shared/identityKey.mjs';
import { basename, pathKey } from '../../lib/paths';
import { viewChats } from '../../lib/agentTabs';
import { errorText } from '../../lib/ignored';
import { get, toast } from '../core';
import { chatOf } from '../chats';
import { focusedChat } from '../split';
import { openPaneTab } from '../panes';
import { outputPlaceKnown, resolveOutput } from '../../lib/outputResolve';

let revision = 0;
let opening: object | null = null;

export function openSessionPane(threadId: string, kind: 'outputs' | 'usage') {
  const chat = chatOf(threadId);
  if (!viewChats(focusedChat(get()), get().paneTabs).has(chat)) return;
  openPaneTab(kind, { id: identityKey(kind, chat), ownerChat: chat, threadId: chat, title: kind === 'outputs' ? 'Outputs' : 'Usage' });
}

/** A user action reports missing files, and never selects a file in a different chat after its path probe returns. */
export async function openOutputFile(threadId: string, path: string) {
  const chat = chatOf(threadId);
  const before = get();
  const cwd = before.threads[chat]?.cwd ?? '';
  // where the chat runs is not known yet: its file is not looked for on this Mac meanwhile
  if (!outputPlaceKnown(chat)) return toast('Still finding where this chat runs. Try again in a moment.', 'error');
  const token = {};
  opening = token;
  const current = () => {
    const now = get();
    return (
      opening === token &&
      viewChats(focusedChat(now), now.paneTabs).has(chat) &&
      now.route === before.route &&
      (now.threads[chat]?.cwd ?? '') === cwd &&
      now.segments[chat] === before.segments[chat] &&
      now.paneActive === before.paneActive &&
      now.paneTabs === before.paneTabs &&
      now.diffPanel === before.diffPanel
    );
  };
  try {
    const found = await resolveOutput(chat, path, cwd);
    if (!current()) return;
    if (!found) return toast('This output is no longer available.', 'error');
    const existing = get().paneTabs.find(
      (t) => t.kind === 'file' && t.ownerChat === chat && t.path && pathKey(t.path) === pathKey(found.path),
    );
    const exact = existing?.path ?? found.path;
    openPaneTab('file', { path: exact, cwd: found.cwd, ownerChat: chat, title: basename(exact), version: `manual:${++revision}` });
  } catch (error) {
    if (current()) toast(`Could not open output: ${errorText(error)}`, 'error');
  } finally {
    if (opening === token) opening = null;
  }
}
