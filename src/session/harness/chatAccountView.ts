// The account a chat runs on and its plan's usage windows, shared by Status, context and the composer usage popover.
import { useChatAccount, useHarnessAccounts, useHarnessStatus } from './select';
import { rowAccountInfo } from '../../harness/accounts';
import type { HarnessId } from '../../harness/types';

/**
 * The harness's status, its default and the chat's login (one picked with a pending switch, pinned or moved), and that login's plan, usage windows
 * and when they were read (ms; null when not known).
 */
export function useChatAccountView(h: HarnessId, threadId: string | null, picked?: string | null) {
  const status = useHarnessStatus(h);
  const { active: def, accounts } = useHarnessAccounts(h);
  const own = useChatAccount(h, threadId);
  // `picked`: a login chosen with a switch that waits for the next message, ahead of the chat's own
  const account = (picked && accounts.find((a) => a.id === picked)) || (own && accounts.find((a) => a.id === own.serving)) || def;
  const { plan, usage } = rowAccountInfo(status, def, account);
  // when the login's own reading was taken: the harness status stamps an unpooled Codex login's live windows with now
  return { status, def, accounts, own, account, plan, windows: usage?.windows ?? [], at: account?.usage.at || null };
}
