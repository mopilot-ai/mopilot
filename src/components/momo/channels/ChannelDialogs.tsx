// The dialogs of MoMo's channels (A2): a name and nothing else (new channel, new group, rename), a channel's instructions (at most 2,000 characters), and the delete that waits two seconds before it can be pressed and offers to archive instead. Each shows the Mac's own words when it refuses, and stays open to fix it.
import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from '../../ui/Modal';
import { CHANNEL_COPY as C, DELETE_DELAY_MS } from './channelCopy';
import styles from './channels.module.css';

/** The longest instructions main keeps (electron/momo/channels.cjs MAX_INSTRUCTIONS). */
export const MAX_INSTRUCTIONS = 2000;

type Settle = (error: string | null) => void;

/** The wish of a dialog's button: it resolves the error to show, or null when it worked and the dialog may go. */
export type Submit = (value: string) => Promise<string | null>;

/** One text field with Save and Cancel, the shared body of the name and instructions dialogs. */
function FieldDialog({
  title,
  hint,
  label,
  initial,
  action,
  multiline,
  submit,
  onClose,
}: {
  title: string;
  hint: string;
  label: string;
  initial: string;
  action: string;
  multiline?: boolean;
  submit: Submit;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settle: Settle = (e) => (e === null ? onClose() : (setError(e), setBusy(false)));
  const go = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    void submit(value).then(settle);
  };
  const field = multiline ? (
    <textarea className={styles.field} aria-label={label} value={value} rows={7} autoFocus onChange={(e) => setValue(e.target.value)} />
  ) : (
    <input className={styles.field} aria-label={label} value={value} autoFocus onChange={(e) => setValue(e.target.value)} />
  );
  return (
    <Modal title={title} onClose={onClose}>
      <form className={styles.body} onSubmit={go}>
        <p className={styles.hint}>{hint}</p>
        {field}
        {multiline ? (
          <p className={styles.count} data-over={value.length > MAX_INSTRUCTIONS ? '' : undefined}>
            {value.length} / {MAX_INSTRUCTIONS}
          </p>
        ) : null}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onClose}>
            {C.cancel}
          </button>
          <button type="submit" className={styles.primary} disabled={busy || (!multiline && !value.trim())}>
            {action}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A name only: "A place for one topic. Your main chat stays as it is." */
export function NameDialog({
  group,
  rename,
  initial = '',
  submit,
  onClose,
}: {
  group?: boolean;
  rename?: boolean;
  initial?: string;
  submit: Submit;
  onClose: () => void;
}) {
  const title = rename ? (group ? C.renameGroup : C.renameChannel) : group ? C.newGroup : C.newChannel;
  return (
    <FieldDialog
      title={title}
      hint={group ? C.groupHint : C.channelHint}
      label={C.name}
      initial={initial}
      action={rename ? C.save : C.create}
      submit={submit}
      onClose={onClose}
    />
  );
}

/** A channel's instructions: an L1 document for that channel alone. */
export function InstructionsDialog({ initial, submit, onClose }: { initial: string; submit: Submit; onClose: () => void }) {
  return (
    <FieldDialog
      title={C.instructionsTitle}
      hint={C.instructionsHint}
      label={C.instructions}
      initial={initial}
      action={C.save}
      multiline
      submit={submit}
      onClose={onClose}
    />
  );
}

/** "Can't be undone. You can archive it instead." Delete is off for DELETE_DELAY_MS after the dialog opens. */
export function DeleteDialog({
  name,
  remove,
  archive,
  onClose,
}: {
  name: string;
  remove: () => Promise<string | null>;
  archive: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), DELETE_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  const run = (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    void work().then((e) => (e === null ? onClose() : (setError(e), setBusy(false))));
  };
  return (
    <Modal title={C.deleteTitle(name)} onClose={onClose}>
      <div className={styles.body}>
        <p className={styles.hint}>{C.deleteBody}</p>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onClose}>
            {C.cancel}
          </button>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => run(archive)}>
            {C.archiveInstead}
          </button>
          <button type="button" className={styles.danger} disabled={!ready || busy} onClick={() => run(remove)}>
            {C.delete}
          </button>
        </div>
      </div>
    </Modal>
  );
}
