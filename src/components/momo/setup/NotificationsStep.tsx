// Setup's second screen (#2607): "Stay in the loop", one card with Notifications and the Morning brief (A7), each optional. Turn on switches MoMo's own notices on (prefs.momo.notify) and shows one through the app's Notifier, which is how macOS asks for permission. Continue and Not now both go on. Calendar and Reminders are not asked for here: MoMo asks in its chat when it needs one, and they connect from Settings › MoMo › Sources too.
import { useState } from 'react';
import { errorText } from '../../../lib/ignored';
import { saveMomoPref } from '../../../session/momoPrefs';
import { native } from '../../../lib/native';
import { Bell } from '../../ui/icons';
import { ConnectRow, Done, ICON } from '../connectRow';
import { BriefRow } from './BriefRow';
import { Orb } from './Orb';

/** Notifications: MoMo's own switch turned on, and one notice so macOS asks for permission the way it does for every other. */
function NotificationsRow({ on, onTurnedOn }: { on: boolean; onTurnedOn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const turnOn = async () => {
    setBusy(true);
    setProblem(null);
    try {
      if (!(await saveMomoPref('notify.needsAnswer', true))) return;
      await native.momoChat.enableNotices();
      onTurnedOn();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConnectRow
      icon={<Bell {...ICON} />}
      title="Notifications"
      desc={problem ?? 'Hear from MoMo when it needs you.'}
      tone={problem ? 'error' : undefined}
    >
      {on ? (
        <Done label="On" />
      ) : (
        <button type="button" className="btn-pill momo-connect-btn" disabled={busy} onClick={() => void turnOn()}>
          Turn on
        </button>
      )}
    </ConnectRow>
  );
}

export function NotificationsStep({ busy, onDone }: { busy: boolean; onDone: () => void }) {
  const [notify, setNotify] = useState(false);
  return (
    <section className="momo-setup-main momo-connect" aria-labelledby="momo-notify-title">
      <div className="momo-connect-head">
        <Orb size={44} />
        <h1 className="momo-setup-title" id="momo-notify-title">
          Stay in the loop
        </h1>
        <p className="momo-setup-lead">Optional. You can change this anytime in Settings › MoMo.</p>
      </div>
      <div className="momo-connect-card">
        <NotificationsRow on={notify} onTurnedOn={() => setNotify(true)} />
        <BriefRow />
      </div>
      <p className="momo-setup-note">MoMo asks before it reads your Calendar or Reminders.</p>
      <div className="momo-setup-foot">
        <button type="button" className="btn primary lg" disabled={busy} onClick={() => onDone()}>
          Continue
        </button>
        <button type="button" className="btn-link" disabled={busy} onClick={() => onDone()}>
          Not now
        </button>
      </div>
    </section>
  );
}
