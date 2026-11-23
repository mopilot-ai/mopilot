// MoMo's first run as the design draws it (MacSetup, W2.1–W2.3, W3.4): where it lives → what it can read → how it reaches you. The step is the home's: a button asks the home to go on and the next screen is drawn when it says so.
import { useState } from 'react';
import { navigate } from '../../../store/panes';
import type { MomoMachineView, MomoSettingsView, MomoSetupView } from '../../../../shared/momoView';
import { hm12 } from './homeCopy';
import { Refusal } from './Refusal';
import { useMomoAct } from './useMomoHome';
import styles from './home.module.css';

const STEPS = ['Where it lives', 'What it can read', 'How it reaches you'] as const;
const INDEX = { where: 0, read: 1, reach: 2 } as const;

function Where({ machines }: { machines: MomoMachineView[] }) {
  const { act, busy, failed } = useMomoAct();
  const usable = machines.filter((m) => m.status === 'online');
  const [picked, setPicked] = useState(usable.find((m) => m.recommended)?.machineId ?? usable[0]?.machineId ?? '');
  const name = machines.find((m) => m.machineId === picked)?.name ?? '';
  // arrow keys move through the machines that can be picked, as a radio group does
  const move = (from: number, by: number) => {
    const next = usable[(from + by + usable.length) % usable.length];
    if (next) setPicked(next.machineId);
  };
  return (
    <>
      <h1 className={styles.h1}>Where should MoMo live?</h1>
      <p className={styles.text}>Pick the machine that stays on.</p>
      <div className={styles.list} role="radiogroup" aria-label="Where MoMo lives">
        {machines.map((m) => {
          const ok = m.status === 'online';
          const at = usable.findIndex((u) => u.machineId === m.machineId);
          return (
            <button
              key={m.machineId}
              type="button"
              role="radio"
              aria-checked={m.machineId === picked}
              aria-disabled={!ok}
              tabIndex={m.machineId === picked ? 0 : -1}
              className={styles.row}
              data-picked={m.machineId === picked}
              onClick={() => ok && setPicked(m.machineId)}
              onKeyDown={(e) => {
                if (!ok) return;
                if (e.key === 'ArrowDown' || e.key === 'ArrowRight') e.preventDefault(), move(at, 1);
                if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') e.preventDefault(), move(at, -1);
              }}
            >
              <span className={styles.rowMain}>
                <span>{m.name}</span>
                <span className={styles.meta}>
                  {ok ? `Online · ${m.note ?? ''}` : m.status === 'needs-update' ? 'MoPilot there is out of date' : 'Not set up'}
                </span>
              </span>
              {m.recommended && ok ? <span className={styles.chip}>Recommended</span> : null}
            </button>
          );
        })}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || !picked}
          onClick={() => void act({ type: 'setup.choose', machineId: picked })}
        >
          Continue with {name}
        </button>
      </div>
      <Refusal failed={failed} />
      <p className={styles.meta}>Everything MoMo knows stays on that machine, encrypted.</p>
    </>
  );
}

function Read({ setup, homeName }: { setup: MomoSetupView; homeName: string | null }) {
  const { act, busy, failed } = useMomoAct();
  const home = homeName ?? 'your machine';
  const g = setup.google;
  if (g === 'waiting')
    return (
      <>
        <h1 className={styles.h1}>Finish in your browser</h1>
        <p className={styles.text}>Google asks you to allow read-only access for MoMo.</p>
        <p className={styles.meta} role="status">
          Waiting for Google…
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'setup.google', to: 'idle' })}>
            Cancel
          </button>
        </div>
        <Refusal failed={failed} />
      </>
    );
  if (g === 'connected')
    return (
      <>
        <h1 className={styles.h1}>Connected</h1>
        <p className={styles.text}>Gmail and Calendar · read only</p>
        <p className={styles.meta}>First look: the last 30 days of mail</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void act({ type: 'setup.next' })}>
            Done
          </button>
          <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'setup.google', to: 'idle' })}>
            Disconnect
          </button>
        </div>
        <Refusal failed={failed} />
      </>
    );
  return (
    <>
      <h1 className={styles.h1}>Connect Gmail and Calendar</h1>
      <p className={styles.text}>MoMo reads your mail and calendar so it can tell what matters.</p>
      <dl className={styles.card}>
        <dt className={styles.meta}>Reads</dt>
        <dd style={{ margin: 0 }}>Mail and calendar events</dd>
        <dt className={styles.meta}>Never</dt>
        <dd style={{ margin: 0 }}>Sends, deletes or changes anything in Google</dd>
        <dt className={styles.meta}>Where</dt>
        <dd style={{ margin: 0 }}>The sign-in stays on {home}. Not on your phone.</dd>
      </dl>
      {g === 'failed' ? (
        <p className={styles.error} role="alert">
          Google didn’t connect. Try again.
        </p>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void act({ type: 'setup.google', to: 'waiting' })}>
          Continue in browser
        </button>
        <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'setup.next' })}>
          Not now
        </button>
      </div>
      <Refusal failed={failed} />
      <p className={styles.meta}>You can disconnect any time.</p>
    </>
  );
}

function Reach({ setup, settings }: { setup: MomoSetupView; settings: MomoSettingsView }) {
  const { act, busy, failed } = useMomoAct();
  if (setup.notifications === 'denied')
    return (
      <>
        <h1 className={styles.h1}>Let MoMo reach you</h1>
        <p className={styles.text} role="status">
          Notifications are off. MoMo keeps things in Chat.
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.btn} onClick={() => navigate({ name: 'settings', section: 'momo' })}>
            Open Settings
          </button>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void act({ type: 'setup.next' })}>
            Continue
          </button>
        </div>
        <Refusal failed={failed} />
      </>
    );
  return (
    <>
      <h1 className={styles.h1}>Let MoMo reach you</h1>
      <p className={styles.text}>
        MoMo notifies you when something can’t wait, like a client reply or a due invoice. At most {settings.dailyCap} a day. Quiet from{' '}
        {hm12(settings.quietHours.from)} to {hm12(settings.quietHours.to)}.
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy}
          onClick={() => void act({ type: 'setup.notifications', to: 'allowed' })}
        >
          Allow notifications
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={busy}
          onClick={() => void act({ type: 'setup.notifications', to: 'denied' })}
        >
          Not now
        </button>
      </div>
      <Refusal failed={failed} />
    </>
  );
}

export function SetupFlow({
  setup,
  machines,
  homeName,
  settings,
}: {
  setup: MomoSetupView;
  machines: MomoMachineView[];
  homeName: string | null;
  settings: MomoSettingsView;
}) {
  const at = INDEX[setup.step as keyof typeof INDEX];
  return (
    <div className={styles.body}>
      <div className={styles.column}>
        <ol className={styles.steps} aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s} data-state={i < at ? 'done' : i === at ? 'now' : 'next'} aria-current={i === at ? 'step' : undefined}>
              {i + 1} {s}
            </li>
          ))}
        </ol>
        {setup.step === 'where' ? (
          <Where machines={machines} />
        ) : setup.step === 'read' ? (
          <Read setup={setup} homeName={homeName} />
        ) : (
          <Reach setup={setup} settings={settings} />
        )}
      </div>
    </div>
  );
}
