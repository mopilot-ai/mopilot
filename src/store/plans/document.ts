// Shared proposal snapshots for the Plan pane, including pending approval text and plain-message plans.
import type { ApprovalParams, SessionApproval } from '../../harness/approvalRequests';
import { turnCard } from '../../harness/codexTranslate';
import type { TurnState } from '../types';
import type { PaneTab } from '../state';

export type PlanSelection = NonNullable<PaneTab['plan']>;

export type PlanItem = { id?: string; text?: string | null; planFilePath?: string | null };
export type PlanDocument = { id: string; turnId: string; text: string; path?: string | null; streaming: boolean };

/** The permission request can carry the plan before the tool result supplies it. */
export function pendingPlan(item: PlanItem, approvals: SessionApproval[]): PlanItem {
  if (item.text) return item;
  const req = approvals.find((a) => {
    const p = a.params as ApprovalParams | undefined;
    return a.method === 'claude/permission' && p?.toolName === 'ExitPlanMode' && !!item.id && p.toolUseID === item.id;
  });
  const input = (req?.params as ApprovalParams | undefined)?.input;
  if (!input) return item;
  return {
    ...item,
    text: typeof input.plan === 'string' ? input.plan : item.text,
    planFilePath: item.planFilePath ?? (typeof input.planFilePath === 'string' ? input.planFilePath : null),
  };
}

/** Read an explicit proposal, or the latest one. Task checklists are separate from proposal documents. */
export function planDocument(
  turns: readonly TurnState[],
  approvals: SessionApproval[],
  selection?: PlanSelection,
  activeTurnId?: string | null,
): PlanDocument | null {
  if (selection?.source === 'reply') return planReply(turns, selection);
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t];
    if (selection && turn.id !== selection.turnId) continue;
    const explicit = turn.items.filter((item) => item.type === 'plan');
    const card = explicit.length ? null : turnCard(turn.items, !!turn.planMode, turn.status === 'inProgress');
    const plans = explicit.length ? explicit : card?.kind === 'plan' ? [card.item] : [];
    for (let i = plans.length - 1; i >= 0; i--) {
      if (selection && plans[i].id !== selection.itemId) continue;
      const item = pendingPlan(plans[i], turn.id === activeTurnId ? approvals : []);
      return {
        id: plans[i].id,
        turnId: turn.id,
        text: item.text ?? '',
        path: item.planFilePath,
        streaming: turn.status === 'inProgress',
      };
    }
  }
  return null;
}

/** An explicit fallback for agents that propose plans as ordinary replies; never adopted automatically. */
export function planReply(turns: readonly TurnState[], selection?: PlanSelection): PlanDocument | null {
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t];
    if (turn.status !== 'completed' || (selection && turn.id !== selection.turnId)) continue;
    const item = turn.items.findLast(
      (i) => i.type === 'agentMessage' && !i.questions?.length && !!i.text.trim() && (!selection || i.id === selection.itemId),
    );
    if (item?.type === 'agentMessage') return { id: item.id, turnId: turn.id, text: item.text, streaming: false };
  }
  return null;
}
