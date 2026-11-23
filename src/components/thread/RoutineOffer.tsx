// "Save as routine" (#3571, G4): one line under a chat's last turn when it finished with browser or app steps it can keep (main's session routineOffer), never on its own: the user names it and saves, and it runs again from the / menu.
import { useState } from 'react';
import { useSessionField } from '../../store/session/useSession';
import { native } from '../../lib/native';
import { failure } from '../../lib/routines';
import { pluralize } from '../../lib/format';
import styles from './routines.module.css';

export function RoutineOffer({ chatId }: { chatId: string }) {
  const offer = useSessionField(chatId, (s) => s.routineOffer);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (saved) return <div className={styles.offer}>Saved “{saved}”. Run it from the / menu.</div>;
  if (!offer) return null;
  const save = async () => {
    setBusy(true);
    const r = await native.routines
      .saveLast(chatId, name.trim())
      .catch(() => ({ ok: false as const, error: 'Couldn’t save the routine.' }));
    setBusy(false);
    setError(failure(r));
    if (r.ok) setSaved(r.routine.name);
  };
  if (!naming)
    return (
      <div className={styles.offer}>
        <button type="button" className="btn-pill ghost" onClick={() => setNaming(true)}>
          Save as routine
        </button>
        <span className={styles.meta}>{pluralize(offer.steps, 'step')}</span>
      </div>
    );
  return (
    <form
      className={styles.offer}
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && !busy) void save();
      }}
    >
      <input
        className="input"
        aria-label="Routine name"
        placeholder="Routine name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="btn-pill primary" disabled={!name.trim() || busy}>
        Save
      </button>
      <button type="button" className="btn-pill ghost" onClick={() => (setNaming(false), setError(null))}>
        Cancel
      </button>
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}
