// Conversation ancestry, voice and activity indicators for sidebar chats on every harness, and a linked session's last report.
import type { ReactNode } from 'react';
import { ELSEWHERE_LABEL } from '../../store/threads';
import type { Thread } from '../../store/types';
import { useVoice } from '../../session/voice';
import { useChatRowState } from '../../session/useChatRowState';
import type { SideSessionChild } from '../../../shared/orchestration';
import { Tooltip } from '../ui/Popover';
import { AppWindow, AudioLines, CircleAlert, GitFork } from '../ui/icons';

/**
 * Row status as one 8px dot: work pulses gray, waiting is yellow and unread is blue; completion has no mark, and a
 * failure is a red alert icon instead of a dot. src/styles/app/sidebar.css styles exactly these.
 */
export const DOT_STATUSES = ['working', 'waiting', 'unread', 'elsewhere'] as const;
export type DotStatus = (typeof DOT_STATUSES)[number];

export function RowDot({ status, label }: { status: DotStatus; label: string }) {
  return <span className={`row-dot ${status}`} role="img" aria-label={label} />;
}

export function ThreadForkIndicator({ thread }: { thread: Thread }) {
  if (!thread.forkedFromId) return null;
  return (
    <span className="thread-workspace">
      <Tooltip label="Forked conversation — inherits another chat's history">
        <GitFork size={16} role="img" aria-label="Forked conversation" />
      </Tooltip>
    </span>
  );
}

export function ThreadActivityIndicator({ thread, linked }: { thread: Thread; linked?: SideSessionChild }) {
  // the row's own record: always known, so there is always a state
  const { state, elsewhere, backgroundRunning } = useChatRowState(thread.id, linked, thread)!;
  const externalLabel = `Running in ${elsewhere ? ELSEWHERE_LABEL[elsewhere.app] : 'another app'}`;
  const dot = (status: DotStatus, label: string) => {
    const description = backgroundRunning && (state === 'approval' || state === 'input') ? `${label} · Background tasks running` : label;
    return (
      <Tooltip label={description}>
        <RowDot status={status} label={description} />
      </Tooltip>
    );
  };
  const failureMark = (label: string, description: string) => (
    <Tooltip label={description}>
      <CircleAlert size={16} role="img" aria-label={label} />
    </Tooltip>
  );
  let status: ReactNode = null;
  if (state === 'approval') status = dot(backgroundRunning ? 'working' : 'waiting', 'Awaiting approval');
  else if (state === 'input') status = dot(backgroundRunning ? 'working' : 'waiting', 'Needs input');
  else if (state === 'error' && backgroundRunning) status = dot('working', 'Working · chat failed · open chat to retry');
  else if (state === 'error') status = failureMark('Chat failed', 'Chat failed · open chat to retry');
  else if (state === 'working') status = dot('working', 'Working');
  else if (state === 'elsewhereRunning') status = dot('elsewhere', externalLabel);
  else if (state === 'failed') status = failureMark('Failed', 'Session failed · open it to read its report');
  else if (state === 'unread') status = dot('unread', 'Unread result');
  else if (elsewhere)
    status = (
      <Tooltip label={`Open in ${ELSEWHERE_LABEL[elsewhere.app]}`}>
        <AppWindow size={13} role="img" aria-label={`Open in ${ELSEWHERE_LABEL[elsewhere.app]}`} />
      </Tooltip>
    );
  // both failures are red: a chat's own and a linked session's last report
  return <span className={`row-status${state === 'error' || state === 'failed' ? ' error' : ''}`}>{status}</span>;
}

/** Voice sits before the PR and activity columns so it never displaces either one. */
export function ThreadVoiceIndicator({ threadId }: { threadId: string }) {
  const voice = useVoice((s) => s.threadId === threadId && ['connecting', 'listening', 'speaking'].includes(s.phase));
  if (!voice) return null;
  return (
    <Tooltip label="Voice chat active">
      <AudioLines size={16} role="img" aria-label="Voice chat active" />
    </Tooltip>
  );
}
