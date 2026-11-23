// hostAsk (the folder, editor, keep-awake and worktree tools, any harness) and gatewayTool (a tool of an MCP server the gateway runs: Allow once, Always allow): one question with the details it is about and one
// button per choice. Esc denies; 1, 2 and Enter choose unless the question is destructive, which only a click answers.
import { useRef } from 'react';
import { useWindowListener } from '../../../lib/effects';
import type { SageApprovalParams } from '../../../lib/native';
import { Info } from '../../ui/icons';
import { approvalKey, approvesOnEnter, cardOwnsKey, isTypingTarget } from '../approvalLogic';
import { answerSageCard, humanClick } from './shared';

export function HostAskCard({ id, params }: { id: string; params: SageApprovalParams }) {
  const root = useRef<HTMLDivElement>(null);
  const choices = params.choices ?? [];
  const choose = (choice: string) => answerSageCard(id, { decision: 'allow', choice });
  const deny = () => answerSageCard(id, { decision: 'deny' });
  useWindowListener('keydown', (event) => {
    if (isTypingTarget(event.target as HTMLElement | null) || document.querySelector('.popover-layer') || !cardOwnsKey(event, root.current))
      return;
    const key = approvalKey(event, { choices: choices.length, destructive: params.destructive === true });
    if (key?.type === 'deny') {
      event.preventDefault();
      deny();
    } else if (key?.type === 'choose' && choices[key.index]) {
      event.preventDefault();
      choose(choices[key.index].id);
    } else if (!params.destructive && choices[0] && approvesOnEnter(event)) {
      event.preventDefault();
      choose(choices[0].id);
    }
  });
  return (
    <div ref={root} className="approval-card sage-approval" data-kind={params.kind === 'gatewayTool' ? 'gatewayTool' : 'hostAsk'}>
      <div className="approval-top">
        <div className="approval-kind">
          <Info size={18} />
          <span>{params.title}</span>
        </div>
        <div className="approval-message">{params.message}</div>
        {(params.details ?? []).map((line) => (
          <p key={line} className="sage-access-hint" title={line}>
            <code>{line}</code>
          </p>
        ))}
      </div>
      <div className="approval-foot">
        <button type="button" className="ap-btn deny" onClick={humanClick(deny)}>
          Deny <kbd>Esc</kbd>
        </button>
        {choices.map((c, i) => (
          <button key={c.id} type="button" className="ap-btn allow solo" onClick={humanClick(() => choose(c.id))}>
            {c.label} {!params.destructive && i < 2 && <kbd>{i === 0 ? '⏎' : '2'}</kbd>}
          </button>
        ))}
      </div>
    </div>
  );
}
