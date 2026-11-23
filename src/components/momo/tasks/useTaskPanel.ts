// What the Tasks panel reads and does (M0a), apart from how it looks so the side panel M0b adds can mount the same panel: the four tabs' rows from main (electron/momo/tasksPanel.cjs), read again on a change main tells and every few seconds; a failed read keeps the last list known and says so; and the user's marks with their 60 s Undo.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import type { MomoPanelTask, MomoTaskMark } from '../../../lib/native/contracts/momoTasks';
import { toast } from '../../../store/core';
import { visiblePoll } from '../../../lib/visiblePoll';

/** How often the list is read again with no change told. */
export const REFRESH_MS = 10_000;
/** How long an Undo is offered (the Mac keeps the token as long). */
export const UNDO_MS = 60_000;

export type PanelView = { tasks: MomoPanelTask[]; paused: boolean; now: number };

const WORDS: Record<'done' | 'archive' | 'delete', string> = { done: 'Marked as done', archive: 'Archived', delete: 'Deleted' };

export function useTaskPanel(every = REFRESH_MS) {
  const [view, setView] = useState<PanelView | null>(null);
  /** the last read failed: the list shown is the last known one */
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await native.momoTasks.list();
      if (mine !== seq.current) return;
      if (r.ok && r.v === 2) {
        setView({ tasks: r.tasks, paused: r.paused, now: r.now });
        setFailed(false);
      } else if (!r.ok && r.reason === 'not_allowed') {
        // not allowed: the panel shows nothing at all
        setView(null);
        setFailed(false);
      } else setFailed(true);
    } catch {
      if (mine === seq.current) setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
    const stops = [native.momoTasks.onChanged(() => void load()), native.momoMemory.onChanged(() => void load())];
    // one shared poll that rests while the window is hidden, and reads once when it shows again
    const stopPoll = visiblePoll('momo-tasks', every, () => void load());
    return () => {
      // a read still on its way after the panel closed changes nothing
      seq.current++;
      stopPoll();
      for (const stop of stops) stop();
    };
  }, [load, every]);

  /** The user's mark on a run; archive, delete and done say so and offer Undo for a minute. */
  const mark = useCallback(
    async (taskId: string, what: MomoTaskMark) => {
      try {
        const r = await native.momoTasks.mark(taskId, what);
        if (!r.ok) toast(r.error, 'error');
        else if (what !== 'reopen' && r.undoToken) {
          const token = r.undoToken;
          toast(WORDS[what], 'info', {
            duration: UNDO_MS,
            action: {
              label: 'Undo',
              run: () =>
                void native.momoTasks.mark(taskId, 'reopen', token).then(
                  (u) => {
                    if (!u.ok) toast(u.reason === 'expired' ? 'Can’t undo that any more.' : u.error, 'error');
                    return load();
                  },
                  () => toast('Couldn’t undo that.', 'error'),
                ),
            },
          });
        }
      } catch {
        toast('Couldn’t save that. Try again.', 'error');
      }
      await load();
    },
    [load],
  );
  return { view, failed, load, mark };
}
