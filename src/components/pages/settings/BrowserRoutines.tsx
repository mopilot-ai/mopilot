// Settings › Browser › Routines (#3571, G4): the browser steps the user saved from a chat as routines, each with what it does, its steps and how often it ran; Rename and Delete. A routine runs from the composer's / menu, where each one is a skill.
import { useState } from 'react';
import { useRoutines } from '../../../lib/routines';
import { pluralize } from '../../../lib/format';
import type { RoutineView } from '../../../lib/native/routines';
import styles from '../../thread/routines.module.css';

export const ROUTINES_INTRO = 'Browser and app steps saved from a chat. Run one from the / menu in any chat.';
export const ROUTINES_EMPTY = 'No routines yet. When a chat finishes browser or app steps, choose Save as routine under it.';

/** "5 steps · ran 2 times" */
export const routineMeta = (r: RoutineView) =>
  `${pluralize(r.steps.length, 'step')} · ${r.runs ? `ran ${pluralize(r.runs, 'time')}` : 'not run yet'}`;

function RoutineItem({
  r,
  onRename,
  onRemove,
}: {
  r: RoutineView;
  onRename: (name: string, d: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(r.name);
  const [description, setDescription] = useState(r.description);
  if (editing)
    return (
      <li className={styles.item}>
        <input className="input" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="input"
          aria-label="What it does"
          value={description}
          placeholder="What it does"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className={styles.actions}>
          <button
            type="button"
            className="btn-pill primary"
            disabled={!name.trim()}
            onClick={() => void onRename(name.trim(), description.trim()).then((ok) => ok && setEditing(false))}
          >
            Save
          </button>
          <button type="button" className="btn-pill ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </li>
    );
  return (
    <li className={styles.item}>
      <div className={styles.name}>{r.name}</div>
      {r.description ? <div className="settings-group-desc">{r.description}</div> : null}
      <div className="settings-group-desc">{routineMeta(r)}</div>
      <div className={styles.actions}>
        <button
          type="button"
          className="btn-pill ghost"
          onClick={() => {
            setName(r.name);
            setDescription(r.description);
            setEditing(true);
          }}
        >
          Rename
        </button>
        {confirming ? (
          <>
            <button type="button" className="btn-pill danger" onClick={onRemove}>
              Delete
            </button>
            <button type="button" className="btn-pill ghost" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="btn-pill ghost" onClick={() => setConfirming(true)}>
            Delete…
          </button>
        )}
      </div>
    </li>
  );
}

export function BrowserRoutines() {
  const { routines, skillsProblem, error, reload, rename, remove } = useRoutines();
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <div>
          <h2 className="settings-group-title">Routines</h2>
          <div className="settings-group-desc">{ROUTINES_INTRO}</div>
        </div>
      </div>
      {skillsProblem && routines?.length ? <div className="settings-group-desc">New chats won't list these. {skillsProblem}</div> : null}
      {error ? (
        <div className="settings-group-desc" role="alert">
          {error}{' '}
          <button type="button" className="btn sm ghost" onClick={() => void reload()}>
            Try again
          </button>
        </div>
      ) : null}
      {routines && !routines.length ? <div className="settings-group-desc">{ROUTINES_EMPTY}</div> : null}
      {routines?.length ? (
        <ul className={styles.list}>
          {routines.map((r) => (
            <RoutineItem key={`${r.id}:${r.rev}`} r={r} onRename={(n, d) => rename(r, n, d)} onRemove={() => void remove(r.id)} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
