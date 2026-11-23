// The Memory tab's history (#2139 P3): the recent changes to the facts (by you, a MoMo chat or MoMo's background pass) with Undo, which main refuses (with why) when a fact it touched changed since; and the past facts a newer one replaced. Both read again whenever the memory changes (electron/momo/memoryIpc.cjs).
import { useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { MomoMemoryChange } from '../../lib/native/contracts/momoMemory';
import { Group, Row } from '../pages/settings/Controls';
import { byName, day, useRead } from './memoryRead';

const VERB: Record<MomoMemoryChange['op'], string> = {
  save: 'Added',
  update: 'Edited',
  forget: 'Deleted',
  pass: 'Updated',
  undo: 'Undid a change',
};

/** One fact's part in a change, in a few words: added, deleted, replaced, or edited from one text to another. */
export function itemText(i: MomoMemoryChange['items'][number]): string {
  if (!i.before) return `+ ${i.after?.text ?? ''}`;
  if (!i.after) return `− ${i.before.text}`;
  if (i.after.invalidAt !== undefined && i.before.invalidAt === undefined) return `Replaced: ${i.before.text}`;
  return i.before.text === i.after.text ? i.after.text : `${i.before.text} → ${i.after.text}`;
}

function ChangeRow({ change }: { change: MomoMemoryChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undo = async () => {
    setBusy(true);
    try {
      const r = await native.momoMemory.undo(change.id);
      setError(r.ok ? null : r.error);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const chips = (
    <span className="momo-chips">
      <span className="applies-to momo-chip">{byName(change.by)}</span>
      <span className="applies-to momo-chip">{day(change.at)}</span>
      {change.undone !== undefined && <span className="applies-to momo-chip expired">Undone</span>}
    </span>
  );
  return (
    <div className="momo-fact" data-change={change.id}>
      <Row
        title={
          <>
            {VERB[change.op]}
            {change.items.map((i) => (
              // a change touches each fact once
              <div key={(i.after ?? i.before)?.id} className="momo-change-item">
                {itemText(i)}
              </div>
            ))}
          </>
        }
        desc={chips}
      >
        {change.undoable && (
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

const readChanges = () => native.momoMemory.changes();
const readPast = () => native.momoMemory.past();

/** The newest changes to the facts, each with Undo while it can still be taken back. */
export function RecentChanges() {
  const r = useRead(readChanges);
  if (r.off) return null;
  return (
    <Group title="Recent changes">
      {r.error && (
        <div className="config-warning" role="alert">
          Couldn't read: {r.error}{' '}
          <button className="btn-pill soft" onClick={() => void r.load()}>
            Retry
          </button>
        </div>
      )}
      {r.value && !r.value.changes.length && <Row title="No changes yet" />}
      {r.value?.changes.map((c) => (
        <ChangeRow key={`${c.id}:${c.undone ?? ''}`} change={c} />
      ))}
    </Group>
  );
}

/** Facts a newer one replaced: kept for the record, never read by MoMo's chats; hidden until asked for. */
export function PastFacts() {
  const r = useRead(readPast);
  const [open, setOpen] = useState(false);
  const facts = r.value?.facts ?? [];
  if (r.off || !facts.length) return null;
  return (
    <Group
      title="Past facts"
      desc="Replaced by newer facts. MoMo doesn't use them."
      action={
        <button className="btn-pill soft" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : `Show ${facts.length}`}
        </button>
      }
    >
      {open &&
        facts.map((f) => (
          <Row
            key={f.id}
            title={f.text}
            desc={
              <span className="momo-chips">
                <span className="applies-to momo-chip">Replaced {day(f.invalidAt ?? f.createdAt)}</span>
              </span>
            }
          />
        ))}
    </Group>
  );
}
