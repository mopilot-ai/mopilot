// The coding-side MCP servers in Settings › MoMo › Sources (#2999 C0): one McpServerCard per server coding chats configure, read again whenever one changes. Nothing shows while there are none. Main refuses every call but Remove while MoMo is not allowed (electron/momo/mcp/ipc.cjs).
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { MomoMcpServer } from '../../lib/native/contracts/momoMcp';
import { McpServerCard } from './McpServerCard';
import styles from './sourceCards.module.css';

export function CodingToolsSection() {
  const [servers, setServers] = useState<MomoMcpServer[]>([]);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** the newest load: only its answer is shown */
  const latest = useRef(0);
  const load = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const r = await native.momoMcp.list();
      if (seq !== latest.current) return;
      if (!r.ok) return setError(r.error);
      setError(null);
      setServers(r.servers);
      setAvailable(r.available);
    } catch (e) {
      if (seq === latest.current) setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    return native.momoMcp.onChanged(() => void load());
  }, [load]);
  if (!servers.length && !error && available) return null;
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <div>
          <h2 className="settings-group-title">Coding tools</h2>
          <div className="settings-group-desc">MCP servers your coding chats use. Allow one for MoMo; none is allowed until you do.</div>
        </div>
      </div>
      {error && (
        <div className="config-warning" role="alert">
          Couldn't load coding tools: {error}{' '}
          <button className="btn-link" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {!available && <div className="config-warning">Allowing coding tools needs encryption, which isn't available on this Mac.</div>}
      <div className={styles.cards}>
        {servers.map((s) => (
          <McpServerCard key={s.key} server={s} onChanged={() => void load()} />
        ))}
      </div>
    </section>
  );
}
