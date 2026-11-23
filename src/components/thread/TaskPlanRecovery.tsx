// An inactive unfinished plan names its pause and lets the user request a verified continuation through the normal composer path.
import { useEffect, useRef, useState } from 'react';
import { sendOrDraft } from '../../store/send';
import { errorText } from '../../lib/ignored';
import { CONTINUE_TASK } from '../../../shared/taskPlanRecovery.mjs';

export function TaskPlanRecovery({
  threadId,
  failed,
  readOnly,
  waiting = false,
}: {
  threadId: string;
  failed: boolean;
  readOnly: boolean;
  waiting?: boolean;
}) {
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return (
    <div className="turn-tasks-recovery">
      <span>{waiting ? 'Waiting for linked work' : failed ? 'Stopped after an error' : 'Paused'}</span>
      {!readOnly && !waiting && (
        <button
          type="button"
          className="btn-pill soft"
          disabled={requested}
          onClick={() => {
            setRequested(true);
            setError('');
            void sendOrDraft(threadId, CONTINUE_TASK, { human: true }).then(
              (sent) => {
                if (live.current && sent === false) setRequested(false);
              },
              (failure) => {
                if (live.current) {
                  setRequested(false);
                  setError(errorText(failure));
                }
              },
            );
          }}
        >
          {requested ? 'Continuation requested' : CONTINUE_TASK}
        </button>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
