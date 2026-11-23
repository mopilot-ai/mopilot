// Turn plan/review cards and edited-file undo/restore actions.
import { useChatMachine } from '../../../lib/chatMachine';
import { relPath } from '../../../lib/paths';
import { fileChangePatch } from '../../../lib/fileChangePatch';
import { useEffect, useRef, useState } from 'react';
import { toast, toastFailure, useStore } from '../../../store/core';
import { openChanges } from '../../../store/panes';
import { sendMessage } from '../../../store/send';
import { markTurnUndone } from '../../../store/turnDiffs';
import { IMPLEMENT_PLAN, type ReviewCardItem, type TurnCard } from '../../../harness/codexTranslate';
import { sessionOf, setSession } from '../../../store/session/useSession';
import type { ThreadItem, TurnState } from '../../../store/types';
import { PlanCard } from '../PlanCard';
import { latestReviewId } from '../../../lib/reviewState';
import { ReviewCard } from '../ReviewCard';
import { native } from '../../../lib/native';
import { errorText } from '../../../lib/ignored';
import type { DiffFile } from '../../diff/DiffView';
import { EditedFilesCard } from '../EditedFilesCard';

/** A turn's plan (with "Implement this plan" on the last one) or an inline review's result (with its fix and diff actions). */
export function TurnCardView({
  card,
  cwd,
  threadId,
  turnId,
  canImplement,
  running,
}: {
  card: TurnCard;
  cwd: string;
  threadId: string;
  turnId?: string;
  canImplement: boolean;
  running: boolean;
}) {
  if (card.kind === 'review') return <ReviewTurnCard item={card.item} cwd={cwd} threadId={threadId} running={running} />;
  const implement = () => {
    // back to default mode: the plan is carried out, not planned again (setSession cannot reject: a write main
    // didn't take is put right from main's copy)
    const planning = sessionOf(threadId).plan;
    void setSession(threadId, { plan: false });
    // it didn't go out: the chat goes back to plan mode if it was in it, unless the user changed it meanwhile
    const keepPlanning = () => {
      if (planning && !sessionOf(threadId).plan) void setSession(threadId, { plan: true });
    };
    sendMessage(threadId, IMPLEMENT_PLAN, [], {
      plan: false,
      human: true,
      acceptedPlan: { itemId: card.item.id, text: card.item.text },
    }).then(
      // false: main didn't take it, and sendMessage said why
      (sent) => sent === false && keepPlanning(),
      (e) => {
        toastFailure("Couldn't implement the plan")(e);
        keepPlanning();
      },
    );
  };
  // one plan card for both harnesses; Claude's also names the file it saved the plan to
  return (
    <PlanCard item={card.item} cwd={cwd} threadId={threadId} turnId={turnId}>
      {canImplement && !card.item.approvedInTurn && (
        <div className="plan-card-actions">
          <button className="btn-pill primary" onClick={implement}>
            Implement this plan
          </button>
        </div>
      )}
    </PlanCard>
  );
}

/** A review's card; only the chat's latest review can be fixed and walked. */
function ReviewTurnCard({ item, cwd, threadId, running }: { item: ReviewCardItem; cwd: string; threadId: string; running: boolean }) {
  const latest = useStore((s) => latestReviewId(s.runtime[threadId]?.turns) === item.id);
  return <ReviewCard item={item} cwd={cwd} chatId={threadId} latest={latest} running={running} />;
}

export type FileChangeItem = Extract<ThreadItem, { type: 'fileChange' }>;
export function EditedCard({
  threadId,
  turn,
  items,
  files,
  cwd,
}: {
  threadId: string;
  turn: TurnState;
  items: FileChangeItem[];
  files: DiffFile[];
  cwd: string;
}) {
  // the patch applies to this Mac's disk: a chat on a machine has no folder here, so its card offers no Undo
  const { machine, pending: locating } = useChatMachine(threadId);
  // on the turn, not the card: the Changes panel follows it, and a card scrolled out of view and back keeps it
  const undone = !!turn.undone;
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const undo = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const action = undone ? 'restore' : 'undo';
    try {
      const patch =
        turn.diff ??
        items
          .flatMap((it) => it.changes.filter((c) => c.path && files.some((f) => f.path === c.path)).map((c) => fileChangePatch(c, cwd)))
          .filter(Boolean)
          .join('\n');
      if (!patch.trim()) {
        toast(`Couldn't ${action}: No patch data is available`, 'error');
        return;
      }
      const result = await native.git.applyPatch(cwd, patch, !undone);
      // the disk changed even when the card has gone meanwhile: the turn says so, only the feedback is the card's
      if (result.ok) markTurnUndone(threadId, turn.id, !undone);
      if (!mounted.current) return;
      if (result.ok) {
        toast(undone ? 'Changes restored' : 'Changes undone');
      } else toast(`Couldn't ${action}: ${result.stderr.split('\n')[0] || 'Patch could not be applied'}`, 'error');
    } catch (error) {
      if (mounted.current) toast(`Couldn't ${action}: ${errorText(error)}`, 'error');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <EditedFilesCard
      files={files.map((file) => ({ ...file, label: relPath(file.path, cwd) }))}
      cwd={cwd}
      undone={undone}
      busy={busy}
      expanded={expanded}
      onExpand={setExpanded}
      onView={(file) => openChanges({ scope: 'turn', turnId: turn.id, file })}
      onUndo={machine || locating ? undefined : undo}
    />
  );
}
