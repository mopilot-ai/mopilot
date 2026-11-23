// A session-start limit or app continuation asks for one start only, with the existing trusted-input and broker ownership rules.
import { useRef } from 'react';
import { useWindowListener } from '../../../lib/effects';
import type { SageApprovalParams } from '../../../lib/native';
import { GitBranchPlus } from '../../ui/icons';
import { approvalKey, approvesOnEnter, cardOwnsKey, isTypingTarget } from '../approvalLogic';
import { AllowSplit, answerSageCard, humanClick, useSourceLabel } from './shared';

export function SessionStartApproval({ id, threadId, params }: { id: string; threadId: string; params: SageApprovalParams }) {
  const root = useRef<HTMLDivElement>(null);
  const harness = useSourceLabel(threadId, params);
  const summary = params.continued
    ? 'The app is continuing your request. Allow a new session?'
    : `It has requested ${params.count ?? 0} sessions since your last message.`;
  const allow = () => answerSageCard(id, { decision: 'allow', scope: 'once' });
  const deny = () => answerSageCard(id, { decision: 'deny' });
  useWindowListener('keydown', (event) => {
    if (isTypingTarget(event.target as HTMLElement | null) || document.querySelector('.popover-layer') || !cardOwnsKey(event, root.current))
      return;
    const key = approvalKey(event, { choices: 1, destructive: false });
    if (key?.type === 'deny') {
      event.preventDefault();
      deny();
    } else if (key?.type === 'choose' || approvesOnEnter(event)) {
      event.preventDefault();
      allow();
    }
  });
  return (
    <div ref={root} className="approval-card sage-approval" data-kind="sessionStart">
      <div className="approval-top">
        <div className="approval-kind">
          <GitBranchPlus size={18} />
          <span>New session</span>
        </div>
        <div className="approval-message">{harness} wants to start another session.</div>
        <p className="sage-access-hint">{summary}</p>
      </div>
      <div className="approval-foot">
        <button type="button" className="ap-btn deny" onClick={humanClick(deny)}>
          Deny <kbd>Esc</kbd>
        </button>
        <AllowSplit human label="Allow once" kbd="⏎" onAllow={allow} />
      </div>
    </div>
  );
}
