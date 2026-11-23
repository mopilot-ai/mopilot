// MoMo's brief and limits as rows (W3.1, W3.4, W3.5): the brief on or off and its time, quiet hours, the daily cap, and whether the lock screen shows message text. A change is sent as soon as it is made (a time when it is picked, a number after a short pause), and the row shows the home's value, not the last thing typed.
import { useEffect, useRef, useState } from 'react';
import type { MomoSettingsView } from '../../../../shared/momoView';
import type { MomoHomeAction } from './homeActions';
import { Refusal } from './Refusal';
import { useMomoAct } from './useMomoHome';
import styles from './home.module.css';

type Patch = Extract<MomoHomeAction, { type: 'settings.set' }>['patch'];

/** An input whose value follows the home's and which sends its change after `delay` ms (0: at once). */
function CommitInput({
  label,
  value,
  delay,
  onCommit,
  ...rest
}: { label: string; value: string; delay: number; onCommit: (v: string) => void } & Record<string, unknown>) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // what the home says wins, unless the user is mid-edit
  useEffect(() => setText(value), [value]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const commit = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (v && v !== value) onCommit(v);
  };
  return (
    <label>
      <span className={styles.meta}>{label}</span>
      <input
        className={styles.field}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (timer.current) clearTimeout(timer.current);
          const v = e.target.value;
          if (delay === 0) commit(v);
          else timer.current = setTimeout(() => commit(v), delay);
        }}
        onBlur={(e) => commit(e.target.value)}
        {...rest}
      />
    </label>
  );
}

export function SettingsRows({ settings: s }: { settings: MomoSettingsView }) {
  const { act, busy, failed } = useMomoAct();
  const set = (patch: Patch) => void act({ type: 'settings.set', patch });
  return (
    <section className={styles.card} aria-label="Morning brief" aria-busy={busy}>
      <h2 className={styles.h1}>Morning brief</h2>
      <label>
        <input type="checkbox" checked={s.brief.on} disabled={busy} onChange={(e) => set({ briefOn: e.target.checked })} /> Send a brief
      </label>
      <CommitInput label="Time" type="time" value={s.brief.time} delay={0} onCommit={(v) => set({ briefTime: v })} />
      <CommitInput label="Quiet hours from" type="time" value={s.quietHours.from} delay={0} onCommit={(v) => set({ quietFrom: v })} />
      <CommitInput label="Quiet hours to" type="time" value={s.quietHours.to} delay={0} onCommit={(v) => set({ quietTo: v })} />
      <CommitInput
        label="Tell me now at most"
        type="number"
        min={0}
        max={50}
        value={String(s.dailyCap)}
        delay={400}
        onCommit={(v) => Number.isFinite(Number(v)) && set({ dailyCap: Number(v) })}
      />
      <p className={styles.meta}>A quiet day means no brief and no push.</p>
      <label>
        <input type="checkbox" checked={s.previews} disabled={busy} onChange={(e) => set({ previews: e.target.checked })} /> Show text on
        the lock screen
      </label>
      <p className={styles.meta}>
        {s.previews ? 'The text is sealed. Apple and the relay only see “MoMo needs you”.' : 'The lock screen says “MoMo needs you”.'}
      </p>
      <Refusal failed={failed} />
    </section>
  );
}
