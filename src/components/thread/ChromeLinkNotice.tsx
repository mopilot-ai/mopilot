// Above the composer when the chat's Claude Code session lost Claude in Chrome mid-session: the extension is
// no longer connected (electron/harness/claude/chromeLink.cjs reads it from the CLI). Reconnect does what the
// terminal's /chrome "Reconnect extension" does, in this chat's session; if the link stays down, the CLI's
// reconnect page opens in Chrome on request. It never blocks the chat.
import { useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { openLink } from '../../session/open';
import { useSession } from '../../store/session/useSession';
import { Unplug } from '../ui/icons';

const STILL_DOWN = 'Still disconnected. Check that Chrome is open and Claude is signed in.';

export function ChromeLinkNotice({ threadId }: { threadId: string }) {
  const link = useSession(threadId).chromeLink;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!link?.dropped) return null;
  const reconnect = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const results = await native.availability.chromeReconnect(threadId);
      if (!results.some((r) => r.link?.connected)) setFailed(results.find((r) => r.error)?.error ?? STILL_DOWN);
    } catch (e) {
      setFailed(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="elsewhere-notice chrome-link" role="status" data-state="disconnected">
      <span className="elsewhere-icon">
        <Unplug size={14} />
      </span>
      <div className="elsewhere-text">
        <div className="elsewhere-title">
          {link.browser ? `Claude in Chrome lost its connection to ${link.browser}` : 'Claude in Chrome is disconnected'}
        </div>
        {failed && <div className="elsewhere-body">{failed}</div>}
      </div>
      <div className="elsewhere-actions">
        <button className="btn-pill" disabled={busy} onClick={reconnect}>
          {busy ? 'Reconnecting…' : 'Reconnect'}
        </button>
        {failed && link.reconnectUrl && (
          <button className="btn-pill ghost" onClick={() => openLink(link.reconnectUrl!)}>
            Open in Chrome
          </button>
        )}
      </div>
    </div>
  );
}
