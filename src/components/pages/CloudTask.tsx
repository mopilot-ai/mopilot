// A Codex Cloud task page: live status, its diff and applying it to a local checkout.

import { cloudSidebarAccount } from '../../lib/cloudSidebarAccount';
import { visiblePoll } from '../../lib/visiblePoll';
import { useMemo, useRef, useState } from 'react';
import { useEffectOn } from '../../lib/effects';
import { useStore, toast, toastFailure } from '../../store/core';
import { currentCwdForNewChat } from '../../store/projects';
import { loadCloudTasks } from '../../store/send';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { openLink } from '../../session/open';
import { parseUnifiedDiff, InlineDiff } from '../diff/DiffView';
import { Cloud, ExternalLink, Download, RefreshCw, Spinner } from '../ui/icons';

/** A Codex Cloud task: live status, its diff, and applying it to a local checkout. */
export function CloudTask({ id }: { id: string }) {
  const task = useStore((s) =>
    !s.cloudSidebar || s.cloudSidebar.account === cloudSidebarAccount(s) ? s.cloudTasks.find((t) => t.id === id) : undefined,
  );
  const [status, setStatus] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const shown = useRef(id);
  shown.current = id;
  // another task shows nothing of the last one's: reset while rendering, so no frame shows its status or diff
  const [readFor, setReadFor] = useState(id);
  if (readFor !== id) {
    setReadFor(id);
    setStatus(null);
    setDiff(null);
    setDiffErr(null);
  }

  // overlapping reads (a poll and Refresh): only the newest lands
  const reads = useRef(0);
  /** Read the task's status and diff; a read that fails says why, and one for a task no longer shown, or overtaken, is dropped. */
  const refresh = async () => {
    const asked = id;
    const read = ++reads.current;
    const stale = () => shown.current !== asked || read !== reads.current;
    try {
      const [st, d] = await Promise.all([native.cloud.status(id), native.cloud.diff(id)]);
      if (stale()) return;
      setStatus(st.text);
      setDiff(d.ok ? d.diff : '');
      setDiffErr(d.ok ? null : d.error);
    } catch (e) {
      if (stale()) return;
      // the last reading stays; with none yet, the page says why instead of loading forever
      setDiff((was) => was ?? '');
      setDiffErr(`Couldn't read the task: ${errorText(e)}`);
    }
    // cannot reject: loadCloudTasks records a list it couldn't read and keeps the last one
    void loadCloudTasks();
  };
  // reads the task shown at once, then polls it
  useEffectOn([id], () => {
    // cannot reject: refresh says itself when a read fails
    void refresh();
    return visiblePoll(`cloud-task:${id}`, 15000, () => void refresh());
  });

  const files = useMemo(() => (diff ? parseUnifiedDiff(diff) : []), [diff]);
  const state = (task?.status as string) ?? /status:\s*(\w+)/i.exec(status ?? '')?.[1] ?? null;
  const running = state ? /pending|running|in_progress|queued/i.test(state) : !diff;

  const apply = async () => {
    const cwd = currentCwdForNewChat();
    if (!cwd) return toast('Choose a project to apply the changes to', 'error');
    setApplying(true);
    try {
      const r = await native.cloud.apply(id, cwd);
      toast(r.ok ? 'Applied changes locally' : r.output.split('\n').pop() || 'Apply failed', r.ok ? 'success' : 'error');
    } catch (e) {
      toastFailure("Couldn't apply the changes")(e);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="page cloud-page">
      <div className="cloud-inner">
        <div className="cloud-head">
          <span className="cloud-icon">
            <Cloud size={18} strokeWidth={1.7} />
          </span>
          <div className="cloud-title-wrap">
            <h1 className="cloud-title">{task?.title ?? 'Cloud task'}</h1>
            <div className="cloud-meta">
              {task?.environment_label && <span>{task.environment_label}</span>}
              {state && (
                <span className={`cloud-state ${running ? 'running' : ''}`}>
                  {running && <Spinner size={11} />} {humanState(state)}
                </span>
              )}
            </div>
          </div>
          <div className="cloud-actions">
            <button className="icon-btn" onClick={refresh} title="Refresh">
              <RefreshCw size={15} />
            </button>
            <button className="btn-pill" onClick={() => openLink(task?.url ?? `https://chatgpt.com/codex/tasks/${id}`)}>
              Open in ChatGPT <ExternalLink size={13} />
            </button>
            <button className="btn primary sm" disabled={!files.length || applying} onClick={apply}>
              {applying ? <Spinner size={13} /> : <Download size={14} />} Apply locally
            </button>
          </div>
        </div>
        {status && <pre className="cloud-status">{status}</pre>}
        {diff === null && (
          <div className="center-pad">
            <Spinner size={16} />
          </div>
        )}
        {diff !== null && files.length === 0 && !status?.startsWith('Error') && (
          <div className="empty-state">{diffErr ?? (running ? 'Codex is working in the cloud…' : 'No changes')}</div>
        )}
        {files.map((f) => (
          <section key={f.path} className="cloud-file">
            <InlineDiff file={f} maxHeight={100000} />
          </section>
        ))}
      </div>
    </div>
  );
}

function humanState(s: string) {
  const t = s.replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
