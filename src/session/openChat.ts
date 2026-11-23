// Opening a chat from a click, as Claude Desktop's Code tab does: a plain click shows it in the main pane, ⌥-click opens
// it in split view, and ⌘-click (Ctrl-click off macOS) in a window of its own. Every row and card that opens a chat
// goes through here, so none of them reads the modifiers on its own. Conversation links can keep a Cmd/Ctrl-click
// in this window; explicit menus and list navigation may still request a new one.

// read when a click calls them, so a module that only renders a chat link (Markdown's, a session card) needs nothing
// more of the store or the platform
import * as panes from '../store/panes';
import * as splitView from '../store/splitView';
import { threadHash } from '../lib/deepLink';
import { native } from '../lib/native';
import { noteIgnored } from '../lib/ignored';
import * as platform from '../lib/platform';

export type OpenChatWhere = 'here' | 'split' | 'window';

/** The words a chat's menus use for it: the native menu's "Open in" submenu, the React menu's two items. */
export const OPEN_IN = {
  menu: 'Open in',
  split: 'Split view',
  window: 'New window',
  splitItem: 'Open in split view',
  windowItem: 'Open in new window',
} as const;

/** Where a click with these modifiers opens a chat. */
export function openChatWhere(e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean }, mac?: boolean): OpenChatWhere {
  if (e.altKey) return 'split';
  return platform.modKey(e, mac) ? 'window' : 'here';
}

/** Opens `chatId` where the user asked: the main pane, split view, or a new window. */
export function openChat(chatId: string, where: OpenChatWhere) {
  if (where === 'split') return void splitView.openInSplit(chatId);
  if (where === 'window')
    return void native.win.open(threadHash(chatId)).catch((error) => noteIgnored('open a chat in a new window', error));
  panes.navigate({ name: 'thread', id: chatId });
}

/** Conversation links set newWindow false: Cmd/Ctrl stays here; Option can still open a split. */
export function openChatFrom(
  e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean },
  chatId: string,
  { newWindow = true }: { newWindow?: boolean } = {},
) {
  const where = openChatWhere(e);
  openChat(chatId, where === 'window' && !newWindow ? 'here' : where);
}
