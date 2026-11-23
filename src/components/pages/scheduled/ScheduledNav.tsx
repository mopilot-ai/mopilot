// Scheduled-task navigation, filtering, focus events and upcoming-time labels.
import { useEffect, useState } from 'react';
import { useStore } from '../../../store/core';
import { COPY } from '../../../harness/copy';
import { isBasicRunWith, runWithLabel, runWithOf, type RunWith } from '../../../lib/scheduleTask';
import { SHOW_TASK_EVENT, takeScheduledFocus } from '../../../session/scheduledFocus';
import { nextRun, taskState, TASK_STATE_LABEL, type Automation } from '../../../lib/automations';
import { Menu, MenuItem, Tooltip, useAnchor } from '../../ui/Popover';
import { Plus, Search, ListFilter } from '../../ui/icons';
import { native } from '../../../lib/native';
import { useSched, reload, blank } from './state';

export function ScheduledNav() {
  const { list, selected, filter, query } = useSched();
  const basics = useStore((s) => s.basicHarnesses);
  const filt = useAnchor();
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    void reload(); // cannot reject: a list it couldn't read is a toast
    // a chat's card asked for a task, before this page opened or while it is open
    const focus = takeScheduledFocus();
    if (focus) useSched.setState({ selected: focus, editing: null });
    const show = (e: Event) => useSched.setState({ selected: String((e as CustomEvent).detail), editing: null });
    window.addEventListener(SHOW_TASK_EVENT, show);
    // a task changed in another window, in main (a heartbeat's chat), or by a chat's tool
    const off = native.automation.onChanged(() => void reload());
    return () => {
      off();
      window.removeEventListener(SHOW_TASK_EVENT, show);
    };
  }, []);
  const shown = (list ?? [])
    .filter((a) => filter === 'all' || (filter === 'active' ? a.status === 'ACTIVE' : a.status !== 'ACTIVE'))
    .filter((a) => !query || a.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (nextRun(a.rrule)?.getTime() ?? Infinity) - (nextRun(b.rrule)?.getTime() ?? Infinity));
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title static">Scheduled</span>
        <span className="sched-subtitle">{COPY.scheduled.subtitle}</span>
        <div className="sidebar-header-actions">
          <Tooltip label="Search">
            <button className="icon-btn" onClick={() => setSearching((s) => !s)} aria-label="Search">
              <Search size={16} strokeWidth={1.7} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="sidebar-scroll">
        {searching && (
          <div className="settings-search small">
            <Search size={14} strokeWidth={1.7} />
            <input autoFocus placeholder="Search tasks" value={query} onChange={(e) => useSched.setState({ query: e.target.value })} />
          </div>
        )}
        <div className="sidebar-section">
          <button className="side-row" onClick={() => useSched.setState({ editing: blank(), selected: null })}>
            <span className="side-row-icon">
              <Plus size={16} strokeWidth={1.7} />
            </span>
            <span className="side-row-label">New task</span>
          </button>
        </div>
        <div className="sidebar-section">
          <div className="side-label-row">
            <span className="side-label">Upcoming</span>
            <div className="side-label-actions visible">
              <button ref={filt.ref} className="icon-btn sm" onClick={filt.toggle} aria-label="Filter">
                <ListFilter size={14} strokeWidth={1.7} />
              </button>
            </div>
          </div>
          {!list && <div className="side-row empty-note recents">Loading…</div>}
          {list && shown.length === 0 && <div className="side-row empty-note recents">No scheduled tasks</div>}
          {shown.map((a) => (
            <button
              key={a.id}
              className={`side-row sched-row ${selected === a.id ? 'selected' : ''}`}
              onClick={() => useSched.setState({ selected: a.id, editing: null })}
            >
              <span className="sched-row-main">
                <span className="side-row-label">{a.name}</span>
                <span className="sched-when">{shortState(a)}</span>
              </span>
              <HarnessChip harness={runWithOf(a)} label={runWithLabel(runWithOf(a), basics)} />
            </button>
          ))}
        </div>
      </div>
      <Menu anchor={filt.anchor} open={filt.open} onClose={filt.close} placement="bottom-end" width={160}>
        {(['all', 'active', 'paused'] as const).map((f) => (
          <MenuItem key={f} checked={filter === f} onSelect={() => useSched.setState({ filter: f })}>
            {f === 'all' ? 'All tasks' : f === 'active' ? 'Active' : 'Paused'}
          </MenuItem>
        ))}
      </Menu>
    </aside>
  );
}

/** The harness a task runs with, as a small label: its main name, colored by family. */
function HarnessChip({ harness, label }: { harness: RunWith; label: string }) {
  const family = isBasicRunWith(harness) ? 'basic' : harness;
  return (
    <span className="sched-apps">
      <span className="sched-app">
        <span className={`sched-harness-dot ${family}`} aria-hidden="true" />
        {label}
      </span>
    </span>
  );
}

/** The row's status: the next time when there is one, else the same label as the task's detail pill. */
export function shortState(a: Automation, now = new Date()) {
  const state = taskState(a, now);
  if (state.kind !== 'scheduled') return TASK_STATE_LABEL[state.kind];
  const n = state.next;
  const sameDay = n.toDateString() === now.toDateString();
  return sameDay ? n.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : n.toLocaleDateString([], { weekday: 'short' });
}
