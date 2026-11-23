// Everything (A2): the latest finished exchanges of MoMo's main chat and of every open channel, newest first, each with the name of the channel it was said in, and a filter by channel. A row opens its channel (Main: MoMo's main chat). Read from main again when a channel changes and every few seconds the page is open; a failed read says so with Try again and keeps the rows it had.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import { errorText } from '../../../lib/ignored';
import { visiblePoll } from '../../../lib/visiblePoll';
import type { MomoEverything } from '../../../lib/native/contracts/momoChannels';
import { CHANNEL_COPY as C } from './channelCopy';
import styles from './channels.module.css';

/** How often the feed is read again while it is open. */
export const FEED_REFRESH_MS = 8000;

const clock = (at: number) =>
  new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function EverythingFeed({ open }: { open: (row: MomoEverything['rows'][number]) => void }) {
  const [filter, setFilter] = useState('');
  const [data, setData] = useState<MomoEverything | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const read = useCallback(() => {
    // the newest read wins
    const seq = ++latest.current;
    native.momoChannels.everything(filter || undefined).then(
      (r) => {
        if (seq !== latest.current) return;
        if (r.ok) setData(r), setError(null);
        else setError(r.error);
      },
      (e: unknown) => seq === latest.current && setError(errorText(e)),
    );
  }, [filter]);
  useEffect(() => {
    read();
    const off = native.momoChannels.onChanged(read);
    // one shared poll that rests while the window is hidden, and reads once when it shows again
    const stopPoll = visiblePoll('momo-everything', FEED_REFRESH_MS, read);
    return () => {
      latest.current = -1;
      off();
      stopPoll();
    };
  }, [read]);
  return (
    <section className={styles.feed} aria-label={C.everything}>
      <div className={styles.feedBar}>
        <label htmlFor="momo-feed-filter">{C.filter}</label>
        <select id="momo-feed-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">{C.allChannels}</option>
          {(data?.filters ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.id === 'main' ? f.name : `#${f.name}`}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p className={styles.note} role="alert">
          {C.cantRead}{' '}
          <button type="button" className={styles.chip} onClick={read}>
            {C.tryAgain}
          </button>
        </p>
      ) : null}
      {data && !data.rows.length && !error ? <p className={styles.note}>{C.nothingYet}</p> : null}
      <ul className={styles.feedList}>
        {(data?.rows ?? []).map((r) => (
          <li key={`${r.chatId}:${r.turnId}`}>
            <button type="button" className={styles.feedRow} data-channel={r.channelId ?? 'main'} onClick={() => open(r)}>
              <span className={styles.feedMeta}>
                <span className={styles.feedName}>{r.channelId ? `#${r.name}` : r.name}</span>
                <span>{clock(r.at)}</span>
              </span>
              {r.user ? <p className={styles.feedUser}>{r.user}</p> : null}
              {r.assistant ? <p className={styles.feedAssistant}>{r.assistant}</p> : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
