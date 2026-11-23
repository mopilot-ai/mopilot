// Which card the page aims at (A2, #4846): a tapped push's or Tasks' Review names the chat a card waits in (a channel's id, null for Main), and the page shows that chat before it looks for the card there.
import { useEffect, useState } from 'react';
import { chatRef } from '../push/chatRef';
import type { MomoFocus } from './Momo';

/**
 * @param o.focus the tapped push's card and channel (null: none)
 * @param o.channelId the channel shown now (null: Main) and its setter
 * @param o.pairId the computer the handles are made for
 * @returns `aimedAt`: the newer of the push's focus and a Review tap; `reviewCard`: Review on a Tasks row
 */
export function useReviewFocus({
  focus,
  channelId,
  setChannelId,
  pairId,
}: {
  focus?: MomoFocus | null;
  channelId: string | null;
  setChannelId: (id: string | null) => void;
  pairId: string | null;
}) {
  const [reviewing, setReviewing] = useState<MomoFocus | null>(null);
  const aimedAt = reviewing && (!focus || reviewing.tap > focus.tap) ? reviewing : (focus ?? null);
  useEffect(() => {
    if (aimedAt && aimedAt.channel !== undefined && (aimedAt.channel ?? null) !== channelId) setChannelId(aimedAt.channel ?? null);
  }, [aimedAt, channelId, setChannelId]);
  /** Review on a card of Tasks: the chat it waits in (a channel, or Main) is shown, then the page scrolls to the card. */
  const reviewCard = (task: { ref: string; channel: { id: string } | null }) =>
    setReviewing({ card: pairId ? chatRef(pairId, task.ref) : null, channel: task.channel?.id ?? null, tap: Date.now() });
  return { aimedAt, reviewCard };
}
