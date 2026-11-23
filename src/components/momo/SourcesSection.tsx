// Settings › MoMo › Sources (#2139 P2): what MoMo may read on this Mac, one card per source (SourceCard.tsx: Calendar, Reminders and Files) read again whenever a source changes. Main refuses every call while MoMo is not allowed (electron/momo/sources/ipc.cjs).
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { MomoSource, MomoSourceId } from '../../lib/native/contracts/momoSources';
import { SourceCard } from './SourceCard';
import styles from './sourceCards.module.css';

/** The Sources page: one card per source, read again on every change. */
export function SourcesSection() {
  const [sources, setSources] = useState<MomoSource[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [waiting, setWaiting] = useState<MomoSourceId[]>([]);
  const [items, setItems] = useState<Partial<Record<MomoSourceId, string[]>>>({});
  const [error, setError] = useState<string | null>(null);
  /** the newest load: a change while one runs starts another, and only the newest one's answer is shown */
  const latest = useRef(0);
  const load = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const r = await native.momoSources.list();
      if (seq !== latest.current) return;
      if (!r.ok) return setError(r.error);
      setError(null);
      setSources(r.sources);
      setAvailable(r.available);
      setWaiting(r.waiting ?? []);
      // each connected source's names; one that fails (macOS took access back) shows none, its row still works
      const next: Partial<Record<MomoSourceId, string[]>> = {};
      await Promise.all(
        r.sources
          .filter((s) => s.connected)
          .map(async (s) => {
            // a failed read is a typed failure here: the row then shows no names, its other parts still work
            const d = await native.momoSources.detail(s.id).catch((e: unknown) => ({ ok: false as const, error: errorText(e) }));
            next[s.id] = d.ok ? d.items : [];
          }),
      );
      if (seq === latest.current) setItems(next);
    } catch (e) {
      if (seq === latest.current) setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    return native.momoSources.onChanged(() => void load());
  }, [load]);
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <div>
          <h2 className="settings-group-title">Sources</h2>
          <div className="settings-group-desc">What MoMo may read on this Mac. Turn a source off any time; MoMo only ever reads.</div>
        </div>
      </div>
      {error && (
        <div className="config-warning" role="alert">
          Couldn't load sources: {error}{' '}
          <button className="btn-link" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {!available && <div className="config-warning">MoMo's sources need encryption, which isn't available on this Mac.</div>}
      <div className={styles.cards}>
        {sources?.map((s) => (
          <SourceCard key={s.id} source={s} items={items[s.id] ?? []} waiting={waiting.includes(s.id)} onChanged={() => void load()} />
        ))}
      </div>
    </section>
  );
}
