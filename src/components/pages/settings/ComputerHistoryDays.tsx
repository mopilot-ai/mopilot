// Settings → Computer History → Memories (#1363): how long they are kept, one row per day with its memories to read and a Delete, and Delete all; deleting asks first and says that what was already shared with a chat stays in that chat.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import { dayLabel, refusalOf } from '../../../store/computerHistory';
import { errorText } from '../../../lib/ignored';
import type { ComputerHistoryResult, ComputerHistoryState } from '../../../lib/native/computerHistory';
import { Group, Row, Select } from '../Settings';

const RETENTION = [7, 14, 30, 90].map((d) => ({ value: String(d), label: `${d} days` }));
export const SHARED_NOTE =
  "Memories you already shared with a chat stay in that chat's history; deleting them here doesn't remove them there.";

/** The days with memories, read again whenever main says Computer History changed. */
function useDays() {
  const [days, setDays] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await native.computerHistory.days();
      if (mine !== seq.current) return;
      if (r.ok) {
        setDays(r.days);
        setError(null);
      } else setError(refusalOf(r));
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    // read again on every change main broadcasts: a day may have appeared (an entry written) or gone (a delete, retention)
    return native.computerHistory.onChanged(() => void load());
  }, [load]);
  return { days, error, load };
}

/** One day's memories as text, read when the row is opened. */
function DayText({ day }: { day: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    native.computerHistory.memories({ days: [day] }).then(
      (r) => {
        if (!live) return;
        if (r.ok) setText(r.text || 'Nothing recorded this day.');
        else setError(refusalOf(r));
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [day]);
  if (error) return <div className="config-warning">Couldn't read this day: {error}</div>;
  return <pre className="ch-day-text">{text ?? 'Reading…'}</pre>;
}

export function ComputerHistoryDays({
  state,
  change,
}: {
  state: ComputerHistoryState;
  change: (what: string, run: () => Promise<ComputerHistoryResult<object>>) => Promise<boolean>;
}) {
  const { days, error, load } = useDays();
  const [open, setOpen] = useState<string | null>(null);
  const remove = async (day: string) => {
    if (!window.confirm(`Delete the memories of ${dayLabel(day)}? ${SHARED_NOTE}`)) return;
    if (open === day) setOpen(null);
    await change(`delete ${dayLabel(day)}`, () => native.computerHistory.deleteDay(day));
    await load();
  };
  const removeAll = async () => {
    if (!window.confirm(`Delete all Computer History memories on this Mac? ${SHARED_NOTE}`)) return;
    setOpen(null);
    await change('delete all memories', () => native.computerHistory.deleteAll());
    await load();
  };
  return (
    <Group
      title="Memories"
      desc={SHARED_NOTE}
      action={
        days?.length ? (
          <button className="btn-pill soft" onClick={removeAll}>
            Delete all
          </button>
        ) : undefined
      }
    >
      <Row title="Keep memories for" desc="Older days are deleted automatically.">
        <Select
          value={String(state.settings.retentionDays)}
          options={RETENTION}
          onChange={(v) => change('change how long memories are kept', () => native.computerHistory.setRetention(Number(v)))}
        />
      </Row>
      {error && (
        <div className="config-warning" role="alert">
          Couldn't list the days: {error}{' '}
          <button className="btn-pill soft" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {days && !days.length && <Row title="No memories yet" desc="They appear here as you use the apps and sites you added." />}
      {days?.map((day) => (
        <div key={day} className="ch-day">
          <Row title={dayLabel(day)} desc={day}>
            <button className="btn-pill soft" aria-expanded={open === day} onClick={() => setOpen(open === day ? null : day)}>
              {open === day ? 'Hide' : 'Show'}
            </button>
            <button className="btn-pill soft" aria-label={`Delete ${dayLabel(day)}`} onClick={() => remove(day)}>
              Delete
            </button>
          </Row>
          {open === day && <DayText day={day} />}
        </div>
      ))}
    </Group>
  );
}
