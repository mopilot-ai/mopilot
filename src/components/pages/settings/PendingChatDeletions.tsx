// Settings keeps offline chat retirement visible after the local chat and its toast have gone away.
import { useEffect, useState } from 'react';
import { native } from '../../../lib/native';
import { visiblePoll } from '../../../lib/visiblePoll';
import { noteIgnored } from '../../../lib/ignored';
import { pluralize } from '../../../lib/format';
export function PendingChatDeletions() {
  const [count, setCount] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () =>
      native.host
        .pendingDeletions?.()
        .then((rows) => {
          if (live) {
            setCount(rows.length);
            setFailed(false);
          }
        })
        .catch((e) => {
          noteIgnored('read pending machine chat deletions', e);
          if (live) setFailed(true);
        });
    void read();
    const stop = visiblePoll('host-chat-deletions', 10_000, read);
    return () => {
      live = false;
      stop();
    };
  }, []);
  if (failed)
    return (
      <p className="settings-group-desc" role="status">
        Pending chat deletions could not be read. Their files were kept; repair this app's storage, then retry.
      </p>
    );
  return count ? (
    <p className="settings-group-desc" role="status">
      {pluralize(count, 'chat deletion')} pending on your machines. They finish when the same paired machines reconnect.
    </p>
  ) : null;
}
