// A question that blocks until it is answered (Stop this task? Forget this note?): focus goes to the safe answer, Tab stays inside, Escape is Cancel.
import { useRef, type ReactNode } from 'react';
import { useDialog } from './useDialog';
import styles from './home.module.css';

export function Confirm({
  title,
  text,
  confirm,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  text?: ReactNode;
  confirm: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onCancel);
  return (
    <div ref={ref} className={styles.card} role="alertdialog" aria-label={title} aria-modal="true">
      <strong>{title}</strong>
      {text ? <span className={styles.meta}>{text}</span> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={onConfirm}>
          {confirm}
        </button>
        <button type="button" className={styles.btn} data-autofocus onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
