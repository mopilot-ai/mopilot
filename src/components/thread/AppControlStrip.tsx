// The strip above the composer while an agent works in an app in the background from this chat: thumbnail, take over and stop.

import { useSession } from '../../store/session/useSession';
import { native } from '../../lib/native';
import { useAppIdentity } from '../../lib/appNames';
import { AppWindow, Hand } from '../ui/icons';
import { DONE_CONTINUE } from '../../lib/doneContinue';
import { liveClick } from '../../store/liveAction';

/**
 * Above the composer while an agent works in an app in the background from this chat (on any harness;
 * main keeps SessionState.appControl, electron/capabilities/appVisibility.cjs): a live thumbnail of the
 * window, refreshed as it acts, what it works in, and how to take the app over (the agent's input there
 * waits until the user hands it back) or stop the chat. Only the user's own clicks count.
 */
export function AppControlStrip({ threadId }: { threadId: string }) {
  const apps = useSession(threadId).appControl?.apps ?? [];
  // an app the user took over stays on the strip until they hand it back, though the agent acts in another since
  const a = apps.find((e) => e.takenOver) ?? apps[0];
  const app = useAppIdentity(a?.app || a?.bundleId || '');
  if (!a) return null;
  // one quiet line (Claude Design 1A): the verb, the app (icon and display name), then the window and other apps;
  // a window titled as its app ("Calculator · Calculator") says nothing more
  const title = a.title && a.title !== app.name && a.title !== a.app ? a.title : null;
  const hint = a.takenOver ? '' : [title, apps.length > 1 ? `+${apps.length - 1}` : null].filter(Boolean).join(' · ');
  return (
    <div className="elsewhere-notice cu-activity cu-app" role="status" data-state={a.takenOver ? 'takenOver' : 'background'}>
      {a.thumbnail ? (
        <img className="cu-app-thumb" src={a.thumbnail} alt={`Live view of ${app.name}`} />
      ) : (
        <span className="elsewhere-icon">{a.takenOver ? <Hand size={14} /> : <span className="cu-activity-dot" />}</span>
      )}
      <div className="elsewhere-text">
        <div
          className="elsewhere-title"
          title={a.takenOver ? `The agent waits until you hand ${app.name} back` : `Working in ${app.name} in the background`}
        >
          {a.takenOver ? 'You took over ' : 'Using '}
          <span className="cu-activity-app">
            {app.icon ? <img className="cu-activity-app-icon" src={app.icon} alt="" /> : <AppWindow size={14} />}
            {app.name}
          </span>
          {hint && <span className="cu-activity-hint"> · {hint}</span>}
        </div>
      </div>
      <div className="elsewhere-actions">
        {a.takenOver ? (
          <button
            className="btn-pill"
            onClick={(e) => e.nativeEvent.isTrusted && liveClick(native.computer.handBack(threadId, a.bundleId))}
          >
            {DONE_CONTINUE}
          </button>
        ) : (
          <button
            className="btn-pill ghost"
            onClick={(e) => e.nativeEvent.isTrusted && liveClick(native.computer.takeOver(threadId, a.bundleId))}
          >
            <Hand size={13} /> Take over
          </button>
        )}
        <button className="btn-pill ghost" onClick={(e) => e.nativeEvent.isTrusted && liveClick(native.computer.stop(threadId))}>
          Stop
        </button>
      </div>
    </div>
  );
}
