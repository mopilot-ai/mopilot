// A harness's update, wherever it is offered (its row in All harnesses, its version line on its page): the "Update to
// X" pill and what follows it, the question when chats are mid-turn, the update's terminal with Stop, and what came
// of it. One hook holds the state, so the pill and the flow under it are one update. Data only, from main.
import { useState } from 'react';
import { native } from '../../lib/native';
import { copyText } from '../../session/clipboard';
import { errorText } from '../../lib/ignored';
import { toast } from '../../store/core';
import { useVersionOf, type HarnessVersionInfo } from '../../harness/harnessUpdates';
import { runTransport, useHarnessRuns } from '../../session/harness/harnessRuns';
import { TermView } from '../panels/TerminalPanel';
import { Check, Download, Spinner } from '../ui/icons';
import { elapsedText, UpdateProgressNote, useElapsed } from './UpdateProgress';
import { manualUpdateCommand } from '../../../shared/harnessInstall.mjs';

/** The chats an update would change the binary under, by name. */
const chatsText = (chats: { title: string }[]) =>
  `${chats.length} ${chats.length === 1 ? 'chat is' : 'chats are'} working with it: ${chats
    .slice(0, 3)
    .map((c) => `"${c.title}"`)
    .join(', ')}${chats.length > 3 ? ', …' : ''}`;

export interface HarnessUpdate {
  kind: string;
  label: string;
  v: HarnessVersionInfo;
  update: (when?: 'now' | 'idle') => Promise<void>;
  asking: { id: string; title: string }[] | null;
  setAsking: (a: { id: string; title: string }[] | null) => void;
  outputOf: string | null;
  setOutputOf: (id: string | null) => void;
}

/** The harness's version and update as main has them, and the calls; null when main has no version for it. */
export function useHarnessUpdate(kind: string, label: string): HarnessUpdate | null {
  const v = useVersionOf(kind);
  const [asking, setAsking] = useState<{ id: string; title: string }[] | null>(null);
  const [outputOf, setOutputOf] = useState<string | null>(null);
  if (!v) return null;
  const update = async (when?: 'now' | 'idle') => {
    setAsking(null);
    try {
      const r = await native.harnessUpdates.update(kind, when);
      if (r.ok) return;
      if (r.error === 'chats') return setAsking(r.chats ?? []);
      if (r.error === 'busy') return toast("Another update is running. Try again once it's done.", 'error');
      toast(`Couldn't update ${label}${r.message ? `: ${r.message}` : ''}`, 'error');
    } catch (e) {
      toast(`Couldn't update ${label}: ${errorText(e)}`, 'error');
    }
  };
  return { kind, label, v, update, asking, setAsking, outputOf, setOutputOf };
}

/** Updating…, Waiting for N chats · Cancel, or "Update to X" when there is one to offer; nothing otherwise. */
export function UpdatePill({ u }: { u: HarnessUpdate }) {
  const { v, kind, label } = u;
  const updating = v.state === 'updating';
  const run = useHarnessRuns((s) => (updating && v.runId ? s.runs.find((r) => r.id === v.runId) : null));
  const elapsed = elapsedText(useElapsed(run?.startedAt, updating));
  if (updating)
    return (
      <span className="hver-pill busy" role="status">
        <Spinner size={11} /> {run?.stopped ? 'Stopping…' : 'Updating…'}
        {elapsed && <span className="hver-elapsed"> {elapsed}</span>}
      </span>
    );
  if (v.state === 'waiting')
    return (
      <button type="button" className="btn-pill hver-pill" onClick={() => void native.harnessUpdates.cancelWait(kind)}>
        Waiting for {v.waitingFor} {v.waitingFor === 1 ? 'chat' : 'chats'} · Cancel
      </button>
    );
  if (!v.updatable) return null;
  return (
    <button
      type="button"
      className="btn-pill hver-pill"
      aria-label={`Update ${label} from ${v.installed} to ${v.latest}`}
      title={`Updates with ${v.command}\nFrom ${v.installed} → ${v.latest}`}
      onClick={() => void u.update()}
    >
      <Download size={12} /> Update to {v.latest}
    </button>
  );
}

/** What follows the pill: the question when chats are mid-turn, the update's terminal and Stop, and its outcome. */
export function UpdateFlow({ u }: { u: HarnessUpdate }) {
  const { v, label, asking, outputOf } = u;
  // the run under way, else the one the last result came from
  const runId = v.runId ?? v.outcome?.runId ?? null;
  const run = useHarnessRuns((s) => (runId ? (s.runs.find((r) => r.id === runId) ?? null) : null));
  const outcome = v.state === 'idle' ? v.outcome : null;
  const running = run?.state === 'running';
  const elapsedMs = useElapsed(run?.startedAt, running);
  return (
    <>
      {asking && (
        <div className="hver-ask" role="dialog" aria-label={`Update ${label} now?`}>
          <b>Update {label} now?</b>
          <span>
            {chatsText(asking)}. They'll restart on {v.latest} when their turn ends.
          </span>
          <span className="hver-ask-actions">
            <button type="button" className="btn-pill" onClick={() => u.setAsking(null)}>
              Cancel
            </button>
            <button type="button" className="btn-pill" onClick={() => void u.update('idle')}>
              Update when idle
            </button>
            <button type="button" className="btn-pill primary" onClick={() => void u.update('now')}>
              Update now
            </button>
          </span>
        </div>
      )}
      {run && (running ? !run.quiet : outputOf === run.id) && (
        <div className="basic-login-term install-term">
          <TermView
            tab={{ id: run.id, cwd: '', title: run.command }}
            visible
            readOnly
            transport={runTransport(run.id)}
            onExit={() => undefined}
          />
        </div>
      )}
      {running && (
        <div className="install-foot">
          {run.stopped ? <span role="status">Stopping…</span> : <UpdateProgressNote retrying={!!v.retrying} elapsedMs={elapsedMs} />}
          <button type="button" className="btn-pill" onClick={() => void native.harnessRuns.stop(run.id)}>
            Stop
          </button>
        </div>
      )}
      {outcome && (
        <div className={`install-outcome ${outcome.result === 'updated' ? 'ok' : 'warn'}`} role="status">
          {outcome.result === 'updated' && <Check size={13} />}
          <span>{outcome.message}</span>
          {outcome.result === 'unchanged' && (
            <button type="button" className="btn-pill" onClick={() => void u.update()}>
              Retry
            </button>
          )}
          {outcome.result !== 'updated' && run && (
            <button type="button" className="btn-pill" onClick={() => u.setOutputOf(run.id)}>
              Show output
            </button>
          )}
          {(outcome.result === 'failed' || outcome.result === 'broken') && manualUpdateCommand(v) && (
            <button type="button" className="btn-pill" onClick={() => copyText(v.command!, 'Copied command')}>
              Copy command
            </button>
          )}
        </div>
      )}
    </>
  );
}
