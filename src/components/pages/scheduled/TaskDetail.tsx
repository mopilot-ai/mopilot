// Scheduled-task details, recent run ledger and run/pause/edit/delete actions.
import { useEffect, useLayoutEffect, useState } from 'react';
import { useStore, toast, setPrefs, threadTitle } from '../../../store/core';
import { navigate } from '../../../store/panes';
import { useSessions } from '../../../store/session/useSession';
import { COPY } from '../../../harness/copy';
import { runRow, runSource, runWithLabel, runWithOf, whereItRuns } from '../../../lib/scheduleTask';
import { useAutomationApps } from '../automationApps';
import { useHostMachines } from '../../../lib/hostMachines';
import {
  saveEditedAutomation,
  deleteAutomation,
  describeRule,
  taskState,
  TASK_STATE_LABEL,
  type Automation,
  type AutomationRun,
} from '../../../lib/automations';
import { modelLabel, relativeTime } from '../../../lib/format';
import { basename } from '../../../lib/paths';
import { Menu, MenuItem, MenuSeparator, useAnchor } from '../../ui/Popover';
import { Play, Pause, Ellipsis, Trash2, Pencil, Folder, MessageSquare } from '../../ui/icons';
import { native } from '../../../lib/native';
import { errorText } from '../../../lib/ignored';
import { useSched, reload } from './state';
import { createLatestLoader } from '../../../lib/latestLoader';

import { useActionView } from '../../../session/useActionView';

