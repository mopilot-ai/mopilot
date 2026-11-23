// MoMo's routines in Settings › MoMo › Routines (#2293, redone as cards in #2139): every routine the user approved, paused ones too, as a RoutineCard with Pause or Resume, Edit (its name, what it does, its schedule as a time and days or an RRULE, the sources it may read) and Remove (once confirmed). Main saves each change (momoRoutines:edit), and the list is read again from it; an edit form closes only once main saved it.
import { useState } from 'react';
import { MOMO_SOURCE_IDS, type MomoSourceId } from '../../lib/native/contracts/momoSources';
import type { MomoRoutine, MomoRoutineEdit } from '../../lib/native/momoRoutines';
import { RoutineCard } from './RoutineCard';
import { whenText } from './routineCopy';
import { CONNECTABLE, RoutineConnectNote } from './RoutineConnectNote';
import styles from './routinesList.module.css';

const DAYS = [
  ['MO', 'Mon'],
  ['TU', 'Tue'],
  ['WE', 'Wed'],
  ['TH', 'Thu'],
  ['FR', 'Fri'],
  ['SA', 'Sat'],
  ['SU', 'Sun'],
] as const;
const WEEK = DAYS.map(([id]) => id);

export type RoutineActions = {
  /** resolves to whether main saved it */
  onEdit: (routineId: string, edit: MomoRoutineEdit) => Promise<boolean>;
  onRemove: (routineId: string) => void;
};

/** The edit form: what is shown is what is saved; a schedule that isn't a time and days is edited as its RRULE. */
function EditForm({
  routine,
  sources,
  onSave,
  onCancel,
}: {
  routine: MomoRoutine;
  sources: { id: string; label: string }[];
  onSave: (edit: MomoRoutineEdit) => unknown;
  onCancel: () => void;
}) {
  const [name, setName] = useState(routine.name);
  const [prompt, setPrompt] = useState(routine.prompt);
  const [time, setTime] = useState(routine.parts?.time ?? '');
  const [days, setDays] = useState<string[]>(routine.parts?.days ?? []);
  const [rrule, setRrule] = useState(routine.rrule);
  const [reads, setReads] = useState<string[]>(routine.sources);
  const flip = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  // only what the user changed is sent, in a fixed order: an untouched schedule isn't rewritten (which would count it
  // from now), and a change made elsewhere to another field since the form opened isn't undone
  const save = () => {
    const inOrder = (all: readonly string[], picked: string[]) => all.filter((x) => picked.includes(x));
    const ids = sources.map((x) => x.id);
    const pickedDays = inOrder(WEEK, days);
    const pickedSources = inOrder(ids, reads);
    const edit: MomoRoutineEdit = {};
    if (name !== routine.name) edit.name = name;
    if (prompt !== routine.prompt) edit.prompt = prompt;
    if (routine.parts) {
      if (time !== routine.parts.time || pickedDays.join() !== routine.parts.days.join()) Object.assign(edit, { time, days: pickedDays });
    } else if (rrule !== routine.rrule) edit.rrule = rrule;
    if (pickedSources.join() !== inOrder(ids, routine.sources).join()) edit.sources = pickedSources;
    return Object.keys(edit).length ? onSave(edit) : onCancel();
  };
  return (
    <form
      className={styles.form}
      aria-label={`Edit ${routine.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className={styles.field}>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className={styles.field}>
        What it does
        <textarea value={prompt} rows={3} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      {routine.parts ? (
        <>
          <label className={styles.field}>
            Time
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <fieldset className={styles.days}>
            <legend>Days (none: every day)</legend>
            {DAYS.map(([id, label]) => (
              <button key={id} type="button" className="btn-pill" aria-pressed={days.includes(id)} onClick={() => setDays(flip(days, id))}>
                {label}
              </button>
            ))}
          </fieldset>
        </>
      ) : (
        <label className={styles.field}>
          Schedule (RRULE)
          <input value={rrule} onChange={(e) => setRrule(e.target.value)} />
        </label>
      )}
      <fieldset className={styles.days}>
        <legend>May read</legend>
        {sources.map((s) => (
          <label key={s.id}>
            <input type="checkbox" checked={reads.includes(s.id)} onChange={() => setReads(flip(reads, s.id))} /> {s.label}
          </label>
        ))}
      </fieldset>
      <div className={styles.formActions}>
        <button type="submit" className="btn sm primary">
          Save
        </button>
        <button type="button" className="btn sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The sources a routine reads, as the chips name them (a name main no longer knows is left out). */
export const usesOf = (ids: string[], sources: { id: string; label: string }[]) =>
  sources.filter(
    (s): s is { id: MomoSourceId; label: string } => ids.includes(s.id) && (MOMO_SOURCE_IDS as readonly string[]).includes(s.id),
  );

export function RoutinesList({
  routines,
  sources,
  onEdit,
  onRemove,
}: { routines: MomoRoutine[]; sources: { id: string; label: string }[] } & RoutineActions) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <>
      {routines.map((r) => (
        <RoutineCard
          key={r.id}
          name={r.name}
          when={whenText(r.schedule)}
          chip={r.paused ? <span className="hp-badge">Paused</span> : undefined}
          paused={r.paused}
          uses={usesOf(r.sources, sources)}
          prompt={r.prompt}
          actions={
            <>
              <button type="button" className="btn-pill" onClick={() => onEdit(r.id, { paused: !r.paused })}>
                {r.paused ? 'Resume' : 'Pause'}
              </button>
              <button
                type="button"
                className="btn-pill ghost"
                aria-expanded={editing === r.id}
                onClick={() => setEditing(editing === r.id ? null : r.id)}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn-pill ghost"
                aria-label={`Remove ${r.name}`}
                onClick={() => {
                  // it was approved: asked once more, since it can't be brought back but by proposing it again
                  if (window.confirm(`Remove “${r.name}”? It stops running.`)) onRemove(r.id);
                }}
              >
                Remove
              </button>
            </>
          }
        >
          {CONNECTABLE.filter((id) => r.sources.includes(id)).map((id) => (
            <RoutineConnectNote key={id} source={id} />
          ))}
          {editing === r.id ? (
            <EditForm
              routine={r}
              sources={sources}
              onCancel={() => setEditing(null)}
              onSave={async (edit) => {
                // closed only once saved: a refused edit keeps what the user typed
                if (await onEdit(r.id, edit)) setEditing((now) => (now === r.id ? null : now));
              }}
            />
          ) : null}
        </RoutineCard>
      ))}
    </>
  );
}
