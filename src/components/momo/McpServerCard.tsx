// One coding-side MCP server's card in Settings › MoMo › Sources (#2999 C0), in the sources' card look: icon, name, where it is configured, a status chip (Allowed, Starting, Didn't start), one plain line and ONE primary action (Allow, or Retry when it didn't start). Once allowed, its tools are listed, each with the server's own claim ("says it only reads") and a switch (none for a tool MoMo never offers, with why): tools that only read are on by default, anything else is off and asks each time when on, and a tool that is new since is marked New and starts off. Remove sits behind Details.
import { useState, type ReactNode } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { MomoMcpResult, MomoMcpServer } from '../../lib/native/contracts/momoMcp';
import { Check, ChevronDown, Plug, Spinner } from '../ui/icons';
import styles from './sourceCards.module.css';

export function McpServerCard({ server, onChanged }: { server: MomoMcpServer; onChanged: () => void }) {
  const { key, name, from, allowed, status } = server;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /** Runs one call; a failure stays under the card until the next call. */
  const run = async (fn: () => Promise<MomoMcpResult>) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      if (!r.ok) setNotice(r.error);
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const allow = () => run(() => native.momoMcp.allow(key));

  const on = server.tools.filter((t) => t.on).length;
  const line: ReactNode = !allowed ? (
    'Let MoMo use its tools. Only tools that say they only read start on.'
  ) : status === 'starting' ? (
    <>
      <Spinner size={12} /> Starting…
    </>
  ) : status === 'failed' ? (
    `It didn't start: ${server.error ?? 'no reason given'}`
  ) : status === 'ready' ? (
    `MoMo can use ${on} of its ${server.tools.length} tools.`
  ) : (
    'Allowed. It starts when MoMo needs it.'
  );
  const chip: ReactNode =
    allowed && status === 'failed' ? (
      <span className="hp-badge warn">Didn't start</span>
    ) : allowed ? (
      <span className="hp-badge ok">
        <Check size={10} strokeWidth={2.6} aria-hidden /> Allowed
      </span>
    ) : null;
  const primary: ReactNode = !allowed ? (
    <button className="btn-pill" disabled={busy} onClick={() => void allow()}>
      Allow
    </button>
  ) : status === 'failed' ? (
    <button className="btn-pill" disabled={busy} onClick={() => void allow()}>
      Retry
    </button>
  ) : null;

  return (
    <section className={styles.card} aria-label={name} data-state={allowed ? status : 'off'}>
      <div className={styles.head}>
        <span className={styles.icon}>
          <Plug size={18} strokeWidth={1.6} aria-hidden />
        </span>
        <div className={styles.text}>
          <div className={styles.titleLine}>
            <span className={styles.title}>{name}</span>
            {chip}
          </div>
          <div className={styles.status} data-status>
            {line}
          </div>
        </div>
        {primary && <div className={styles.actions}>{primary}</div>}
      </div>
      {allowed && server.tools.length > 0 && (
        <ul className={styles.folders} aria-label={`${name} tools`}>
          {server.tools.map((t) => (
            <li key={t.key} className={styles.folder}>
              <label className={styles.folderPath}>
                <input
                  type="checkbox"
                  checked={t.on}
                  disabled={busy || t.blocked !== null}
                  onChange={(e) => void run(() => native.momoMcp.setTool(key, t.key, e.target.checked))}
                />{' '}
                {t.name}
                {t.isNew && <span className="hp-badge warn">New</span>}{' '}
                <span className={styles.confirm}>
                  {t.blocked ? `not offered: ${t.blocked}` : t.readOnly ? 'says it only reads' : 'asks each time'}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
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
          <dt>Configured in</dt>
          <dd>{from}</dd>
          <dt>Runs</dt>
          <dd>
            {server.transport === 'stdio' ? 'On this Mac, apart from your coding chats.' : 'On the web, at the address its settings give.'}
          </dd>
          <dt>Trust</dt>
          <dd>Its claims are its own word. Every change asks you first.</dd>
        </dl>
        {allowed && (
          <div className={styles.manage}>
            <button className="btn-pill ghost" disabled={busy} onClick={() => void run(() => native.momoMcp.remove(key))}>
              Remove from MoMo
            </button>
          </div>
        )}
      </details>
    </section>
  );
}
