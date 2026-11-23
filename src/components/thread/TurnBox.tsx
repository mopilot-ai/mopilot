// A chat's own task list and wrap-up box (main's update_task_list and wrap_up), under its latest message: the list as
// the agent keeps it, or a turn's native plan (Codex's plan, Claude Code's TodoWrite and TaskCreate, an ACP agent's
// plan), as Claude Desktop's turn box shows it (no header, twelve steps at a time, "Plan from before your last
// message" until the agent updates it; src/store/turnPlan.ts decides which and when), and at the end of a turn its
// recap with one question and the answers the user can click, in place of the list.
import { useEffect, useMemo, useState } from 'react';
import type { OrchestrationView } from '../../../shared/orchestration';
import type { TurnState } from '../../store/types';
import { sendOrDraft } from '../../store/send';
import { useStore } from '../../store/core';
import { linkedChildren, sideSessionForItem, useOrchestration } from '../../lib/sideSessions';
import { authoredFor, markedInputFor } from '../../lib/authoredInput';
import { isMomoChat } from '../../lib/momoChats';
import { ensureSession, useSessions } from '../../store/session/useSession';
import { turnBusy } from '../../store/session/sessionState';
import { boxPlan, boxShows } from '../../store/turnPlan';
import { ignoring } from '../../lib/ignored';
import { TodoSteps } from './Items';
import { useTasksPill } from '../tasks/TasksPill';
import { pluralize } from '../../lib/format';
import { TaskPlanRecovery } from './TaskPlanRecovery';

/** How many steps the box shows at once, as Claude Code's turn box. */
export const VISIBLE_STEPS = 12;

/**
 * Claude Code's window on a long list: `size` steps from the one before the first step in progress (or the first one
 * left), and how many came before it and how many after it are still to do.
 */
export function stepWindow<T extends { status: string }>(steps: T[], size = VISIBLE_STEPS) {
  const running = steps.findIndex((s) => s.status === 'inProgress');
  const left = running >= 0 ? running : steps.findIndex((s) => s.status !== 'completed');
  const from = Math.max(0, Math.min((left >= 0 ? left : steps.length) - 1, steps.length - size));
  const after = steps.slice(from + size);
  return {
    visible: steps.slice(from, from + size),
    hiddenBefore: from,
    openAfter: after.filter((s) => s.status !== 'completed').length,
  };
}

