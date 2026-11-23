// What the home said when it refused a move: its cause as it worded it, and the one tap that fixes it when it offered one.
import type { MomoHomeResult } from './homeActions';
import { useMomoAct } from './useMomoHome';
import styles from './home.module.css';

export function Refusal({ failed }: { failed: Extract<MomoHomeResult, { ok: false }> | null }) {
  const { act, busy } = useMomoAct();
  if (!failed) return null;
  const fix = failed.fix;
  return (
    <p className={styles.error} role="alert">
      {failed.cause}{' '}
      {fix ? (
        <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'intent', intent: fix.intent })}>
          {fix.label}
        </button>
      ) : null}
    </p>
  );
}
