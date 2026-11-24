// A Codex Cloud sidebar row, shared by projects and the Cloud section.
import type { CloudTask } from '../../lib/native';
import { LocationMark } from '../ui/HostMark';
import { RowDot } from './ThreadIndicators';
import { useStore } from '../../store/core';
import { activeCloudTask } from '../../store/route';
import { HARNESS_LABEL } from '../../../shared/handoff.mjs';
import { navigate } from '../../store/panes';

export const cloudRunning = (task: CloudTask) => /pending|running|in_progress|queued/i.test(String(task.status ?? ''));

const cloudLabel = `${HARNESS_LABEL.codex} Cloud`;

export function CloudTaskRow({ task }: { task: CloudTask }) {
  const selected = useStore((s) => activeCloudTask(s) === task.id);
  return (
    <button
      type="button"
      className={`side-row thread-row${selected ? ' selected' : ''}`}
      aria-label={`${task.title ?? task.id} · ${cloudLabel}`}
      data-sidebar-cloud={task.id}
      title={task.environment_label ?? undefined}
      onClick={() => navigate({ name: 'cloud', id: task.id })}
    >
      <span className="thread-row-content">
        <span className="side-row-name">
          <span className="side-row-label">{task.title ?? task.id}</span>
          <LocationMark kind="cloud" label={cloudLabel} />
        </span>
      </span>
      <span className="row-status">{cloudRunning(task) && <RowDot status="working" label="Working" />}</span>
    </button>
  );
}
