// Shared context-panel compaction state: queue behind a running turn, show pending native work, and retain capability refusals.
import { useState } from 'react';
import { useStore } from '../../store/core';
import { blockedReason } from '../../store/chats';
import { compactThread } from '../../store/actions';
import type { TurnState } from '../../store/types';
import { useChatCaps } from '../../store/session/useCaps';
import { useEffectOn } from '../../lib/effects';
import { ignoring } from '../../lib/ignored';
import { useSessionField } from '../../store/session/useSession';

/** Running turns queue compaction; capability and ownership refusals still block it. */
export function compactBlocked(blocked: string | null, state: string | null): string | null {
  if (blocked) return blocked;
  if (state === 'absent') return "This agent can't compact chats.";
  return state === 'disabled' ? "Compacting isn't available in this chat right now." : null;
}

/** A turn that only compacts: no message in it but a /compact (a harness that compacts by command sends one). */
export function onlyCompacts(turn: Pick<TurnState, 'items'>): boolean {
  return turn.items.every(
    (i) =>
      i.type !== 'userMessage' ||
      /^\s*\/(?:compact|compress)\b/.test(i.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')),
  );
}

/**
 * The chat's Compact action. `compacting` holds from the click while the request runs, then while a turn started
 * after it runs and only compacts. A turn after the click that is not one (the user's message, after a request the
 * harness refused) or that ended stops it, so a later turn never reads as compacting.
 */
export function useCompact(threadId: string, running: boolean) {
  const caps = useChatCaps(threadId);
  const lastId = useStore((s) => s.runtime[threadId]?.turns?.at(-1)?.id ?? null);
  const lastStatus = useStore((s) => s.runtime[threadId]?.turns?.at(-1)?.status);
  const waiting = useSessionField(threadId, (s) => s.queue.some((q) => !!q.opts.compact));
  const active = useSessionField(threadId, (s) => s.compaction === 'active' || !!s.activeTurn?.compact);
  const [request, setRequest] = useState<{ chatId: string; before: string | null; sending: boolean } | null>(null);
  const own = request?.chatId === threadId ? request : null;
  const sending = !!own?.sending;
  // read only once something was asked: a streamed frame of the last turn changes none of these
  const lastOnlyCompacts = useStore((s) => {
    const last = s.runtime[threadId]?.turns?.at(-1);
    return !!own && !!last && onlyCompacts(last);
  });
  const after = !!own && lastId !== null && lastId !== own.before;
  const theirs = after && running && lastStatus === 'inProgress' && lastOnlyCompacts;
  const queued = waiting || (sending && running && !theirs && !active);
  const compacting = active || (!queued && (sending || theirs));
  useEffectOn([after, theirs, sending], () => {
    if (after && !theirs && !sending) setRequest(null);
  });
  const why = compacting ? null : compactBlocked(blockedReason(threadId, 'compact'), caps.loaded ? caps.caps.compact.state : null);
  const compact = () => {
    if (why || queued || compacting) return;
    const pending = { chatId: threadId, before: lastId, sending: true };
    setRequest(pending);
    void compactThread(threadId)
      .then((receipt) => {
        if ((receipt as { action?: string } | undefined)?.action !== 'started')
          setRequest((current) => (current === pending ? null : current));
      })
      .catch((error) => {
        ignoring("compact a chat's context from its context panel")(error);
        setRequest((current) => (current === pending ? null : current));
      })
      .finally(() => setRequest((current) => (current === pending ? { ...pending, sending: false } : current)));
  };
  const label = queued ? 'Compaction queued' : compacting ? 'Compacting…' : running ? 'Compact after turn' : 'Compact now';
  return { why, queued, compacting, compact, label };
}
