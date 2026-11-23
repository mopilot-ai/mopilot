// The pane's duplicate coordinator uses the authoritative renderer store and main's scoped history service.
import { BrowserDuplication } from '../lib/browserDuplicate';
import { get, set } from './core';
import { chatOf } from './chats';
import { native } from '../lib/native';
import { inView, viewChats } from '../lib/agentTabs';
import { focusedChat } from './split';

/** Whether the side pane's view (the focused pane's chat and the side chats in it, as panes.ts has it) shows `tab`. */
const shows = (tab: Parameters<typeof inView>[0]) => {
  const s = get();
  return inView(tab, viewChats(focusedChat(s), s.paneTabs), chatOf);
};
export const browserDuplication = new BrowserDuplication({ get, set, chatOf, shows, api: native.browser });
