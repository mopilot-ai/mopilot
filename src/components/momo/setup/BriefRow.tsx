// The Morning brief row on setup's second screen (A7, "Stay in the loop"): optional, off until the person turns it on here. Turn on saves prefs.momo.brief, which starts MoMo's brief for this Mac (a note in MoMo's chat when quiet hours end, if there is something to say); Continue and Not now leave it off. It can be turned off again in Settings › MoMo.
import { useState } from 'react';
import { useEarlierBriefing } from '../../../lib/momoEarlierBriefing';
import { saveMomoPref } from '../../../session/momoPrefs';
import { Sparkles } from '../../ui/icons';
import { ConnectRow, Done, ICON } from '../connectRow';

export function BriefRow() {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const earlier = useEarlierBriefing(on);
  const turnOn = async () => {
    setBusy(true);
    // a refused save is told to the user by saveMomoPref, and the button stays
    if (await saveMomoPref('brief', true)) setOn(true);
    setBusy(false);
  };
  return (
    <>
      <ConnectRow icon={<Sparkles {...ICON} />} title="Morning brief" desc="A short note when quiet hours end.">
        {on ? (
          <Done label="On" />
        ) : (
          <button type="button" className="btn-pill momo-connect-btn" disabled={busy} onClick={() => void turnOn()}>
            Turn on
          </button>
        )}
      </ConnectRow>
      {/* setup run again from Settings: the routine the person approved earlier is not removed for them */}
      {earlier && (
        <ConnectRow
          icon={<Sparkles {...ICON} />}
          title="Earlier Morning briefing"
          desc={earlier.error ?? 'Your earlier routine is still on.'}
          tone={earlier.error ? 'error' : undefined}
        >
          <button type="button" className="btn-pill momo-connect-btn" disabled={earlier.busy} onClick={() => void earlier.turnOff()}>
            Turn it off
          </button>
        </ConnectRow>
      )}
    </>
  );
}
