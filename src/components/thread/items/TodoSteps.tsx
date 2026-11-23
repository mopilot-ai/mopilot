// Renders plan checklist steps for the transcript and the Plan pane.
import { withKeys } from '../../../lib/listKeys';
import type { TurnPlanStepStatus } from '../../../protocol/v2/TurnPlanStepStatus';
import type { TurnState } from '../../../store/types';
import { Check, DottedRing, Spinner } from '../../ui/icons';

/**
 * A step's marker and what a reader hears for it. The Record is the guard: a value added to
 * TurnPlanStepStatus is a type error here until it has a marker, and a harness reporting a status
 * outside the union falls back to waiting rather than claiming the step is running.
 */
const STEP_MARK: Record<TurnPlanStepStatus, { kind: 'done' | 'running' | 'waiting'; label: string }> = {
  completed: { kind: 'done', label: 'Done' },
  inProgress: { kind: 'running', label: 'In progress' },
  pending: { kind: 'waiting', label: 'Waiting' },
};

/** A plan's markers: only active work spins; an inactive open step uses CD's static dotted status ring. */
export function TodoSteps({ steps, active }: { steps: NonNullable<TurnState['plan']>['steps']; active: boolean }) {
  return (
    <ol className="todo-list">
      {withKeys(steps, (s) => s.step).map(({ key, item: s }) => {
        const mark = STEP_MARK[s.status] ?? STEP_MARK.pending;
        return (
          <li key={key} className={`todo-step ${s.status}`}>
            <span className="todo-check" role="img" aria-label={mark.label}>
              {mark.kind === 'done' ? (
                <Check size={11} strokeWidth={3} />
              ) : mark.kind === 'running' && active ? (
                <Spinner size={14} />
              ) : (
                <DottedRing size={14} />
              )}
            </span>
            <span className="todo-text">{s.step}</span>
          </li>
        );
      })}
    </ol>
  );
}
