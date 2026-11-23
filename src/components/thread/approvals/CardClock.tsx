// "Pauses in 20 min" under a waiting card of a machine chat, once the Host's reminder has gone: the Host's clock (the chat's `attention.since`), counted down by the minute here and never started here. Behind `host.unattended`; nothing for a chat the Host does not time.
import { useEffect, useState } from 'react';
import { useChatAttention } from '../../../lib/chatAttention';
import { visiblePoll } from '../../../lib/visiblePoll';
import { pausesIn } from '../../../../shared/host/cardLine.mjs';

export function CardClock({ threadId }: { threadId: string | null | undefined }) {
  const attention = useChatAttention(threadId ?? null);
  const [now, setNow] = useState(() => Date.now());
  const since = attention?.kind === 'approval' ? attention.since : undefined;
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    return visiblePoll('approval-clock', 30_000, () => setNow(Date.now()));
  }, [since]);
  const text = since === undefined ? null : pausesIn(since, now);
  return text ? <div className="approval-clock">{text}</div> : null;
}
