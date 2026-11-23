// One plan card for both harnesses. Codex's comes from the plan item (or the last message of a
// plan-mode turn); Claude's from ExitPlanMode, which also names the file it saved the plan to (by name: the
// folder is the CLI's config folder, app data for an added login).
import { useLinkCwd } from '../../lib/remoteFolder';
import { settledText } from '../../lib/streamCut';
import type { ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { Markdown } from '../markdown/Markdown';
import { openMessageLink } from '../../session/open';
import { basename } from '../../lib/paths';
import { useStore } from '../../store/core';
import { useSession } from '../../store/session/useSession';
import { pendingPlan, type PlanItem } from '../../store/plans/document';
import { openPlanPane } from '../../store/plans/pane';

export { pendingPlan } from '../../store/plans/document';

export function PlanCard({
  item: own,
  cwd,
  threadId,
  turnId,
  children,
  streaming = false,
}: {
  item: PlanItem;
  cwd: string;
  threadId?: string | null;
  turnId?: string;
  children?: ReactNode;
  /** The plan is still streaming in: it shows up to where nothing shown changes form when the rest arrives. */
  streaming?: boolean;
}) {
  const linkCwd = useLinkCwd(cwd);
  const approvals = useSession(threadId).approvals;
  const activeTurnId = useStore((s) => (threadId ? s.runtime[threadId]?.activeTurnId : null));
  const item = pendingPlan(own, turnId && turnId === activeTurnId ? approvals : []);
  return (
    <div className="plan-card">
      <div className="plan-card-head plan-pane-card-head">
        <span>Plan</span>
        {threadId && (
          <button className="btn-pill" onClick={() => openPlanPane(threadId, turnId && item.id ? { turnId, itemId: item.id } : undefined)}>
            Open plan
          </button>
        )}
      </div>
      <Markdown text={settledText(item.text ?? '', streaming)} cwd={cwd} streaming={streaming} />
      {item.planFilePath && (
        <button
          className="plan-card-path"
          title={item.planFilePath}
          onClick={(e) => openMessageLink(item.planFilePath as string, linkCwd, e)}
        >
          <FileText size={12} strokeWidth={1.7} /> {basename(item.planFilePath)}
        </button>
      )}
      {children}
    </div>
  );
}
