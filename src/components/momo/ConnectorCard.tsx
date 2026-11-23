// One cloud account's card in Settings › MoMo › Sources (#2999 C0), in the sources' card look (SourceCard.tsx): icon, name, a status chip (Connected, Paused, Sign in again), one plain line and ONE primary action for its state (Connect, Cancel while the browser sign-in waits, Resume when paused, Sign in again); what MoMo may do with it, Pause and Disconnect sit behind Details. A cancelled sign-in shows no failure.
import { useState, type ReactNode } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { MomoConnector, MomoConnectorsResult } from '../../lib/native/contracts/momoConnectors';
import { Check, ChevronDown, Cloud, Spinner } from '../ui/icons';
import styles from './sourceCards.module.css';

/** What a connected account lets MoMo do, as the details say it. */
const ACCESS = {
  blocked: 'Nothing while paused.',
  read: 'Read only.',
  ask: 'Read; every change asks you first.',
} as const;

export function ConnectorCard({ connector, onChanged }: { connector: MomoConnector; onChanged: () => void }) {
  const { id, label, connected, connecting, needsReconnect, level } = connector;
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const paused = connected && level === 'blocked';

  /** Runs one call; a failure stays under the card until the next call (a cancelled sign-in is no failure). */
  const run = async <T extends object>(fn: () => Promise<MomoConnectorsResult<T>>) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      if (!r.ok && r.reason !== 'closed' && r.reason !== 'stale') setNotice(r.error);
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const connect = () => run(() => native.momoConnectors.connect(id));
  const setLevel = (next: 'blocked' | 'ask') => run(() => native.momoConnectors.setLevel(id, next));
  const disconnect = () => {
    setConfirming(false);
    return run(() => native.momoConnectors.disconnect(id));
  };

  const status: ReactNode = connecting ? (
    <>
      <Spinner size={12} /> Finish signing in in your browser…
    </>
  ) : paused ? (
    "Paused. MoMo won't use it."
  ) : connected ? (
    connector.account ? (
      `MoMo can use ${connector.account}.`
    ) : (
      `MoMo can use your ${label}.`
    )
  ) : needsReconnect ? (
    `${label} signed MoMo out. Sign in again to keep using it.`
  ) : (
    `Let MoMo use your ${label}.`
  );
  const chip: ReactNode = paused ? (
    <span className="hp-badge">Paused</span>
  ) : connected ? (
    <span className="hp-badge ok">
      <Check size={10} strokeWidth={2.6} aria-hidden /> Connected
    </span>
  ) : needsReconnect ? (
    <span className="hp-badge warn">Sign in again</span>
  ) : null;
  const primary: ReactNode = connecting ? (
    <button className="btn-pill ghost" onClick={() => void run(() => native.momoConnectors.cancel(id))}>
      Cancel
    </button>
  ) : paused ? (
    <button className="btn-pill" disabled={busy} onClick={() => void setLevel('ask')}>
      Resume
    </button>
  ) : connected ? null : (
    <button className="btn-pill" disabled={busy} onClick={() => void connect()}>
      {needsReconnect ? 'Sign in again' : 'Connect'}
    </button>
  );

  return (
    <section
      className={styles.card}
      aria-label={label}
      data-state={connecting ? 'connecting' : paused ? 'paused' : connected ? 'on' : needsReconnect ? 'reconnect' : 'off'}
    >
      <div className={styles.head}>
        <span className={styles.icon}>
          <Cloud size={18} strokeWidth={1.6} aria-hidden />
        </span>
        <div className={styles.text}>
          <div className={styles.titleLine}>
            <span className={styles.title}>{label}</span>
            {chip}
          </div>
          <div className={styles.status} data-status>
            {status}
          </div>
        </div>
        {primary && <div className={styles.actions}>{primary}</div>}
      </div>
      {notice && (
        <div className={`config-warning ${styles.alert}`} role="alert">
          {notice}
        </div>
      )}
      <details className={styles.details}>
        <summary>
          Details <ChevronDown className={styles.chevron} size={13} aria-hidden />
        </summary>
        <dl className={styles.facts}>
          <dt>Can do</dt>
          <dd>{connector.tools.map((t) => t.description).join(' ')}</dd>
          {connected && (
            <>
              <dt>Access</dt>
              <dd>{ACCESS[level]}</dd>
            </>
          )}
          <dt>Keeps</dt>
          <dd>Its sign-in, encrypted on this Mac. It is deleted when you disconnect.</dd>
        </dl>
        {connected && (
          <div className={styles.manage}>
            {confirming ? (
              <>
                <span className={styles.confirm}>Sign MoMo out of {label}?</span>
                <button className="btn-pill" disabled={busy} onClick={() => void disconnect()}>
                  Disconnect
                </button>
                <button className="btn-pill ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {!paused && (
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
