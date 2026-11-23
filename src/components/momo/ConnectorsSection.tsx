// The cloud accounts in Settings › MoMo › Sources (#2999 C0): one ConnectorCard per connector, read again whenever one changes. Nothing shows while no connector is registered. Main refuses every call while MoMo is not allowed (electron/momo/connectors/ipc.cjs).
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { MomoConnector } from '../../lib/native/contracts/momoConnectors';
import { ConnectorCard } from './ConnectorCard';
import styles from './sourceCards.module.css';

export function ConnectorsSection() {
  const [connectors, setConnectors] = useState<MomoConnector[]>([]);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** the newest load: only its answer is shown */
  const latest = useRef(0);
  const load = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const r = await native.momoConnectors.list();
      if (seq !== latest.current) return;
      if (!r.ok) return setError(r.error);
      setError(null);
      setConnectors(r.connectors);
      setAvailable(r.available);
    } catch (e) {
      if (seq === latest.current) setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    return native.momoConnectors.onChanged(() => void load());
  }, [load]);
  if (!connectors.length && !error && available) return null;
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <div>
          <h2 className="settings-group-title">Accounts</h2>
          <div className="settings-group-desc">Online accounts MoMo may use. A change always asks you first.</div>
        </div>
      </div>
      {error && (
        <div className="config-warning" role="alert">
          Couldn't load accounts: {error}{' '}
          <button className="btn-link" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {!available && <div className="config-warning">MoMo's accounts need encryption, which isn't available on this Mac.</div>}
      <div className={styles.cards}>
        {connectors.map((c) => (
          <ConnectorCard key={c.id} connector={c} onChanged={() => void load()} />
        ))}
      </div>
    </section>
  );
}
