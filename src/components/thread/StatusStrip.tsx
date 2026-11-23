// The one status strip above the composer: computer control, else native-control cleanup, else a pending approval, else Your Chrome
// waiting for the user to approve its connection in Chrome, else an app the
// agent works in in the background, else Claude in Chrome disconnected, else the double Esc's Stop all question. The
// running-tasks count lives in the turn's status line, and the goal in its pill above the composer (ComposerPills;
// lib/statusStrip.ts has the order).
import { useSession } from '../../store/session/useSession';
import { chromeLinkDropped, pickStrip } from '../../lib/statusStrip';
import { ComputerActivity } from './ComputerActivity';
import { AppControlStrip } from './AppControlStrip';
import { StopAllConfirm, useTasksPill } from '../tasks/TasksPill';
import { NativeCleanup } from './NativeCleanup';
import { ChromeLinkNotice } from './ChromeLinkNotice';
import { ChromeApprovalNotice } from './ChromeApprovalNotice';

export function StatusStrip({
  threadId,
  approval,
  confirm,
  setConfirm,
}: {
  threadId: string;
  approval: boolean;
  confirm: boolean;
  setConfirm: (v: boolean) => void;
}) {
  const s = useSession(threadId);
  const pill = useTasksPill(threadId);
  // Stop all offers to stop everything unsettled, a task parked on an approval included
  const stopAll = confirm && pill.live > 0;
  // the Stop-all question is the user's own, and answers the Esc they just pressed
  const item = pickStrip({
    computer: !!s.computer,
    nativeCleanup: !!s.nativeCleanup,
    approval,
    chromeApproval: s.chromeApproval,
    appControl: !!s.appControl?.apps.length,
    chromeLink: chromeLinkDropped(s),
    tasks: stopAll,
  });
  switch (item) {
    case 'computer':
      return <ComputerActivity threadId={threadId} />;
    case 'appControl':
      return <AppControlStrip threadId={threadId} />;
    case 'nativeCleanup':
      return <NativeCleanup threadId={threadId} />;
    case 'chromeApproval':
      return <ChromeApprovalNotice />;
    case 'chromeLink':
      return <ChromeLinkNotice threadId={threadId} />;
    case 'tasks':
      return <StopAllConfirm chatId={threadId} running={pill.live} setConfirm={setConfirm} />;
    default:
      return null;
  }
}
