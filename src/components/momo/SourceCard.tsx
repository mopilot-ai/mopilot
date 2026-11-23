// One source's card in Settings › MoMo › Sources (#2139 P2): icon, name, a status chip (Connected, Paused, Needs your OK), one plain line and ONE primary action for the state it is in; Files lists its folders with Remove and Add folder; what MoMo reads and keeps, Pause and Disconnect sit behind Details. Connecting is useSourceConnect's and the lines of a Calendar or Reminders that is not on are rowLine's (the chat's connect card shares both); Files needs no macOS grant, so Add folder connects it first when it is off. Pause is the access level Blocked and Resume is Read only (the third level, Read & ask to change, reads like Read only until MoMo can write, so Settings does not offer it).
import { useState, type ReactNode } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { MomoSource, MomoSourceId, MomoSourcesResult } from '../../lib/native/contracts/momoSources';
import { Calendar, Check, ChevronDown, Folder, FolderPlus, ListChecks, Spinner, X } from '../ui/icons';
import { KEEPS, KEEPS_ASK, NO_FOLDERS_LINE, PAUSED_LINE, SOURCE_COPY, foldersText } from './sourceCopy';
import { needsGrant, rowLine } from './sourceConnect';
import { useSourceConnect } from './useSourceConnect';
import styles from './sourceCards.module.css';

const ICONS: Record<MomoSourceId, ReactNode> = {
  calendar: <Calendar size={18} strokeWidth={1.6} aria-hidden />,
  reminders: <ListChecks size={18} strokeWidth={1.6} aria-hidden />,
  files: <Folder size={18} strokeWidth={1.6} aria-hidden />,
};

/** The connect day as the details say it: the year too when it isn't this year. */
const since = (ms: number, now = new Date()) => {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  });
};

/** A failure under one card (a connect's own is useSourceConnect's problem). */
type Notice = { text: string };

