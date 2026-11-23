// One row of the Tasks panel (M0a): a title, one grey line and the actions its kind has: a card Review, a loop its own Done, Snooze and Dismiss (Reopen once closed), a run its menu (Show in channel, Mark as done, Archive, Delete; Reopen once marked), a routine its menu as the design's (Run now, Pause or Resume, Rename on the row, View history, Delete at once).
import { useState } from 'react';
import type { MomoPanelTask, MomoTaskMark } from '../../../lib/native/contracts/momoTasks';
import { imeComposing } from '../../../lib/focus';
import { navigate } from '../../../store/panes';
import { Row } from '../../pages/settings/Controls';
import { Menu, MenuItem, MenuSeparator, useAnchor } from '../../ui/Popover';
import { LoopActions } from '../loopActions';
import { lineOf } from './taskCopy';
import { reviewRoute } from './reviewRoute';
import { RoutineHistory } from './RoutineHistory';

export type RowActions = {
  mark: (taskId: string, what: MomoTaskMark) => unknown;
  /** start one run of a routine now, saying so */
  runNow: (routineId: string, name: string) => unknown;
  /** pause or resume one routine, saying so */
  pause: (routineId: string, name: string, paused: boolean) => unknown;
  /** rename one routine: whether main saved it */
  rename: (routineId: string, name: string) => Promise<boolean>;
  /** delete one routine at once, with its history */
  remove: (routineId: string, name: string) => unknown;
  reload: () => void;
  /** the morning brief's Try again */
  tryBrief: () => unknown;
};

/** A run's menu: where it was reported, and the user's marks. */
function RunMenu({ task, mark }: { task: MomoPanelTask; mark: RowActions['mark'] }) {
  const a = useAnchor<HTMLButtonElement>();
  return (
    <>
      <button
        ref={a.ref}
        className="btn-pill soft"
        aria-label={`More for ${task.title}`}
        aria-haspopup="menu"
        aria-expanded={a.open}
        onClick={a.toggle}
      >
        …
      </button>
      <Menu anchor={a.anchor} open={a.open} onClose={a.close} placement="bottom-end">
        <MenuItem onSelect={() => navigate({ name: 'momo', tab: 'chat' })}>Show in channel</MenuItem>
        <MenuItem onSelect={() => void mark(task.id, 'done')}>Mark as done</MenuItem>
        <MenuItem onSelect={() => void mark(task.id, 'archive')}>Archive</MenuItem>
        <MenuItem danger onSelect={() => void mark(task.id, 'delete')}>
          Delete
        </MenuItem>
      </Menu>
    </>
  );
}

/** A routine's menu (the design's order): Run now (off while a run is going), Pause or Resume, Rename, View history, and Delete in red with no confirm. */
function RoutineMenu({
  task,
  actions,
  rename,
  history,
}: {
  task: MomoPanelTask;
  actions: RowActions;
  rename: () => void;
  history: () => void;
}) {
  const a = useAnchor<HTMLButtonElement>();
  return (
    <>
      <button
        ref={a.ref}
        className="btn-pill soft"
        aria-label={`More for ${task.title}`}
        aria-haspopup="menu"
        aria-expanded={a.open}
        onClick={a.toggle}
      >
        …
      </button>
      <Menu anchor={a.anchor} open={a.open} onClose={a.close} placement="bottom-end">
        <MenuItem disabled={task.at !== null} onSelect={() => void actions.runNow(task.ref, task.title)}>
          Run now
        </MenuItem>
        <MenuItem onSelect={() => void actions.pause(task.ref, task.title, !task.paused)}>{task.paused ? 'Resume' : 'Pause'}</MenuItem>
        <MenuItem onSelect={rename}>Rename</MenuItem>
        <MenuItem onSelect={history}>View history</MenuItem>
        <MenuSeparator />
        <MenuItem danger onSelect={() => void actions.remove(task.ref, task.title)}>
          Delete
        </MenuItem>
      </Menu>
    </>
  );
}

/** The name field a routine's Rename opens on its row: Enter or Save keeps it, Escape or Cancel leaves it, and a refused name stays for the user to fix. */
function RenameForm({ task, rename, done }: { task: MomoPanelTask; rename: RowActions['rename']; done: () => void }) {
  const [name, setName] = useState(task.title);
  const save = async () => {
    const next = name.trim();
    if (!next || next === task.title || (await rename(task.ref, next))) done();
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => e.key === 'Escape' && !imeComposing(e) && done()}
    >
      <input aria-label="Routine name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
      <button type="submit" className="btn-pill soft">
        Save
      </button>
      <button type="button" className="btn-pill ghost" onClick={done}>
        Cancel
      </button>
    </form>
  );
}

export function TaskRow({ task, now, actions }: { task: MomoPanelTask; now: number; actions: RowActions }) {
  const { mark, reload, tryBrief } = actions;
  const [renaming, setRenaming] = useState(false);
  const [history, setHistory] = useState(false);
  const resolved = task.tab === 'resolved';
  return (
    <div className="momo-fact" data-task={task.id} data-state={task.state}>
      <Row title={task.title} desc={lineOf(task, now) || undefined}>
        {task.kind === 'loop' && (
          <LoopActions
            id={task.ref}
            open={!resolved}
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
        {task.kind === 'run' && resolved && (
          <button className="btn-pill soft" onClick={() => void mark(task.id, 'reopen')}>
            Reopen
          </button>
        )}
        {task.kind === 'run' && task.state === 'review' && (
          <button className="btn-pill soft" onClick={() => void mark(task.id, 'done')}>
            Mark as done
          </button>
        )}
        {task.kind === 'run' && (task.state === 'review' || task.state === 'failed') && <RunMenu task={task} mark={mark} />}
        {task.kind === 'brief' && task.state === 'failed' && (
          <button className="btn-pill soft" onClick={() => void tryBrief()}>
            Try again
          </button>
        )}
        {task.kind === 'routine' &&
          (renaming ? (
            <RenameForm task={task} rename={actions.rename} done={() => setRenaming(false)} />
          ) : (
            <RoutineMenu task={task} actions={actions} rename={() => setRenaming(true)} history={() => setHistory(true)} />
          ))}
        {history && <RoutineHistory task={task} now={now} onClose={() => setHistory(false)} />}
      </Row>
    </div>
  );
}
