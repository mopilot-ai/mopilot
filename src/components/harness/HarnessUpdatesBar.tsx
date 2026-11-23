// Settings → All harnesses, around the list: "N harnesses have updates · Update all" above it (two or more), Update
// all's progress and summary, and "Last checked … · Check for updates" below. The list is read again when it opens.
import { useEffect } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { toast } from '../../store/core';
import { checkHarnessUpdates, updatableCount, useHarnessUpdates } from '../../harness/harnessUpdates';
import { harnessInfo } from '../../harness/registry';
import type { HarnessKind } from '../../harness/adapter';
import { Download, Spinner } from '../ui/icons';

const labelOf = (kind: string) => harnessInfo(kind as HarnessKind)?.label ?? kind;

/** "12 min ago", "just now", "3 h ago". */
export function ago(at: number, now = Date.now()) {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

type Result = { harness: string; outcome: { result: string; message: string; from: string | null; to: string | null } | null };

/** Update all's summary (it ran at least one): who updated, who didn't (with why on hover). */
function summary(results: Result[]) {
  const done = results.filter((r) => r.outcome?.result === 'updated');
  const failed = results.filter((r) => r.outcome?.result !== 'updated');
  const head = `${done.length} of ${results.length} ${results.length === 1 ? 'harness' : 'harnesses'} updated`;
  const parts = done.map((r) => {
    const o = r.outcome!;
    return o.from && o.to ? `${labelOf(r.harness)} ${o.from} → ${o.to}` : labelOf(r.harness);
  });
  if (failed.length) parts.push(`${failed.map((r) => labelOf(r.harness)).join(', ')} didn't`);
  return {
    text: `${head}: ${parts.join(' · ')}`,
    why: failed.map((r) => `${labelOf(r.harness)}: ${r.outcome?.message ?? 'cancelled'}`).join('\n'),
  };
}

const run = (fn: () => Promise<unknown>, what: string) => void fn().catch((e) => toast(`Couldn't ${what}: ${errorText(e)}`, 'error'));

/** Above the list. */
export function HarnessUpdatesBanner() {
  const s = useHarnessUpdates();
  // the versions are read again whenever the page opens
  useEffect(() => {
    void checkHarnessUpdates();
  }, []);
  const all = s.all;
  if (all?.running)
    return (
      <div className="hupd-banner" role="status">
        <Spinner size={12} />
        <span>
          {all.cancelled ? 'Stopping after ' : 'Updating '}
          {all.current ? labelOf(all.current) : '…'}… ({all.index} of {all.total})
        </span>
        {!all.cancelled && (
          <button type="button" className="btn-pill" onClick={() => run(() => native.harnessUpdates.cancelAll(), 'cancel the updates')}>
            Cancel
          </button>
        )}
      </div>
    );
  const n = updatableCount(s);
  const sum = all && all.results.length ? summary(all.results) : null;
  if (n < 2 && !sum) return null;
  const names = s.harnesses.filter((h) => h.updatable).map((h) => labelOf(h.harness));
  return (
    <div className="hupd-banner">
      {sum && n < 2 ? (
        <span title={sum.why || undefined}>{sum.text}</span>
      ) : (
        <span>
          {n} harnesses have updates: {names.join(', ')}
        </span>
      )}
      {n >= 2 && (
        <button type="button" className="btn-pill" onClick={() => run(() => native.harnessUpdates.updateAll(), 'update the harnesses')}>
          <Download size={12} /> Update all
        </button>
      )}
    </div>
  );
}

/** Below the list. */
export function HarnessUpdatesFoot() {
  const at = useHarnessUpdates((s) => s.checkedAt);
  const checking = useHarnessUpdates((s) => s.checking);
  return (
    <div className="hupd-foot">
      {at ? <span>Last checked {ago(at)}</span> : null}
      <button type="button" className="text-link" disabled={checking} onClick={() => void checkHarnessUpdates(true)}>
        {checking ? <Spinner size={11} /> : null} Check for updates
      </button>
    </div>
  );
}