export function TaskDetail({ a }: { a: Automation }) {
  const actionView = useActionView(a.id);
  useLayoutEffect(() => {
    let previous = useSched.getState();
    return useSched.subscribe(() => {
      const next = useSched.getState();
      if (next.selected !== previous.selected || next.editing !== previous.editing) actionView.invalidate();
      previous = next;
    });
  }, [actionView]);
  const threads = useStore((s) => s.threads);
  const initialTitles = useStore((s) => s.chatInitialTitles);
  const basics = useStore((s) => s.basicHarnesses);
  const menu = useAnchor();
  const state = taskState(a);
  const active = state.kind !== 'paused';
  const { machines } = useHostMachines();
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  useEffect(() => {
    const loader = createLatestLoader(
      () => native.automation.runs(a.id),
      setRuns,
      () => setRuns([]),
    );
    void loader.load();
    const off = native.automation.onChanged(() => void loader.load());
    return () => {
      loader.stop();
      off();
    };
  }, [a.id]);
  const shownRuns = (runs ?? []).slice(0, 10);
  const apps = useAutomationApps();
  // the switch here is the user's, so it shows before main next answers
  const schedulerOff = useStore((s) => s.prefs.schedulerOff);
  const machineName = machines.find((m) => m.id === a.host_id)?.name ?? a.host_id;
  // a task its machine fires itself runs there whatever this Mac does
  const where =
    a.fired_by === 'machine'
      ? [{ app: 'mopilot' as const, name: String(machineName), line: 'Runs this task on schedule, even while this Mac is off' }]
      : whereItRuns(a.runs_in, apps && { ...apps, scheduler: !schedulerOff });
  const otherApp = where.find((w) => w.app !== 'mopilot');
  // an unattended run whose approval nobody answered for an hour (main marks it)
  const attentionKey = useSessions((s) =>
    Object.entries(s.sessions)
      .filter(([, v]) => v.scheduled?.needsAttention)
      .map(([id]) => id)
      .join(','),
  );
  const attention = new Set(attentionKey ? attentionKey.split(',') : []);
  const runNow = async () => {
    const current = actionView.begin();
    try {
      const id = await native.automation.run(a);
      if (current()) navigate({ name: 'thread', id });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <div className="task-detail">
      {schedulerOff && (
        <div className="notice sched-off" role="status">
          <span>
            The scheduler is off, so MoPilot won't run this task.
            {otherApp ? ` ${otherApp.app === 'codex-app' ? 'The Codex app' : 'Claude Desktop'} still runs it while it's open.` : ''}
          </span>
          <button className="btn-pill" onClick={() => setPrefs({ schedulerOff: false })}>
            Turn on
          </button>
        </div>
      )}
      <div className="task-head">
        <div>
          <h1 className="page-title">{a.name}</h1>
          <div className="auto-meta">
            <span>{a.rrule ? describeRule(a.rrule) : (a.cron ?? '')}</span>
            <span>{runWithLabel(runWithOf(a), basics)}</span>
            {a.host_id && <span data-testid="task-machine">On {machineName}</span>}
            {a.cwds?.[0] && (
              <span className="auto-meta-item">
                <Folder size={12} /> {basename(a.cwds[0])}
              </span>
            )}
            {a.model && <span>{modelLabel(a.model)}</span>}
            {state.kind === 'scheduled' ? (
              <span>Next {state.next.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
            ) : (
              <span className="status-pill">{TASK_STATE_LABEL[state.kind]}</span>
            )}
          </div>
        </div>
        <div className="task-actions">
          <button className="btn-pill" onClick={runNow}>
            <Play size={13} /> Run now
          </button>
          <button
            className="btn-pill"
            onClick={async () => {
              try {
                // only the status changes: the task as it is now keeps the rest (a heartbeat's chat, say)
                await saveEditedAutomation(a, { ...a, status: active ? 'PAUSED' : 'ACTIVE' });
              } catch (e) {
                toast(`Couldn't save the task: ${errorText(e)}`, 'error');
              }
              await reload();
            }}
          >
            {active ? <Pause size={13} /> : <Play size={13} />} {active ? 'Pause' : 'Resume'}
          </button>
          <button ref={menu.ref} className="icon-btn" onClick={menu.toggle} aria-label="Task actions">
            <Ellipsis size={16} />
          </button>
        </div>
      </div>
      <section className="sched-where" aria-labelledby="sched-where-title">
        <div className="sched-where-head">
          <h2 id="sched-where-title">Where it runs</h2>
          <span>Each scheduled time runs once, in whichever app runs it first</span>
        </div>
        {where.map((w) => (
          <div key={w.app} className="sched-where-row">
            <span className={`sched-app-dot ${w.app}`} aria-hidden="true" />
            <span className="sched-where-name">{w.name}</span>
            <span className="sched-where-line">{w.line}</span>
          </div>
        ))}
      </section>
      {a.created_by_chat && threads[a.created_by_chat] && (
        <button className="task-run sched-made-in" onClick={() => navigate({ name: 'thread', id: a.created_by_chat! })}>
          <MessageSquare size={14} />
          <span className="task-run-title">Set up in the chat “{threadTitle(threads[a.created_by_chat], initialTitles)}”</span>
        </button>
      )}
      <div className="task-section-label">Prompt</div>
      <div className="task-prompt">{a.prompt}</div>
      <div className="task-section-label">Recent runs</div>
      {runs && shownRuns.length === 0 && <div className="settings-row-desc">No runs yet</div>}
      {shownRuns.length > 0 && (
        <div className="sched-runs">
          {shownRuns.map((r) => {
            const t = r.chatId ? threads[r.chatId] : undefined;
            const row = runRow(r, t ? threadTitle(t, initialTitles) : null);
            return (
              <div key={`${r.manual ? 'manual' : 'scheduled'}-${r.scheduledFor}-${String(r.by ?? '')}`} className="sched-run">
                <span className={`sched-run-status ${row.tone}`}>{row.status}</span>
                <span className="sched-run-detail">{row.detail}</span>
                {r.chatId && attention.has(r.chatId) && <span className="status-pill">{COPY.scheduled.needsAttention}</span>}
                <span className="sched-run-source">{runSource(r, (id) => machines.find((m) => m.id === id)?.name ?? id)}</span>
                <span className="task-run-time">{relativeTime(r.scheduledFor / 1000)}</span>
                {t && (
                  <button className="sched-run-open" onClick={() => navigate({ name: 'thread', id: t.id })}>
                    Open chat
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={190}>
        <MenuItem icon={<Pencil size={15} />} onSelect={() => useSched.setState({ editing: a })}>
          Edit
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<Trash2 size={15} />}
          danger
          onSelect={async () => {
            if (!confirm(`Delete "${a.name}"?`)) return;
            const current = actionView.begin();
            try {
              await deleteAutomation(a.id);
              if (current()) useSched.setState({ selected: null });
              await reload();
            } catch (error) {
              toast(`Couldn't delete the task: ${errorText(error)}`, 'error');
            }
          }}
        >
          Delete
        </MenuItem>
      </Menu>
    </div>
  );
}
