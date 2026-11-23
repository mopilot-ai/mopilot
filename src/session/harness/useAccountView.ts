// The store-bound account view (accountView.ts) of a first-class harness's accounts, built from the same store state
// on every account surface; the basic harnesses' and the MoPilot credits' are in useCreditsView.ts.
import { useMemo } from 'react';
import { useStore } from '../../store/core';
import { useHarnessAccounts, useHarnessStatus } from './select';
import { harnessAccountView, type AccountMeta, type HarnessAccountView } from '../../harness/accountView';
import type { HarnessId } from '../../harness/types';

/** One first-class harness's accounts, as every account surface shows them. */
export function useAccountView(h: HarnessId): HarnessAccountView {
  const st = useHarnessStatus(h);
  const view = useHarnessAccounts(h);
  const pool = useStore((s) => s.accounts.accounts);
  const claudeChats = useStore((s) => s.claudeChats);
  const meta = useMemo<AccountMeta>(() => {
    // the CLI's own login is "default" on both harnesses, listed or folded into an added one (accountView.ts foldMeta)
    if (h === 'codex')
      return { default: { cli: true }, ...Object.fromEntries(pool.map((a) => [a.id, { chats: a.chats, cli: a.isDefault }])) };
    const m: AccountMeta = { default: { cli: true } };
    for (const c of Object.values(claudeChats)) m[c.id] = { ...m[c.id], chats: (m[c.id]?.chats ?? 0) + 1 };
    return m;
  }, [h, pool, claudeChats]);
  return useMemo(() => harnessAccountView(st, view, meta), [st, view, meta]);
}
