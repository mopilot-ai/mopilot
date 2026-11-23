// Remaining usage in the account menus: each account's status text, naming the window it is about, and the
// refresh when the menu opens.

import { useEffect } from 'react';
import { accountStatusText, type Account } from './accounts';
import { tightestWindow, windowSuffix } from './usageWindows';
import { noteIgnored } from '../lib/ignored';

/** Below this much left, an account's usage reads as a warning. */
export const LOW_LEFT = 15;

/**
 * An account's status with the window its "x% left" is about ("12% left (weekly)"), warning when little is
 * left. Every other status (signed out, limit reached, billed per token, credits) is accountStatusText's.
 */
export function accountLimitText(a: Account): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  const t = accountStatusText(a);
  if (a.left == null || a.limited || a.status !== 'ok' || !t.text.startsWith(`${a.left}% left`)) return t;
  const text = t.text.replace('% left', `% left${windowSuffix(tightestWindow(a.usage.windows))}`);
  return { text, tone: t.tone === 'ok' && a.left < LOW_LEFT ? 'warn' : t.tone };
}

/** Refresh pooled readings on menu open without dropping cached usage on failure. */
export function useAccountMenuUsageRefresh(count: number, refresh?: () => Promise<unknown>) {
  useEffect(() => {
    if (count > 0 && refresh)
      // the menu keeps showing the cached usage
      refresh().catch((error) => noteIgnored("refresh the accounts' usage for the account menu", error));
  }, [count, refresh]);
}
