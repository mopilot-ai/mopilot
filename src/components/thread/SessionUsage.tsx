// What a linked session has used, under its live card's caption (SessionCard.tsx): its working time, as main timed its
// turns, and its tokens when this window has the session's usage ("4m 12s · 12k tokens"); and the files it edited
// outside the paths it declared for a shared folder. No cost: not every harness reports one.
import { useStore } from '../../store/core';
import { reportedTokenUsage } from '../../store/contextUsage';
import { formatDuration, formatTokens } from '../../lib/format';
import { useNow } from './items/presentation';
import type { SideSessionChild } from '../../../shared/orchestration';

/** Files the warning names; the rest are counted. */
const NAMED = 3;

/** Its working time at `now`: its ended turns' and the running one's so far. Null before its first turn. */
export function workedMs(worked: SideSessionChild['worked'], now: number): number | null {
  if (!worked) return null;
  return worked.ms + (worked.since != null ? Math.max(0, now - worked.since) : 0);
}

/** "4m 12s · 12k tokens" from what is known (under a second of work and no tokens read as nothing); '' for nothing. */
export function usageLine(ms: number | null, tokens: number | null): string {
  const parts: string[] = [];
  if (ms != null && ms >= 1000) parts.push(formatDuration(ms));
  if (tokens != null && tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  return parts.join(' · ');
}

/** "Edited outside its paths: a, b and 2 more", or null when it kept to them. */
export function outsideLine(outside: string[] | null | undefined): string | null {
  if (!outside?.length) return null;
  const more = outside.length > NAMED ? ` and ${outside.length - NAMED} more` : '';
  return `Edited outside its paths: ${outside.slice(0, NAMED).join(', ')}${more}`;
}

export function SessionUsage({ chatId, linked }: { chatId: string; linked: SideSessionChild | undefined }) {
  // the chat's own count, only while it describes the chat's current session (the context ring's rule)
  const tokens = useStore((s) => reportedTokenUsage(s, chatId)?.total.totalTokens ?? null);
  const now = useNow(linked?.worked?.since != null);
  const line = usageLine(workedMs(linked?.worked, now), tokens);
  const outside = outsideLine(linked?.outside);
  return (
    <>
      {line && <span className="session-card-usage">{line}</span>}
      {outside && (
        <span className="session-card-outside" title={`Declared paths: ${(linked?.paths ?? []).join(', ')}`}>
          {outside}
        </span>
      )}
    </>
  );
}
