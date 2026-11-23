// Plan tabs belong to stable chats and open a specific proposal or the chat's latest proposal.
import { identityKey } from '../../../shared/identityKey.mjs';
import { viewChats } from '../../lib/agentTabs';
import { get, set } from '../core';
import { chatOf } from '../chats';
import { focusedChat } from '../split';
import type { PaneTab } from '../state';
import { openPaneTab } from '../panes';
import type { PlanSelection } from './document';

export function openPlanPane(threadId: string, plan?: PlanSelection) {
  const s = get();
  const chat = chatOf(threadId);
  const id = identityKey('plan', chat);
  const tab: PaneTab = { id, kind: 'plan', ownerChat: chat, threadId: chat, plan, title: 'Plan' };
  const existing = s.paneTabs.some((t) => t.id === id);
  const paneTabs = existing ? s.paneTabs.map((t) => (t.id === id ? tab : t)) : [...s.paneTabs, tab];
  // A card disposed during navigation can retain its tab without taking over the new chat's pane.
  if (!viewChats(focusedChat(s), s.paneTabs).has(chat)) return set({ paneTabs });
  openPaneTab('plan', tab);
}
