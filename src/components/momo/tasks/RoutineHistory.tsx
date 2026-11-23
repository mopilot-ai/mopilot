// View history on a routine's menu (Tasks › Scheduled): a dialog with the routine's name, its next time, and each run of the last 30 days as when it started and how it ended, or "Hasn’t run yet".
import { useEffect, useState } from 'react';
import { native } from '../../../lib/native';
import type { MomoRoutineRun } from '../../../lib/native/momoRoutines';
import type { MomoPanelTask } from '../../../lib/native/contracts/momoTasks';
import { errorText } from '../../../lib/ignored';
import { Modal } from '../../ui/Modal';
import { lineOf, runLine } from './taskCopy';
import styles from './tasksPanel.module.css';

export function RoutineHistory({ task, now, onClose }: { task: MomoPanelTask; now: number; onClose: () => void }) {
  /** null while it is read; the text of why it could not be */
  const [runs, setRuns] = useState<MomoRoutineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    native.momoRoutines.history(task.ref).then(
      (r) => live && setRuns(r),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [task.ref]);
  return (
    <Modal title={task.title} onClose={onClose}>
      <div className={styles.history}>
        <p className={styles.historyLine}>{lineOf({ ...task, at: null }, now)}</p>
        {error ? (
          <p role="alert">{error}</p>
        ) : runs === null ? null : runs.length === 0 ? (
          <p className={styles.run}>Hasn’t run yet</p>
        ) : (
          <ul className={styles.runs} aria-label="Runs">
            {runs.map((r) => (
              <li key={r.startedAt} className={styles.run}>
                {runLine(r, now)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
