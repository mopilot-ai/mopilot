// The Add machine card's progress: one calm line while an install runs ("Setting up box…"), one line when it ends (on success with Start a chat on it; on failure the cause and its one action), and the full step list with each step's output behind Details, open by itself only when a step failed.
import { useEffect, useRef, useState } from 'react';
import { Check, Spinner } from '../../ui/icons';
import { visiblePoll } from '../../../lib/visiblePoll';
import type { Failure } from '../../../../shared/host/installFailure.mjs';

export type InstallStep = {
  id: string;
  label: string;
  state: string;
  output: string;
  /** phase `index` of `total` (the main process's six), the bytes of an upload, a step that has not moved for 30 s, and what MoPilot does on its own (electron/host/installSteps.cjs) */
  index?: number;
  total?: number;
  progress?: { done: number; total: number };
  stalled?: boolean;
  notice?: string;
};

/** What each of the six phases is called (electron/host/installSteps.cjs PHASES), by its number. */
const PHASE = ['Connecting', 'Checking sign-in', 'Copying Node', 'Copying MoPilot', 'Starting', 'Pairing'];
/** The phase a step belongs to by name, or the step's own label for one with no phase this app knows. */
const phaseOf = (s: InstallStep) => (s.index ? PHASE[s.index - 1] : undefined) ?? s.label;

/** How often, and how many times (10 minutes), a machine that is not accepting ssh yet is asked again. */
const WAIT_MS = 3000;
const WAIT_TRIES = 200;

export function InstallCard({
  target,
  running,
  steps,
  ok,
  failure = null,
  onAction,
  onStartChat,
  check,
  onCancel,
  cancelled = null,
}: {
  target: string;
  running: boolean;
  steps: InstallStep[];
  ok: boolean;
  /** why it failed and the one thing to do (shared/host/installFailure.mjs) */
  failure?: Failure | null;
  onAction?: () => void;
  /** opens a new chat on the machine just added */
  onStartChat?: () => void;
  /** whether the machine answers now; while a failure waits for it, asked every few seconds, and the add runs again (onAction) once it does */
  check?: () => Promise<boolean>;
  /** stops the add under way and undoes what it made; the line then reads Cancelled */
  onCancel?: () => void;
  /** the add was stopped (`undone`: what it had made was removed again); not a failure */
  cancelled?: { undone: boolean } | null;
}) {
  // the step that is running now (the newest line), for the line above the details
  const now = [...steps].reverse().find((s) => s.state === 'running') ?? steps.at(-1);
  const [kept, setKept] = useState<string | null>(null);
  // a stall the person chose to keep waiting through stays quiet until the step moves and stalls again
  useEffect(() => {
    if (!now?.stalled) setKept(null);
  }, [now?.stalled]);
  // the step that has gone quiet and not been waited on yet
  const stuck = running && now?.stalled === true && kept !== now.id ? now : null;
  const stalled = stuck !== null;
  const latest = useRef({ check, onAction });
  latest.current = { check, onAction };
  // a machine not accepting ssh yet (a Mac with Remote Login off): asked again while the card shows, and added once it answers
  const waiting = !running && failure?.action.kind === 'wait' && !!check;
  useEffect(() => {
    if (!waiting) return;
    let busy = false;
    let tries = 0;
    const stop = visiblePoll('host-install-wait', WAIT_MS, () => {
      if (busy) return;
      if (++tries > WAIT_TRIES) return stop();
      busy = true;
      latest.current.check?.().then(
        (up) => {
          busy = false;
          if (!up) return;
          stop();
          latest.current.onAction?.();
        },
        () => {
          busy = false;
        },
      );
    });
    return stop;
  }, [waiting]);
  // a failed add always comes with its cause (shared/host/installFailure.mjs)
  const failed = !running && failure !== null;
  if (!running && !ok && !failed && !cancelled) return null;
  return (
    <div className="host-install">
      <div className="host-install-line" role="status">
        {running ? (
          <>
            <Spinner size={12} />{' '}
            {stalled
              ? 'Taking longer than usual…'
              : now?.index && now.total
                ? `Step ${now.index} of ${now.total} · ${phaseOf(now)}`
                : `Setting up ${target}…`}
          </>
        ) : cancelled ? (
          <>{cancelled.undone ? 'Cancelled. Nothing was left on the machine.' : 'Cancelled.'}</>
        ) : failure ? (
          <>{failure.title}</>
        ) : (
          <>
            <Check size={12} strokeWidth={2} /> {target} is ready
          </>
        )}
      </div>
      {running && now?.notice && <div className="host-install-reason">{now.notice}</div>}
      {running && now?.progress && now.progress.total > 0 && (
        <progress
          className="host-install-bar"
          aria-label={phaseOf(now)}
          max={now.progress.total}
          value={Math.min(now.progress.done, now.progress.total)}
        />
      )}
      {running && onCancel && (
        <div className="host-install-reason">
          {stuck && (
            <button type="button" className="btn-pill soft" onClick={() => setKept(stuck.id)}>
              Keep waiting
            </button>
          )}
          <button type="button" className="btn-pill soft" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
      {!running && !failed && !cancelled && onStartChat && (
        <div className="host-install-reason">
          <button type="button" className="btn-pill soft" onClick={onStartChat}>
            Start a chat on it
          </button>
        </div>
      )}
      {!running && failure && (
        <div className="host-install-reason" role="alert">
          {failure.reason}
          {onAction && (
            <button type="button" className="btn-pill soft" onClick={onAction}>
              {'label' in failure.action ? failure.action.label : failure.action.kind === 'wait' ? 'Check again' : 'Try again'}
            </button>
          )}
        </div>
      )}
      {!ok && !cancelled && steps.length > 0 && (
        <details className="host-install-details">
          <summary>Details</summary>
          <ol className="host-install-steps" aria-label="Install steps">
            {steps.map((s) => (
              <li key={s.id} className={`host-step ${s.state}`}>
                <span className="host-step-label">
                  {s.label} {s.state === 'ok' ? <Check size={12} strokeWidth={2} /> : s.state === 'failed' ? '✕' : '…'}
                </span>
                {s.output && <pre className="host-step-output">{s.output}</pre>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
