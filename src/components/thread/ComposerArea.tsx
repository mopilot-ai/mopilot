// What sits under a chat's transcript: the strips above the composer (waiting questions among them), an approval or a
// down harness's notice in its place, or the read-only note.
import { memo, type ReactNode } from 'react';
import { Composer } from '../composer/Composer';
import { AcpQuestions } from './AcpQuestions';
import { PrMonitorAlerts } from './PrMonitorAlerts';
import { Approvals } from './Approvals';
import { DockedQuestions } from './DockedQuestions';
import type { AsyncQuestionsItem } from '../../lib/asyncQuestions';
import { ElsewhereNotice } from './ElsewhereNotice';
import { StatusStrip } from './StatusStrip';
import { TaskPolling } from '../tasks/TaskPolling';
import { WorkingInStack } from './WorkingIn';
import { ClaudeInChromeNote } from '../browser/ClaudeInChromeNote';
import { Lock } from '../ui/icons';
import { HarnessDownNotice, useDownHarness } from './HarnessDownNotice';
import { useMomoChat } from '../momo/useMomoChat';
import { sideChatUuid } from '../../../shared/host/sideChats.mjs';

const noConfirm = () => {
  /* no confirm step while an approval shows */
};

/**
 * Memoized: its props are the chat and a few flags, so a streamed delta that re-renders the transcript leaves the
 * composer (and what the user is typing) alone. Each strip reads the store for what it shows.
 */
export const ComposerArea = memo(function ComposerArea({
  threadId,
  cwd,
  inPane,
  readOnly,
  composer,
  hasApproval,
  question = null,
  readOnlyNote,
}: {
  threadId: string;
  cwd: string;
  inPane: boolean;
  readOnly: boolean;
  composer: boolean;
  hasApproval: boolean;
  /** the agent's latest unanswered questions, which wait docked above the composer until answered or written past */
  question?: AsyncQuestionsItem | null;
  /** what a read-only view says instead of the sub-agent note */
  readOnlyNote?: ReactNode;
}) {
  // the harness the next message goes to is down: the chat can't send, and the notice says what can be done instead
  const down = useDownHarness(threadId);
  // A side chat or MoMo owns its own interactive pane. Other pane copies send answers through the original view.
  const momo = useMomoChat(threadId);
  return (
    <div className="thread-composer-area">
      <AcpQuestions threadId={threadId} readOnly={readOnly || (inPane && !momo && !sideChatUuid(threadId))} />
      {readOnly ? (
        <div className="read-only-note">
          <Lock size={13} /> {readOnlyNote ?? "A sub-agent's thread · Read only. Its parent chat runs it."}
        </div>
      ) : (
        <>
          <WorkingInStack threadId={threadId} />
          <ElsewhereNotice threadId={threadId} />
          <ClaudeInChromeNote threadId={threadId} />
          <TaskPolling chatId={threadId} />
          <PrMonitorAlerts key={threadId} chatId={threadId} />
          {hasApproval ? (
            <>
              <StatusStrip threadId={threadId} approval confirm={false} setConfirm={noConfirm} />
              <Approvals threadId={threadId} cwd={cwd} />
            </>
          ) : composer && down ? (
            <HarnessDownNotice threadId={threadId} family={down} />
          ) : composer ? (
            <>
              {/* docked above the composer, as Claude Code docks its question card: the user can still write instead */}
              {question && <DockedQuestions threadId={threadId} cwd={cwd} item={question} />}
              <Composer threadId={threadId} variant="thread" inPane={inPane} />
            </>
          ) : null}
        </>
      )}
    </div>
  );
});
