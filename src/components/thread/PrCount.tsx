// The chat's shared PR rail and its detailed-tray button, kept outside the live activity line on every harness.
import { useCallback } from 'react';
import { releasePrAnchor, setPrLine, usePrLine } from './prLine';
import { PrInboxRail } from './PrInboxRail';
import { ChevronRight } from '../ui/icons';
import styles from './prInboxRail.module.css';

export function PrCount({ chatId }: { chatId: string }) {
  const { count, view, tray } = usePrLine(chatId);
  const anchor = useCallback(
    (el: HTMLButtonElement) => {
      setPrLine(chatId, { anchor: el });
      return () => releasePrAnchor(chatId, el);
    },
    [chatId],
  );
  if (!count || !view) return null;
  return (
    <PrInboxRail key={chatId} view={view}>
      <button
        ref={anchor}
        className={styles.summary}
        title="Pull requests from this chat and its sessions"
        aria-label={count.aria}
        aria-haspopup="dialog"
        aria-expanded={tray}
        // the one clicked: a line can draw this count twice for a moment, and the tray opens where the user is looking
        onClick={(e) => setPrLine(chatId, { tray: !tray, anchor: e.currentTarget })}
      >
        {count.label}
        <ChevronRight size={12} aria-hidden />
      </button>
    </PrInboxRail>
  );
}
