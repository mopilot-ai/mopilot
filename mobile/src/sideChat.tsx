// Start a side chat from a selection (#4837): the Mac's temporary fork of the chat, opened here with the selected words as a quote in its composer. What the selection menu says of it: offered, or greyed with the reason it cannot be (an older Mac, an agent without a fork, a chat on a machine); never an entry that does nothing.
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { Alert } from 'react-native';
import { ChatLinkContext } from './chatLinks';
import type { DraftHandle } from './presentation/drafts';
import type { Owned } from './remote/client';
import { sideChat, UPDATE, type ChatControls } from './remote/controls';
import { ReplyContext, withQuote } from './replyContext';
import { useTranslation } from './ui/i18n';

/** What the menu offers: start it, or the reason it cannot. */
export type SideChatMenu = { start: (selected: string) => void } | { why: string };

/** The menu's side chat entry for the replies on screen; null: no entry (not known yet, or nowhere to open it). */
export const SideChatContext = createContext<SideChatMenu | null>(null);

/** The words under a greyed entry, by what stops it. */
export type SideChatWhy = { machine: string; agent: string; nested: string };

/** The side chats this run of the app opened: a side chat is not forked again, as the Mac's is not. */
const made = new Set<string>();

/**
 * What the entry is for a chat: nothing until the Mac has said what it offers; the reason for a chat on a machine (the Host has no side chats),
 * an older Mac or a basic agent (the Mac has no temporary fork for it); else it starts one.
 */
export function sideChatMenu(
  controls: ChatControls | null,
  hostId: string | undefined,
  why: SideChatWhy,
  start: (selected: string) => void,
  chatId = '',
): SideChatMenu | null {
  if (!controls) return null;
  if (made.has(chatId)) return { why: why.nested };
  if (hostId || controls.machine) return { why: why.machine };
  if (!controls.methods.sideChat) return { why: UPDATE.menu };
  // a Mac's two built-in agents have a fork; any other is a basic agent, which has none
  if (controls.harness && controls.harness.id !== 'claude' && controls.harness.id !== 'codex') return { why: why.agent };
  return { start };
}

/** The side chat entry of an open chat: starts the fork on the Mac, then opens it with the quote; a refusal is said, in the Mac's words. */
function useSideChat(request: Owned, chatId: string, hostId: string | undefined, controls: ChatControls | null): SideChatMenu | null {
  const { t } = useTranslation();
  const open = useContext(ChatLinkContext);
  const busy = useRef(false);
  const machine = t('message.sideChatMachine');
  const agent = t('message.sideChatAgent');
  const nested = t('message.sideChatNested');
  const failed = t('message.sideChatFailed');
  return useMemo(() => {
    // nowhere to open it (no app around the chat to open one in): no entry
    if (!open) return null;
    // one start at a time: a second tap while the Mac is forking would open the same chat twice
    const start = (selected: string) => {
      if (busy.current) return;
      busy.current = true;
      void sideChat(request, chatId)
        .then(
          (id) => (made.add(id), open(id, selected)),
          (error: unknown) => Alert.alert(failed, error instanceof Error ? error.message : String(error)),
        )
        .finally(() => (busy.current = false));
    };
    return sideChatMenu(controls, hostId, { machine, agent, nested }, start, chatId);
  }, [open, request, chatId, controls, hostId, machine, agent, nested, failed]);
}

/**
 * What a selection in this chat's replies can do with the selected words: Ask puts them in this chat's composer as a quote chip and opens the keyboard, Start a side chat
 * opens a temporary fork of the chat with them in its composer. Neither is offered where the chat has no composer or is gone (`usable` false).
 */
export function SelectionActions({
  drafts,
  request,
  chatId,
  hostId,
  controls,
  usable,
  children,
}: {
  drafts: DraftHandle;
  request: Owned;
  chatId: string;
  hostId: string | undefined;
  controls: ChatControls | null;
  usable: boolean;
  children: ReactNode;
}) {
  const reply = useCallback(
    (selected: string) => {
      drafts.set(withQuote(drafts.get(), selected));
      drafts.focus?.();
    },
    [drafts],
  );
  const side = useSideChat(request, chatId, hostId, controls);
  return (
    <ReplyContext.Provider value={usable ? reply : null}>
      <SideChatContext.Provider value={usable ? side : null}>{children}</SideChatContext.Provider>
    </ReplyContext.Provider>
  );
}
