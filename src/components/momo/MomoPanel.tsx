// MoMo's right panel (#2139, the approved Dot-style page designs/momo-page-dot): its dot, name and what it is doing with Pause or Resume, "MoMo's computer" (this Mac), Devices (this Mac and the user's Host machines, each with its status), Recent activity (its routine runs and errands, each opening the chat it ran in), Outputs and the way to Memory and Settings. Outputs (the text files MoMo saved, MomoOutputs.tsx). Every row is real data with its own empty and failed state.
import { useState } from 'react';
import { saveMomoPref, useMomoPrefs } from '../../session/momoPrefs';
import { useChatRowState } from '../../session/useChatRowState';
import { useHostMachines, type HostMachineRow } from '../../lib/hostMachines';
import { relativeTime } from '../../lib/format';
import { useFlag } from '../../lib/flags';
import { navigate } from '../../store/panes';
import { MomoDot } from './MomoSidebarRow';
import { MomoOutputs } from './MomoOutputs';
import { useMomoActivity } from './useMomoActivity';
import { momoLine } from './momoStatus';
import styles from './momoPanel.module.css';

const DEVICES_SHOWN = 3;
const ACTIVITY_SHOWN = 6;
const STATE_TEXT = { running: 'Running', 'needs-you': 'Needs you', done: 'Done', failed: 'Failed' } as const;
const DOT = { online: 'on', offline: 'off', attention: 'warn' } as const;

function Device({ name, tone, note }: { name: string; tone: 'on' | 'off' | 'warn'; note?: string }) {
  return (
    <li className={styles.device}>
      <span className={styles.dot} data-tone={tone} aria-hidden />
      <span className={styles.deviceName}>{name}</span>
      {note ? <span className={styles.meta}>{note}</span> : null}
    </li>
  );
}

function Devices({ machines }: { machines: HostMachineRow[] }) {
  const [all, setAll] = useState(false);
  const rows = machines.slice(0, all ? undefined : DEVICES_SHOWN - 1);
  return (
    <>
      <ul className={styles.list}>
        <Device name="This Mac" tone="on" />
        {rows.map((m) => (
          <Device
            key={m.id}
            name={m.name}
            tone={DOT[m.status]}
            note={m.status === 'online' ? undefined : m.status === 'offline' ? 'Offline' : 'Needs attention'}
          />
        ))}
      </ul>
      {machines.length > DEVICES_SHOWN - 1 ? (
        <button type="button" className={styles.more} aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}

function Activity() {
  const a = useMomoActivity();
  if (a.status === 'loading') return <p className={styles.meta}>Loading…</p>;
  if (a.status === 'error') return <p className={styles.meta}>Couldn’t load activity.</p>;
  if (!a.items.length) return <p className={styles.meta}>No recent activity</p>;
  return (
    <ul className={styles.list}>
      {a.items.slice(0, ACTIVITY_SHOWN).map((i) => (
        <li key={i.id}>
          <button type="button" className={styles.item} onClick={() => navigate({ name: 'momo', tab: 'chat', chatId: i.chatId })}>
            <span className={styles.itemTitle}>{i.title}</span>
            <span className={styles.meta}>
              {STATE_TEXT[i.state]} · {relativeTime(i.startedAt / 1000)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function MomoPanel({ chatId }: { chatId: string | null }) {
  const { persona, paused } = useMomoPrefs();
  const [busy, setBusy] = useState(false);
  const row = useChatRowState(chatId ?? '')?.state ?? 'idle';
  const line = momoLine(row, paused);
  const machines = useHostMachines().machines;
  // behind the momo.outputs flag: off, the panel has no Outputs and main answers none of its calls
  const outputs = useFlag('momo.outputs');
  return (
    <aside className={styles.panel} role="region" aria-label="MoMo details">
      <div className={styles.who}>
        <span className={styles.avatar}>
          <MomoDot size={30} />
        </span>
        <span className={styles.name}>{persona.name}</span>
        <span className={styles.status} data-tone={line.tone}>
          {line.text}
        </span>
      </div>
      <button
        type="button"
        className={styles.pause}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          // never rejects (the user is told when it wasn't saved)
          void saveMomoPref('paused', !paused).then(() => setBusy(false));
        }}
      >
        {paused ? 'Resume' : 'Pause'}
      </button>
      <section className={styles.card} aria-label="MoMo's computer">
        <span className={styles.cardTitle}>{persona.name}’s computer</span>
        <span className={styles.meta}>
          This Mac · {paused ? 'Paused' : row === 'working' || row === 'elsewhereRunning' ? 'Working' : 'Ready'}
        </span>
      </section>
      <h3 className={styles.h}>Devices</h3>
      <Devices machines={machines} />
      <h3 className={styles.h}>Recent activity</h3>
      <Activity />
      {outputs ? (
        <>
          <h3 className={styles.h}>Outputs</h3>
          <MomoOutputs />
        </>
      ) : null}
      <nav className={styles.links} aria-label="MoMo">
        <button type="button" onClick={() => navigate({ name: 'momo', tab: 'memory' })}>
          Memory
        </button>
        <button type="button" onClick={() => navigate({ name: 'settings', section: 'momo' })}>
          Settings
        </button>
      </nav>
    </aside>
  );
}
