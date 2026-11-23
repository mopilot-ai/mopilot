// Whether a chat is one of MoMo's, for the views that leave the coding side's chrome out of it (#2279): the composer's
// pickers and + menu items, a side chat's empty state, and the side pane's read-only questions; and the one seam MoMo
// fills the composer's model-picker slot through (its brain chip).
import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from '../../store/core';
import { isMomoChat } from '../../lib/momoChats';

/** Whether chat `threadId` is one of MoMo's: its composer and transcript show none of the coding side's chrome. */
export const useMomoChat = (threadId: string | null | undefined) => useStore((s) => isMomoChat(s.momoChats, threadId));

/** What a MoMo chat's composer shows in the model picker's slot (MoMo's brain chip, provided around its chat); nothing by default. */
export const MomoModelSlot = createContext<ReactNode>(null);

/** The model picker's slot in a MoMo chat's composer: whatever MomoModelSlot provides. */
export function MomoModel() {
  return useContext(MomoModelSlot);
}

/** What a MoMo chat's composer says in its empty field: "Message MoMo", or "Message #name" in a channel (A2). */
export const MomoPlaceholder = createContext('Message MoMo');