export function SourceCard({
  source,
  items,
  waiting,
  onChanged,
}: {
  source: MomoSource;
  items: string[];
  waiting: boolean;
  onChanged: () => void;
}) {
  const { id, label } = source;
  const copy = SOURCE_COPY[id];
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const lost = needsGrant(source);
  const c = useSourceConnect({ id, label, connected: source.connected, grantLost: lost, watching: waiting, onChanged });
  /** on, and macOS lets MoMo read it (a source macOS refuses is drawn as one to connect again) */
  const live = source.connected && !lost;
  const paused = live && source.level === 'blocked';
  /** Calendar and Reminders can be written, after a card; Files never */
  const writable = id !== 'files';
  const asks = live && writable && source.level === 'ask';
  const files = id === 'files';
  const folders = files && source.connected ? items : [];
  const line = rowLine({ id, phase: c.phase, problem: null, idle: copy.idle });
  /** the pane is the way: macOS refused, never asked, or the wait for the switch is running */
  const inSettings = !live && (c.phase === 'needs' || c.phase === 'waiting' || c.phase === 'stalled');

  /** Runs one call; a failure stays under the card until the next call. */
  const run = async <T extends object>(fn: () => Promise<MomoSourcesResult<T>>) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      // a source macOS no longer lets MoMo read is drawn as one to allow again (its Connect asks, or opens the pane the answer needs)
      if (!r.ok) setNotice({ text: r.error });
    } catch (e) {
      setNotice({ text: errorText(e) });
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const disconnect = () => {
    setConfirming(false);
    return run(() => native.momoSources.disconnect(id));
  };
  const setLevel = (level: 'blocked' | 'read' | 'ask') => run(() => native.momoSources.setLevel(id, level));
  // main opens the folder dialog and adds what the user picks; Files off connects first (it asks macOS for nothing)
  const addFolder = () =>
    run(async () => {
      if (!source.connected) {
        const r = await native.momoSources.connect('files');
        if (!r.ok) return r;
      }
      return native.momoSources.addFolder();
    });

  // a connect's own failure belongs to a card that is not on: once it is (here or in System Settings) it is stale
  const failure = live ? null : c.problem;
  const status: ReactNode = paused ? (
    PAUSED_LINE
  ) : live ? (
    files ? (
      folders.length ? (
        `MoMo can read ${foldersText(folders.length)}.`
      ) : (
        NO_FOLDERS_LINE
      )
    ) : asks ? (
      copy.onAsk
    ) : (
      copy.on
    )
  ) : files ? (
    copy.idle
  ) : line.waiting ? (
    <>
      <Spinner size={12} /> {line.desc}
    </>
  ) : (
    line.desc
  );
  const chip: ReactNode = paused ? (
    <span className="hp-badge">Paused</span>
  ) : live && !(files && !folders.length) ? (
    <span className="hp-badge ok">
      <Check size={10} strokeWidth={2.6} aria-hidden /> Connected
    </span>
  ) : line.badge ? (
    <span className="hp-badge warn">{line.badge}</span>
  ) : null;

  const folderButton = (
    <button className="btn-pill" disabled={busy} onClick={() => void addFolder()}>
      <FolderPlus size={14} aria-hidden /> Add folder…
    </button>
  );
  /** the one primary action of the state the card is in */
  const primary: ReactNode = paused ? (
    <button className="btn-pill" disabled={busy} onClick={() => void setLevel('read')}>
      Resume
    </button>
  ) : files && (!live || !folders.length) ? (
    folderButton
  ) : live ? null : inSettings ? (
    <>
      <button className="btn-pill" disabled={busy || c.busy} onClick={c.openSettings}>
        {c.phase === 'waiting' ? 'Open again' : 'Open System Settings'}
      </button>
      {c.phase === 'waiting' && (
        <button className="btn-pill ghost" onClick={() => void run(() => native.momoSources.cancelConnect(id))}>
          Cancel
        </button>
      )}
    </>
  ) : (
    <button className="btn-pill" disabled={busy || c.busy} onClick={() => void c.connect()}>
      Connect
    </button>
  );

  return (
    <section className={styles.card} aria-label={label} data-state={paused ? 'paused' : live ? 'on' : c.phase}>
      <div className={styles.head}>
        <span className={styles.icon}>{ICONS[id]}</span>
        <div className={styles.text}>
          <div className={styles.titleLine}>
            <span className={styles.title}>{label}</span>
            {chip}
          </div>
          <div className={styles.status} data-status data-tone={!live && !files && line.tone ? line.tone : undefined}>
            {status}
          </div>
        </div>
        {primary && <div className={styles.actions}>{primary}</div>}
      </div>
      {folders.length > 0 && (
        <>
          <ul className={styles.folders} aria-label="Folders MoMo may read">
            {folders.map((folder) => (
              <li key={folder} className={styles.folder}>
                <span className={styles.folderPath}>{folder}</span>
                <button
                  className="btn-pill ghost"
                  aria-label={`Remove ${folder}`}
                  disabled={busy}
                  onClick={() => void run(() => native.momoSources.removeFolder(folder))}
                >
                  <X size={14} aria-hidden /> Remove
                </button>
              </li>
            ))}
          </ul>
          {!paused && <div className={styles.addBar}>{folderButton}</div>}
        </>
      )}
      {(failure || notice) && (
        <div className={`config-warning ${styles.alert}`} role="alert">
          {failure ?? notice?.text}
        </div>
      )}
      <details className={styles.details}>
        <summary>
          Details <ChevronDown className={styles.chevron} size={13} aria-hidden />
        </summary>
        <dl className={styles.facts}>
          <dt>Reads</dt>
          <dd>{copy.reads}</dd>
          <dt>Keeps</dt>
          <dd>{asks ? KEEPS_ASK : KEEPS}</dd>
          {source.connected && (
            <>
              <dt>Connected</dt>
              <dd>{since(source.connectedAt)}</dd>
            </>
          )}
          {!files && live && copy.names && items.length > 0 && (
            <>
              <dt>{copy.names}</dt>
              <dd>{items.join(', ')}</dd>
            </>
          )}
        </dl>
        {source.connected && (
          <div className={styles.manage}>
            {confirming ? (
              <>
                <span className={styles.confirm}>Delete what MoMo copied from {label}?</span>
                <button className="btn-pill" disabled={busy} onClick={() => void disconnect()}>
                  Disconnect
                </button>
                <button className="btn-pill ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {live && writable && !paused && (
                  <button className="btn-pill ghost" disabled={busy} onClick={() => void setLevel(asks ? 'read' : 'ask')}>
                    {asks ? 'Stop changes' : 'Allow changes'}
                  </button>
                )}
                {live && !paused && (
                  <button className="btn-pill ghost" disabled={busy} onClick={() => void setLevel('blocked')}>
                    Pause
                  </button>
                )}
                <button className="btn-pill ghost" disabled={busy} onClick={() => setConfirming(true)}>
                  Disconnect
                </button>
              </>
            )}
          </div>
        )}
      </details>
    </section>
  );
}
