// Links to a MoPilot chat in a reply (`mopilot:chat/<chat id>`, as the Mac's agents write them): the chat they name, and the opener the app provides so a tap opens it here instead of handing the link to iOS.
import { createContext } from 'react';

const PREFIXES = ['mopilot:chat/', 'mopilot://chat/'];

/** The chat a link names, or null for any other link. */
export function chatIdOfLink(url: string | undefined): string | null {
  if (!url) return null;
  const prefix = PREFIXES.find((p) => url.startsWith(p));
  if (!prefix) return null;
  const raw = url.slice(prefix.length).split(/[?#]/)[0];
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return id.trim() ? id : null;
}

/** Opens a chat on the computer the screen is showing, over the one it is in; `selected` is words its composer quotes (a side chat's). Undefined where no chat can be opened (a link then does nothing). */
export const ChatLinkContext = createContext<((chatId: string, selected?: string) => void) | undefined>(undefined);
