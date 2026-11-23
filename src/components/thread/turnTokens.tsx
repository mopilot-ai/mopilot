// The tokens the running turn has used so far, as the activity line's "· 12.3k tokens": shown only once known.
import { createContext, useContext } from 'react';
import { useStore } from '../../store/core';
import type { ThreadRuntime } from '../../store/types';
import { formatTokens } from '../../lib/format';

/** The chat the transcript shows, for activity lines deep in it that read the chat's running turn. */
export const ActivityChat = createContext<string | null>(null);

/**
 * The running turn's tokens: the chat's total now less its total when the turn started. Null while no turn runs,
 * when either total is unknown (a harness that reports usage only on request), or before the turn has used any.
 */
export function turnTokens(rt: Pick<ThreadRuntime, 'activeTurnId' | 'tokenUsage' | 'turnStartTokens'> | undefined): number | null {
  if (!rt?.activeTurnId || rt.turnStartTokens == null || !rt.tokenUsage) return null;
  const used = rt.tokenUsage.total.totalTokens - rt.turnStartTokens;
  return used > 0 ? used : null;
}

/** "· 12.3k tokens" after the activity line's clock, while the chat's running turn has a count. */
export function TurnTokens() {
  const chatId = useContext(ActivityChat);
  const used = useStore((s) => (chatId ? turnTokens(s.runtime[chatId]) : null));
  if (used === null) return null;
  return <span className="claude-activity-tokens">· {formatTokens(used)} tokens</span>;
}
