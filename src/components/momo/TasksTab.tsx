// MoMo's Tasks tab (A1): what needs the user (approval cards waiting, open loops that are awake) and the routine runs going, in one list derived by main (electron/momo/tasks.cjs); nothing here completes a task: a loop has the Memory tab's Done, Snooze and Dismiss, a card is answered in the chat (Review opens it), a run ends by itself. Read again on a change and every few seconds, since a run or a card has no change event of its own.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { MomoTask } from '../../lib/native/contracts/momoTasks';
import { navigate } from '../../store/panes';
import { Group, Row } from '../pages/settings/Controls';
import { visiblePoll } from '../../lib/visiblePoll';
import { LoopActions } from './loopActions';
import { reviewRoute } from './tasks/reviewRoute';

/** How often the list is read again with no change told. */
export const REFRESH_MS = 10_000;

/** A task's second line: its words, the source's name, or the due day. */
const lineOf = (t: MomoTask) =>
  [t.channel ? `#${t.channel.name}` : null, t.dueDay !== null ? `Due ${t.dueDay}` : null, t.detail]
    .filter((s): s is string => !!s)
    .join(' · ');

function TaskRow({ task, reload }: { task: MomoTask; reload: () => void }) {
  return (
    <div className="momo-fact" data-task={task.id}>
      <Row title={task.title} desc={lineOf(task) || undefined}>
        {task.kind === 'loop' && (
          <LoopActions
            id={task.ref}
            open
            title={task.title}
            dueAt={task.dueAt ?? undefined}
            dueDay={task.dueDay ?? undefined}
            done={reload}
          />
        )}
        {task.kind === 'card' && (
          <button className="btn-pill soft" onClick={() => navigate(reviewRoute(task))}>
            Review
          </button>
        )}
        {task.kind === 'run' && <span className="applies-to momo-chip">Running</span>}
      </Row>
    </div>
  );
}

export function TasksTab({ every = REFRESH_MS }: { every?: number }) {
  const [tasks, setTasks] = useState<MomoTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await native.momoTasks.list();
      if (mine !== seq.current) return;
      // not allowed: the tab shows nothing at all
      if (r.ok) setTasks(r.v === 2 ? [] : r.tasks);
      else if (r.reason === 'not_allowed') setTasks(null);
      setError(r.ok || r.reason === 'not_allowed' ? null : r.error);
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const stops = [native.momoTasks.onChanged(() => void load()), native.momoMemory.onChanged(() => void load())];
    // one shared poll that rests while the window is hidden, and reads once when it shows again
    const stopPoll = visiblePoll('momo-tasks', every, () => void load());
    return () => {
      // a read still on its way after the tab closed changes nothing
      seq.current++;
      stopPoll();
      for (const stop of stops) stop();
    };
  }, [load, every]);
  const reload = () => void load();
  const needs = tasks?.filter((t) => t.state === 'needs-you') ?? [];
  const running = tasks?.filter((t) => t.state === 'running') ?? [];
  return (
    <>
      {error && (
        <div className="config-warning" role="alert">
          Couldn't read the tasks: {error}{' '}
          <button className="btn-pill soft" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {tasks && (
        <Group title="Needs you">
          {!needs.length && <Row title="Nothing needs you" />}
          {needs.map((t) => (
            <TaskRow key={t.id} task={t} reload={reload} />
          ))}
        </Group>
      )}
      {!!running.length && (
        <Group title="Running">
          {running.map((t) => (
            <TaskRow key={t.id} task={t} reload={reload} />
          ))}
        </Group>
      )}
    </>
  );
}
