// Above the composer while Codex's own computer use (the unified-computer-use plugin) releases the
// browser or app it used in the last turn, or when it did not confirm it did. It does not block the
// chat: the next turn starts right away, and only its next native browser or computer operation waits
// for the release (electron/capabilities/contract/codexLifecycle.cjs). It is never a takeover signal.
import { useSession } from '../../store/session/useSession';
import { native } from '../../lib/native';
import { connect } from '../../store/connection';
import { toastFailure } from '../../store/core';
import { Spinner, AlertTriangle } from '../ui/icons';

export function NativeCleanup({ threadId }: { threadId: string }) {
  const c = useSession(threadId).nativeCleanup;
  if (!c) return null;
  const releasing = c.phase === 'releasing';
  return (
    <div className="elsewhere-notice cu-activity" role="status" data-state={c.phase}>
      <span className="elsewhere-icon">{releasing ? <Spinner /> : <AlertTriangle size={14} />}</span>
      <div className="elsewhere-text">
        <div className="elsewhere-title">
          {releasing ? 'Releasing browser/computer…' : 'Codex didn’t confirm it let go of control. Restart Codex to unblock it.'}
        </div>
      </div>
      {!releasing && (
        <div className="elsewhere-actions">
          <button
            className="btn-pill"
            title="Codex turns running in other chats stop too"
            onClick={() =>
              native.codex
                .restart()
                .then(() => connect())
                .catch(toastFailure("Couldn't restart Codex"))
            }
          >
            Restart Codex
          </button>
        </div>
      )}
    </div>
  );
}
