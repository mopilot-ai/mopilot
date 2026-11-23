// The Outputs section of MoMo's right panel (#2139, designs/momo-outputs): the text files MoMo saved with momo_save_file, newest first and bounded, each opening in its default app; a file's menu has Show in Finder, Save a copy and Delete. A file that is no longer on the disk is dimmed with only Delete; a file saved after MoMo read the user's data says so. Every state is real: loading, unreadable, empty, and a click that failed says why.
import { useState } from 'react';
import { native } from '../../lib/native';
import type { MomoOutput } from '../../lib/native/momoOutputs';
import { relativeTime } from '../../lib/format';
import { useMomoOutputs } from './useMomoOutputs';
import styles from './momoPanel.module.css';

const SHOWN = 8;

const sizeText = (n: number) =>
  n < 1000 ? `${n} B` : n < 1_000_000 ? `${Math.round(n / 100) / 10} KB` : `${Math.round(n / 100_000) / 10} MB`;

function OutputRow({ file, onError }: { file: MomoOutput; onError: (message: string) => void }) {
  const [menu, setMenu] = useState(false);
  const run = (call: Promise<{ ok: boolean; error?: string }>) =>
    call.then(
      (r) => (r.ok ? onError('') : onError(r.error ?? 'Something went wrong')),
      () => onError('Something went wrong'),
    );
  /** A menu item: the menu closes as it is chosen, and the call's own result shows below. */
  const item = (call: Promise<{ ok: boolean; error?: string }>) => {
    setMenu(false);
    return run(call);
  };
  return (
    <li className={styles.output} data-gone={file.gone || undefined}>
      <button
        type="button"
        className={styles.item}
        disabled={file.gone}
        aria-label={file.gone ? `${file.name}, file no longer there` : `Open ${file.name}`}
        onClick={() => void run(native.momoOutputs.open(file.id))}
      >
        <span className={styles.itemTitle}>{file.name}</span>
        <span className={styles.meta}>
          {file.gone ? 'File no longer there' : `${sizeText(file.size)} · ${relativeTime(file.at / 1000)}`}
          {file.fromPrivate && !file.gone ? ' · After reading your data' : ''}
        </span>
      </button>
      <button
        type="button"
        className={styles.more}
        aria-label={`Actions for ${file.name}`}
        aria-expanded={menu}
        onClick={() => setMenu((v) => !v)}
      >
        ⋯
      </button>
      {menu ? (
        <div className={styles.outputMenu} role="menu" aria-label={`${file.name} actions`}>
          {file.gone ? null : (
            <>
              <button type="button" role="menuitem" onClick={() => void item(native.momoOutputs.reveal(file.id))}>
                Show in Finder
              </button>
              <button type="button" role="menuitem" onClick={() => void item(native.momoOutputs.saveCopy(file.id))}>
                Save a copy…
              </button>
            </>
          )}
          <button type="button" role="menuitem" onClick={() => void item(native.momoOutputs.remove(file.id))}>
            Delete
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function MomoOutputs() {
  const o = useMomoOutputs();
  const [all, setAll] = useState(false);
  const [failed, setFailed] = useState('');
  if (o.status === 'loading') return <p className={styles.meta}>Loading…</p>;
  if (o.status === 'error') return <p className={styles.meta}>Couldn’t read your files.</p>;
  if (!o.files.length) return <p className={styles.meta}>Files MoMo makes show up here.</p>;
  return (
    <>
      <ul className={styles.list}>
        {o.files.slice(0, all ? undefined : SHOWN).map((f) => (
          <OutputRow key={f.id} file={f} onError={setFailed} />
        ))}
      </ul>
      {o.files.length > SHOWN ? (
        <button type="button" className={styles.more} aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show all ${o.files.length}`}
        </button>
      ) : null}
      {failed ? (
        <p className={styles.meta} role="alert">
          {failed}
        </p>
      ) : null}
      <p className={styles.meta}>Stored on this Mac, not encrypted. Reset MoMo deletes them.</p>
    </>
  );
}
