// One routine's card in Settings › MoMo › Routines (#2139), the same card as a source's (sourceCards.module.css): its name and a chip (Needs your approval, Paused), when it runs in words, the sources it uses as chips that say whether each is connected, its actions, and what MoMo will do behind a disclosure. A proposal and an approved routine are the same card; the actions and the notes under it are theirs.
import type { ReactNode } from 'react';
import type { MomoSourceId } from '../../lib/native/contracts/momoSources';
import { ChevronDown } from '../ui/icons';
import { needsGrant } from './sourceConnect';
import { useMomoSource } from './useSourceConnect';
import styles from './sourceCards.module.css';

/** A source a routine uses, as a chip: its name, and "not connected" when MoMo cannot read it yet. */
function SourceUse({ id, label }: { id: MomoSourceId; label: string }) {
  const { source } = useMomoSource(id);
  const ready = source?.connected === true && !needsGrant(source);
  return ready ? <span className="hp-badge ok">{label}</span> : <span className="hp-badge warn">{label} · not connected</span>;
}

export function RoutineCard({
  name,
  when,
  chip,
  uses,
  prompt,
  actions,
  paused = false,
  children,
}: {
  name: string;
  when: string;
  chip?: ReactNode;
  uses: { id: MomoSourceId; label: string }[];
  prompt: string;
  actions: ReactNode;
  paused?: boolean;
  /** notes and the edit form, under the head */
  children?: ReactNode;
}) {
  return (
    <section className={styles.card} aria-label={name} data-paused={paused || undefined}>
      <div className={styles.head}>
        <div className={styles.text}>
          <div className={styles.titleLine}>
            <span className={styles.title}>{name}</span>
            {chip}
          </div>
          <div className={styles.status} data-status>
            {when}
          </div>
          {uses.length > 0 && (
            <div className={styles.uses}>
              Uses
              {uses.map((u) => (
                <SourceUse key={u.id} id={u.id} label={u.label} />
              ))}
            </div>
          )}
        </div>
        <div className={styles.actions}>{actions}</div>
      </div>
      {children}
      <details className={styles.details}>
        <summary>
          What MoMo will do <ChevronDown className={styles.chevron} size={13} aria-hidden />
        </summary>
        <p className={styles.prompt}>{prompt}</p>
      </details>
    </section>
  );
}
