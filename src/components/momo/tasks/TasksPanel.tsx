// MoMo's Tasks panel (M0a): four tabs (Active, Up next, Scheduled, Resolved) over the rows main derives (electron/momo/tasksPanel.cjs). Only the user marks a run done; a loop is closed through its own buttons and a card answered in the chat. The panel appears in one frame, with no animation; a failed read says "Couldn't read your tasks." with Try again and keeps the last list known, greyed. Self-contained: it takes no props, so a side panel can mount it as the page does.
import { useState } from 'react';
import { native } from '../../../lib/native';
import { Group, Row } from '../../pages/settings/Controls';
import { saveMomoPref } from '../../../session/momoPrefs';
import { toast } from '../../../store/core';
import { errorText } from '../../../lib/ignored';
import type { MomoPanelTask } from '../../../lib/native/contracts/momoTasks';
import { TaskRow } from './TaskRow';
import { EMPTY, TABS, type TabId } from './taskCopy';
import { useTaskPanel } from './useTaskPanel';
import { useSuggestions } from './useSuggestions';
import { SuggestionRows } from './SuggestionRows';
import styles from './tasksPanel.module.css';

/** Active's groups, in order: what needs the user, what is going, what did not finish, what waits for the user's mark. */
const ACTIVE: { title: string; has: (t: MomoPanelTask) => boolean }[] = [
  { title: 'Needs you', has: (t) => t.state === 'needs-you' },
  { title: 'Working', has: (t) => t.state === 'running' },
  { title: 'Didn’t finish', has: (t) => t.state === 'failed' },
  { title: 'Ready for review', has: (t) => t.state === 'review' },
];

export function TasksPanel({ every }: { every?: number }) {
  const { view, failed, load, mark } = useTaskPanel(every);
  const sug = useSuggestions(every);
  const [tab, setTab] = useState<TabId>('active');
  if (!view && !failed) return null;
  const tasks = view?.tasks ?? [];
  const now = view?.now ?? Date.now();
  const inTab = (id: TabId) => tasks.filter((t) => t.tab === id);
  /** what a tab's button counts: its rows, and for Up next the suggestions too */
  const suggested = sug.view?.suggestions.length ?? 0;
  const countOf = (id: TabId) => inTab(id).length + (id === 'next' ? suggested : 0);
  const actions = {
    mark,
    reload: () => void load(),
    // the morning brief that could not start: write it now, and say why when it cannot
    tryBrief: () =>
      native.momoBrief.runNow().then(
        (r) => (r.ok ? load() : toast(r.error, 'error')),
        (e) => toast(errorText(e), 'error'),
      ),
    runNow: (routineId: string, name: string) =>
      native.momoRoutines.runNow(routineId).then(
        () => (toast(`Started “${name}”`, 'info'), load()),
        (e) => toast(errorText(e), 'error'),
      ),
    pause: (routineId: string, name: string, paused: boolean) =>
      native.momoRoutines.edit(routineId, { paused }).then(
        () => (toast(`${paused ? 'Paused' : 'Resumed'} ${name}`, 'info'), load()),
        (e) => toast(errorText(e), 'error'),
      ),
    rename: (routineId: string, name: string) =>
      native.momoRoutines.edit(routineId, { name }).then(
        () => (load(), true),
        (e) => (toast(errorText(e), 'error'), false),
      ),
    remove: (routineId: string, name: string) =>
      native.momoRoutines.remove(routineId).then(
        () => (toast(`Deleted ${name}`, 'info'), load()),
        (e) => toast(errorText(e), 'error'),
      ),
  };
  const rows = (list: MomoPanelTask[]) => list.map((t) => <TaskRow key={t.id} task={t} now={now} actions={actions} />);
  const shown = inTab(tab);
  return (
    <div data-tasks-panel>
      {failed && (
        <div className="config-warning" role="alert">
          Couldn’t read your tasks.{' '}
          <button className="btn-pill soft" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      <div role="tablist" aria-label="Tasks" className={styles.tabs}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`btn-pill ${tab === id ? '' : 'soft'}`}
            onClick={() => setTab(id)}
          >
            {label}
            {countOf(id) > 0 && id !== 'resolved' ? ` ${countOf(id)}` : ''}
          </button>
        ))}
      </div>
      <div role="tabpanel" className={failed ? styles.stale : undefined} aria-label={TABS.find((t) => t.id === tab)!.label}>
        {tab === 'active' && shown.length > 0 ? (
          ACTIVE.map(({ title, has }) => {
            const list = shown.filter(has);
            return (
              list.length > 0 && (
                <Group key={title} title={title}>
                  {rows(list)}
                </Group>
              )
            );
          })
        ) : (
          <>
            {tab === 'next' && sug.view && <SuggestionRows {...sug.view} fresh={sug.fresh} act={sug.act} />}
            {tab === 'next' && suggested > 0 && shown.length === 0 ? null : (
              <Group
                action={
                  tab === 'scheduled' &&
                  shown.length > 0 && (
                    <button className="btn-pill soft" onClick={() => void saveMomoPref('paused', !view?.paused)}>
                      {view?.paused ? 'Resume all' : 'Pause all'}
                    </button>
                  )
                }
              >
                {shown.length ? rows(shown) : <Row title={EMPTY[tab]} />}
              </Group>
            )}
          </>
        )}
      </div>
    </div>
  );
}
