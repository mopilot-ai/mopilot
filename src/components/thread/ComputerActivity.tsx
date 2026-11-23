// The strip above the composer while an agent controls the Mac from this chat: what it controls, take over, resume and stop.

import { navigate } from '../../store/panes';
import { threadTitle, useStore } from '../../store/core';
import { useSession } from '../../store/session/useSession';
import { native } from '../../lib/native';
import { copy } from '../../harness/copy';
import { useAppIdentity } from '../../lib/appNames';
import { Hand, Hourglass } from '../ui/icons';
import { ComputerPermissionCard } from './ComputerPermissionCard';
import { DONE_CONTINUE } from '../../lib/doneContinue';
import { liveClick } from '../../store/liveAction';

/** Who is reading the screen: a vision model (and where the screenshot goes), or this Mac as text. */
function readText(read: NonNullable<ReturnType<typeof useSession>['computer']>['read']): string {
  return read && 'model' in read
    ? copy('computerUse', 'visionModelReads', { 'vision model': read.model, vendor: read.vendor })
    : copy('computerUse', 'readsAsText');
}

/**
 * Above the composer while an agent controls the Mac from this chat (the chat's layer of the three
 * indicators; the helper's glow and the tray are the others), one line: "Controlling <icon> Notes · Esc to
 * stop" and Stop (moving the mouse still takes over), "You took over <icon> Notes" with Done, continue, or
 * "<icon> TextEdit · in use by "Trip"" with View while another chat has the desktop.
 */
export function ComputerActivity({ threadId }: { threadId: string }) {
  const c = useSession(threadId).computer;
  // "your Mac": the chat holds the desktop before it named an app
  const whole = !c?.app || c.app === 'your Mac';
  const app = useAppIdentity(whole ? '' : c.app);
  // the chat holding the desktop, by its title when this window knows it
  const holder = useStore((s) => {
    const t = c?.holder && c.holder !== threadId ? s.threads[c.holder] : null;
    return t ? threadTitle(t) : null;
  });
  if (!c) return null;
  if (c.state === 'permission') return <ComputerPermissionCard threadId={threadId} permission={c.permission ?? 'accessibility'} />;
  // While the agent works the strip carries Claude Desktop's pulsing dot (styles: control-cards.css)
  let icon = <span className="cu-activity-dot" />;
  // one quiet line (Claude Design option 1A): a verb, the app (icon and display name), then a muted hint
  let lead: string | null = whole ? 'Using your computer' : 'Using';
  let named = !whole;
  let hint: string | null = null;
  let action: React.ReactNode = null;
  if (c.state === 'takeover') {
    icon = <Hand size={14} />;
    lead = whole ? 'You took over your computer' : 'You took over';
    action = (
      <button className="btn-pill" onClick={(e) => e.nativeEvent.isTrusted && liveClick(native.computer.resume(threadId))}>
        {DONE_CONTINUE}
      </button>
    );
  } else if (c.state === 'waiting') {
    icon = <Hourglass size={14} />;
    lead = whole ? 'Your computer' : null;
    hint = holder ? `in use by “${holder}”` : 'in use by another chat';
    if (c.holder && c.holder !== threadId)
      action = (
        <button className="btn-pill ghost" onClick={() => navigate({ name: 'thread', id: c.holder! })}>
          View
        </button>
      );
  } else if (c.state === 'reading') {
    lead = readText(c.read);
    named = false;
  } else {
    hint = `Esc to stop${c.read ? ` · ${readText(c.read)}` : ''}`;
    action = (
      <button className="btn-pill ghost" onClick={(e) => e.nativeEvent.isTrusted && liveClick(native.computer.stop(threadId))}>
        Stop
      </button>
    );
  }
  return (
    <div className="elsewhere-notice cu-activity" role="status" data-state={c.state}>
      <span className="elsewhere-icon">{icon}</span>
      <div className="elsewhere-text">
        <div className="elsewhere-title">
          {lead}
          {lead && named ? ' ' : null}
          {named && (
            <span className="cu-activity-app">
              {app.icon && <img className="cu-activity-app-icon" src={app.icon} alt="" />}
              {app.name}
            </span>
          )}
          {hint && <span className="cu-activity-hint"> · {hint}</span>}
        </div>
      </div>
      {action && <div className="elsewhere-actions">{action}</div>}
    </div>
  );
}
