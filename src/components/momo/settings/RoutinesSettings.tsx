// Settings › MoMo › Routines (#2139): what a routine is in one line, then one list of cards: the routines MoMo proposed (Approve and Decline: nothing runs before Approve) and the user's own (RoutinesList.tsx: Pause, Resume, Edit, Remove), each with when it runs, the sources it uses and what MoMo will do. A routine's result goes to MoMo's Chat as a message from MoMo.
import { useMomoRoutines } from '../../../lib/momoRoutines';
import { Group } from '../../pages/settings/Controls';
import { RoutineCard } from '../RoutineCard';
import { ProposalConnectNote } from '../RoutineConnectNote';
import { RoutinesList } from '../RoutinesList';
import { PROPOSED_CHIP, ROUTINES_EMPTY, ROUTINES_INTRO, whenText } from '../routineCopy';
import { MOMO_SOURCE_IDS, type MomoSourceId } from '../../../lib/native/contracts/momoSources';
import cards from '../sourceCards.module.css';
import styles from '../routinesList.module.css';

export function RoutinesSettings() {
  const routines = useMomoRoutines();
  const { view } = routines;
  if (!view)
    return routines.error ? (
      <Group title="Routines">
        <div className={styles.empty}>
          {routines.error}{' '}
          <button type="button" className="btn sm ghost" onClick={() => void routines.reload()}>
            Try again
          </button>
        </div>
      </Group>
    ) : null;
  /** a proposal names the sources it reads as text ("Calendar, Reminders"): the ones main lists, as chips */
  const usesOf = (text: string) =>
    view.sources.filter(
      (s): s is { id: MomoSourceId; label: string } =>
        text.split(', ').includes(s.label) && (MOMO_SOURCE_IDS as readonly string[]).includes(s.id),
    );
  const none = !view.proposals.length && !view.routines.length;
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <div>
          <h2 className="settings-group-title">Routines</h2>
          <div className="settings-group-desc">{ROUTINES_INTRO}</div>
        </div>
      </div>
      {routines.error ? (
        <div className={styles.error} role="alert">
          {routines.error}
        </div>
      ) : null}
      {none ? <div className={styles.empty}>{ROUTINES_EMPTY}</div> : null}
      <div className={cards.cards}>
        {view.proposals.map((p) => (
          <RoutineCard
            key={p.id}
            name={p.name}
            when={whenText(p.schedule)}
            chip={<span className="hp-badge warn">{PROPOSED_CHIP}</span>}
            uses={usesOf(p.sources)}
            prompt={p.prompt}
            actions={
              <>
                <button type="button" className="btn-pill primary" onClick={() => void routines.approve(p.id, p.rev)}>
                  Approve
                </button>
                <button type="button" className="btn-pill ghost" onClick={() => void routines.remove(p.id)}>
                  Decline
                </button>
              </>
            }
          >
            <ProposalConnectNote ids={usesOf(p.sources).map((u) => u.id)} />
          </RoutineCard>
        ))}
        <RoutinesList routines={view.routines} sources={view.sources} onEdit={routines.edit} onRemove={(id) => void routines.remove(id)} />
      </div>
    </section>
  );
}
