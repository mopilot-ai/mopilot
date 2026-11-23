// A window opened for one chat carries its id in the location hash: "#thread=<encoded id>"; one opened on a sub-agent's page adds "&agent=<key>&title=<title>".
// Ids can hold ':' and other reserved characters (acp:<harness>:<id>), so they are URI-encoded.

import { wellFormedUriText } from '../../shared/uriText.mjs';
import { threadHash } from '../../shared/deepLink.mjs';

export { threadHash };

/** The chat id a window hash asks for, or null when it names none or can't be decoded. */
export function threadFromHash(hash: string): string | null {
  const raw = /(?:^|&)thread=([^&]+)/.exec(hash.replace(/^#/, ''))?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** The hash that opens a window on one sub-agent's page in a chat. */
export function agentHash(chatId: string, key: string, title: string): string {
  return `${threadHash(chatId)}&agent=${encodeURIComponent(key)}&title=${encodeURIComponent(wellFormedUriText(title))}`;
}

/** The sub-agent a window hash asks to open, or null when it names none (or can't be decoded). */
export function agentFromHash(hash: string): { key: string; title: string } | null {
  const q = hash.replace(/^#/, '');
  const raw = /(?:^|&)agent=([^&]+)/.exec(q)?.[1];
  if (!raw) return null;
  try {
    const title = /(?:^|&)title=([^&]*)/.exec(q)?.[1];
    return { key: decodeURIComponent(raw), title: title ? decodeURIComponent(title) : 'Agent' };
  } catch {
    return null;
  }
}
