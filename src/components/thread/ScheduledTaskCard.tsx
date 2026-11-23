// The card a chat shows when it set up, changed or ran a scheduled task through MoPilot's tools, on any harness: what the task is, where it runs, and Open, Pause and Run now.
import { useState } from 'react';
import { canonicalTask } from '../../../shared/scheduleTask.mjs';
import { CalendarClock } from '../ui/icons';
import { useStore, toast } from '../../store/core';
import { navigate } from '../../store/panes';
import { native } from '../../lib/native';
import { runWithLabel, runsInLabel, type RunWith } from '../../lib/scheduleTask';
import { basename } from '../../lib/paths';
import type { ScheduledTaskCall } from '../../lib/scheduledTaskCall';
import { showScheduledTask } from '../../session/scheduledFocus';
import { errorText } from '../../lib/ignored';

import { useActionView } from '../../session/useActionView';

const TITLE = { created: 'Scheduled task created', updated: 'Scheduled task updated' };

/** The task as main lists it now (Pause and Run now act on that, not on what the chat was told). */
async function current(id: string) {
  const a = canonicalTask((await native.automation.list()).tasks, id);
  if (!a) throw new Error('This scheduled task was deleted');
  return a;
}

const fail = (e: unknown) => toast(errorText(e), 'error');

export function ScheduledTaskCard({ call }: { call: ScheduledTaskCall }) {
  const actionView = useActionView(call.action === 'ran' ? call.taskId : call.task.id);
  const statusView = useActionView(call.action === 'ran' ? call.taskId : call.task.id);
  const basics = useStore((s) => s.basicHarnesses);
  const [savedStatus, setStatus] = useState<{ owner: typeof statusView; status: string } | null>(null);
  const status = savedStatus?.owner === statusView ? savedStatus.status : call.action === 'ran' ? 'ACTIVE' : call.task.status;
  if (call.action === 'ran') {
    return (
      <section className="sched-call" aria-label="Scheduled task run started">
        <div className="sched-call-head">
          <span className="sched-call-icon" aria-hidden="true">
            <CalendarClock size={15} strokeWidth={1.8} />
          </span>
          <span className="sched-call-title">Started a run of a scheduled task</span>
        </div>
        <div className="sched-call-actions">
          <button className="btn-pill" onClick={() => navigate({ name: 'thread', id: call.chatId })}>
            Open the run
          </button>
          <button className="btn-pill soft" onClick={() => showScheduledTask(call.taskId)}>
            Open in Scheduled
          </button>
        </div>
      </section>
    );
  }
  const t = call.task;
  // the next time as the tool answered it, while it is still ahead
  const next = status === 'ACTIVE' && t.nextRun && Date.parse(t.nextRun) > Date.now() ? new Date(t.nextRun) : null;
  const toggle = async () => {
    const ownsView = statusView.begin(false);
    try {
      const saved = await native.automation.update(t.id, { status: status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' });
      if (ownsView()) setStatus({ owner: statusView, status: saved.status });
    } catch (e) {
      fail(e);
    }
  };
  const runNow = async () => {
    const ownsView = actionView.begin();
    try {
      const id = await native.automation.run(await current(t.id));
      if (ownsView()) navigate({ name: 'thread', id });
    } catch (e) {
      fail(e);
    }
  };
  return (
    <section className="sched-call" aria-labelledby={`sched-call-${t.id}`}>
      <div className="sched-call-head">
        <span className="sched-call-icon" aria-hidden="true">
          <CalendarClock size={15} strokeWidth={1.8} />
        </span>
        <span className="sched-call-name">
          <span id={`sched-call-${t.id}`} className="sched-call-title">
            {TITLE[call.action]}
          </span>
          <span className="sched-call-sub">{t.name}</span>
        </span>
        <span className={`sched-run-status ${status === 'ACTIVE' ? 'ran' : ''}`}>{status === 'ACTIVE' ? 'Active' : 'Paused'}</span>
      </div>
      <dl className="sched-call-facts">
        <dt>When</dt>
        <dd>
          {t.when ?? t.schedule}
          {next ? ` · next ${next.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
        </dd>
        <dt>Runs with</dt>
        <dd>
          {runWithLabel(t.harness as RunWith, basics)}
          {t.cwd ? ` in ${basename(t.cwd)}` : ''}
          {t.worktree ? ', in a fresh worktree' : ''}
        </dd>
        <dt>Where it runs</dt>
        <dd>{runsInLabel({ apps: t.runsIn })}</dd>
        <dt>Each run may</dt>
        <dd>
          {t.computerControl ? 'Control apps' : 'Not control apps'} ·{' '}
          {t.onApproval === 'skip' ? 'skips a run that needs approval' : 'waits for your approval'}. Change this in Scheduled
        </dd>
      </dl>
      <div className="sched-call-actions">
        <button className="btn-pill" onClick={() => showScheduledTask(t.id)}>
          Open in Scheduled
        </button>
        <button className="btn-pill soft" onClick={toggle}>
          {status === 'ACTIVE' ? 'Pause' : 'Resume'}
        </button>
        <button className="btn-pill soft" onClick={runNow}>
          Run now
        </button>
      </div>
    </section>
  );
}
