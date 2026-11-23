// The Memory tab's list of what MoMo wrote to Calendar and Reminders (#2139 P5, electron/momo/sources/writeLedger.cjs): the last 30 days, each with Undo, the user's own act (no card; main audits it). Main takes back only the item MoMo made, and only while it still matches: a changed or removed item is left alone and the row says so, as it does when the macOS helper can't remove it. Nothing is shown until MoMo has written something.
import { useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { MomoWrite } from '../../lib/native/contracts/momoSources';
import type { MomoMemoryResult } from '../../lib/native/contracts/momoMemory';
import { Group, Row } from '../pages/settings/Controls';
import { day, useRead } from './memoryRead';

const VERB: Record<MomoWrite['kind'], string> = {
  event: 'Added to Calendar',
  reminder: 'Added a reminder',
  complete: 'Marked a reminder done',
};

/** Main's answer in the Memory tab's own result shape (a refusal that means MoMo is off hides the list). */
async function readWrites(): Promise<MomoMemoryResult<{ writes: MomoWrite[] }>> {
  const r = await native.momoSources.writes();
  if (r.ok) return r;
  return { ok: false, error: r.error, ...(r.reason === 'not_allowed' || r.reason === 'unavailable' ? { reason: r.reason } : {}) };
}

function WriteRow({ write }: { write: MomoWrite }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undo = async () => {
    setBusy(true);
    try {
      const r = await native.momoSources.undoWrite(write.id);
      setError(r.ok ? null : r.error);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="momo-fact" data-write={write.id}>
      <Row
        title={
          <>
            {VERB[write.kind]}
            <div className="momo-change-item">{write.title}</div>
          </>
        }
        desc={
          <span className="momo-chips">
            <span className="applies-to momo-chip">{day(write.at)}</span>
            {write.undone !== undefined && <span className="applies-to momo-chip expired">Undone</span>}
          </span>
        }
      >
        {write.undone === undefined && (
          <button className="btn-pill soft" disabled={busy} aria-busy={busy} onClick={() => void undo()}>
            Undo
          </button>
        )}
      </Row>
      {error && (
        <div className="config-warning" role="alert">
          Couldn't undo: {error}
        </div>
      )}
    </div>
  );
}

/** What MoMo added to Calendar and Reminders in the last 30 days, each with Undo until it is undone. */
export function WrittenChanges() {
  const r = useRead(readWrites);
  if (r.off || !r.value?.writes.length) return null;
  return (
    <Group title="Added by MoMo" desc="Calendar and Reminders, the last 30 days. Undo removes only what MoMo added, if it hasn't changed.">
      {r.value.writes.map((w) => (
        <WriteRow key={`${w.id}:${w.undone ?? ''}`} write={w} />
      ))}
    </Group>
  );
}
