// A one-time consent for a change an agent's tool asks to make (a setting, a connector, a sidebar section): the broker's
// 'consent' card. It allows or denies exactly this change; only a person's input answers it.
import { useRef } from 'react';
import { useWindowListener } from '../../../lib/effects';
import type { SageApprovalParams } from '../../../lib/native';
import { SlidersHorizontal } from '../../ui/icons';
import { approvalKey, approvesOnEnter, cardOwnsKey, isTypingTarget } from '../approvalLogic';
import { AllowSplit, answerSageCard, humanClick, useSourceLabel } from './shared';

export function ConsentApproval({ id, threadId, params }: { id: string; threadId: string; params: SageApprovalParams }) {
  const root = useRef<HTMLDivElement>(null);
  const agent = useSourceLabel(threadId, params);
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
    <div ref={root} className="approval-card sage-approval" data-kind="consent">
      <div className="approval-top">
        <div className="approval-kind">
          <SlidersHorizontal size={18} />
          <span>Change</span>
        </div>
        <div className="approval-message">{`Allow ${agent} to ${params.summary ?? 'make a change'}?`}</div>
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
