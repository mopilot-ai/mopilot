// The account hint a computer's pairing code carries (`acct`, with the masked email `who`): comparing it with this phone's own account says at the scan that the two are signed in differently, instead of a refusal from the relay half a minute later. A hint only: it is not in the pairing proof and nothing is trusted from it.
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/** What the computer writes for an account: the first 8 bytes of sha256("mopilot-acct-v1:" + the account service's user id), as lowercase hex. */
export const accountHint = (userId: string) => bytesToHex(sha256(utf8ToBytes(`mopilot-acct-v1:${userId}`)).slice(0, 8));

export type CodeHint = { acct: string; who: string | null };

/** The hint in a pairing code's text, or null when it carries none (an older computer) or one that is not well formed. */
export function hintOf(text: string): CodeHint | null {
  let q: unknown;
  try {
    q = JSON.parse(text);
  } catch {
    return null;
  }
  if (!q || typeof q !== 'object') return null;
  const { acct, who } = q as { acct?: unknown; who?: unknown };
  if (typeof acct !== 'string' || !/^[0-9a-f]{16}$/.test(acct)) return null;
  // the mask is only shown: a short line of plain characters, never anything that could pass for a control
  const shown = typeof who === 'string' && who.length <= 80 && !/\p{Cc}/u.test(who) ? who.trim() : '';
  return { acct, who: shown || null };
}

/** The computer's hint when it names an account other than this phone's; null when it names the same one, none, or this phone is not signed in. */
export function otherAccount(text: string, userId: string | null | undefined): CodeHint | null {
  if (!userId) return null;
  const hint = hintOf(text);
  return hint && hint.acct !== accountHint(userId) ? hint : null;
}
