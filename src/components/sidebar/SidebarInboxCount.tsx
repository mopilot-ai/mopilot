// A sidebar row's own unanswered requests on every harness; family totals stay in the PR inbox and status line.
import type { RefObject } from 'react';
import { useOnScreen } from '../../lib/onScreen';
import { useChatRowState } from '../../session/useChatRowState';
import styles from '../thread/prInbox.module.css';

/** Off-screen rows need no additional subscription; a leaf, parent or detached chat always names only itself. */
export function SidebarInboxCount({ threadId, row }: { threadId: string; row: RefObject<Element | null> }) {
  const onScreen = useOnScreen(row);
  return onScreen ? <OwnCount threadId={threadId} /> : null;
}

function OwnCount({ threadId }: { threadId: string }) {
  const count = useChatRowState(threadId)?.attentionCount ?? 0;
  if (!count) return null;
  const label = count === 1 ? '1 request needs you' : `${count} requests need you`;
  return (
    <span className={styles.rowCount} role="img" aria-label={label} title={label}>
      {count}
    </span>
  );
}
