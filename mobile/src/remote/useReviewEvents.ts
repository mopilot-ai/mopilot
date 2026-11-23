// Counts the times a followed chat's diff changed on the Mac (review.changed), coalesced so a running turn does not reload the screen for every edit.
import { useEffect, useState } from 'react';
import type { MobileRuntime } from '../contracts';

/** How long changes are gathered before the count moves. */
export const REVIEW_REFRESH_MS = 1500;

/** `enabled` is false where nothing shows the count, so the chat is not listened to for nothing. */
export function useReviewEvents(runtime: MobileRuntime, chatId: string, enabled = true) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = runtime.onEvent((message) => {
      if (message.ev !== 'review.changed' || message.chatId !== chatId || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        setVersion((n) => n + 1);
      }, REVIEW_REFRESH_MS);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [runtime, chatId, enabled]);
  return version;
}