function WrapUpBox({ wrap, threadId, readOnly }: { wrap: OrchestrationView['wrapUps'][string]; threadId: string; readOnly: boolean }) {
  // the box an answer went from: its buttons go, so a reply waiting behind a busy turn is not sent twice
  const box = `${wrap.recap}\n${wrap.ask}`;
  const [answered, setAnswered] = useState<string | null>(null);
  return (
    <section className="wrap-up-box" aria-label="Where this stands">
      <p className="wrap-up-recap">{wrap.recap}</p>
      {wrap.ask && (
        <div className="wrap-up-ask">
          <span className="wrap-up-question">{wrap.ask}</span>
          {answered === box && <span className="wrap-up-sent">Sent</span>}
          {!readOnly && answered !== box && wrap.actions.length > 0 && (
            <span className="wrap-up-actions">
              {wrap.actions.map((a, i) => (
                // the answer goes as the user's own reply; a refused one waits in the composer
                <button
                  key={a.label}
                  type="button"
                  className={i === 0 ? 'btn-pill' : 'btn-pill soft'}
                  onClick={() => {
                    setAnswered(box);
                    // the user's own words (human) only when what goes is the label they clicked; a message the agent
                    // wrote behind it is not, so its turn can't start sessions on the user's word
                    const text = a.message ?? a.label;
                    void sendOrDraft(threadId, text, { human: text === a.label }).catch(ignoring('send an answer from the wrap-up box'));
                  }}
                >
                  {a.label}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** Linked work keeps the plan visible while waiting, but only an executing turn animates it. */
function useChildrenWork(view: OrchestrationView, threadId: string): 'idle' | 'waiting' | 'running' {
  const key = linkedChildren(view, threadId).join('\n');
  const ids = useMemo(() => (key ? key.split('\n') : []), [key]);
  // a child's row may not be mounted anywhere, so nothing else asks main for its session
  useEffect(() => {
    for (const id of ids) ensureSession(id);
  }, [ids]);
  return useSessions((st) => {
    let waiting = false;
    for (const id of ids) {
      const s = st.sessions[id];
      if (!s) continue;
      if (s.turn === 'running') return 'running';
      if (turnBusy(s) || s.queue.length > 0) waiting = true;
    }
    return waiting ? 'waiting' : 'idle';
  });
}

/** `turns`: the chat's turns, oldest first; the latest one's status decides when the list shows. */
export function TurnBox({ threadId, readOnly = false, turns = [] }: { threadId: string; readOnly?: boolean; turns?: TurnState[] }) {
  const view = useOrchestration();
  const wrap = view.wrapUps[threadId];
  const childrenWork = useChildrenWork(view, threadId);
  // background tasks the turn left running (not those waiting on the user) carry its plan on after it ends
  const tasksRunning = useTasksPill(threadId).running > 0;
  const authored = useStore((st) => st.authoredInputs);
  // only the user's own message makes the list stale: never a delivery or an input no human wrote
  const plan = boxPlan(
    turns,
    view.plans[threadId],
    (item) => !!sideSessionForItem(view, item) || !!authoredFor(authored, threadId, item) || !!markedInputFor(item),
  );
  // MoMo's chats show no task list: its main chat takes unrelated requests for ever, so a plan would only ever be an old one (#4927)
  const momo = useStore((st) => isMomoChat(st.momoChats, threadId));
  // the plan from before the user's message, dismissed by the user: kept for the window, by what it says
  const [dismissed, setDismissed] = useState<string | null>(null);
  const planKey = plan?.stale ? JSON.stringify(plan.steps) : null;
  const show =
    plan && (planKey === null || planKey !== dismissed)
      ? boxShows(plan, turns.at(-1)?.status, childrenWork !== 'idle', tasksRunning, childrenWork === 'running')
      : null;
  if (momo || (!show && !wrap)) return null;
  const steps = show && plan ? plan.steps : [];
  const shown = stepWindow(steps);
  return (
    <div className={wrap ? 'turn-box' : 'turn-box with-tasks'}>
      {/* the wrap-up box takes the list's place, as in Claude Code */}
      {steps.length > 0 && !wrap && (
        <section className="todo-card turn-tasks" aria-label="Task list">
          {plan!.stale && (
            <p className="turn-tasks-more turn-tasks-stale">
              <span>Plan from before your last message</span>
              <button type="button" className="turn-tasks-dismiss" onClick={() => setDismissed(planKey)}>
                Dismiss
              </button>
            </p>
          )}
          {shown.hiddenBefore > 0 && <p className="turn-tasks-more">{pluralize(shown.hiddenBefore, 'earlier step', 'earlier steps')}</p>}
          <TodoSteps steps={shown.visible} active={show!.spin} />
          {!show!.spin &&
            (turns.at(-1)?.status === 'interrupted' || turns.at(-1)?.status === 'failed' || childrenWork === 'waiting') &&
            steps.some((s) => s.status !== 'completed') && (
              <TaskPlanRecovery
                key={`${threadId}:${JSON.stringify(steps)}`}
                threadId={threadId}
                failed={turns.at(-1)?.status === 'failed'}
                readOnly={readOnly}
                waiting={turns.at(-1)?.status !== 'interrupted' && turns.at(-1)?.status !== 'failed' && childrenWork === 'waiting'}
              />
            )}
          {shown.openAfter > 0 && <p className="turn-tasks-more">{`${shown.openAfter} more to go`}</p>}
        </section>
      )}
      {wrap && <WrapUpBox wrap={wrap} threadId={threadId} readOnly={readOnly} />}
    </div>
  );
}
