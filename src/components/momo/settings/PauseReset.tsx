// Settings › MoMo › Brain › MoMo (#2139): Setup (opens it again on the MoMo page, where it was skipped), Pause MoMo (prefs.momo.paused, which routines and background reads check) and Reset MoMo, confirmed by typing "MoMo": main pauses MoMo, deletes every MoMo store and then its settings (electron/app/ipc/momoReset.cjs), and the user is told how it ended, in a toast and in the Reset row; the form stays for a retry when something failed.
import { useEffect, useRef, useState } from 'react';
import { saveMomoPref, useMomoPrefs } from '../../../session/momoPrefs';
import { native } from '../../../lib/native';
import type { MomoResetResult } from '../../../lib/native/momoReset';
import { errorText } from '../../../lib/ignored';
import { busyField, cancelOnEscape } from '../../../lib/focus';
import { navigate } from '../../../store/panes';
import { toast } from '../../../store/core';
import { Group, Row } from '../../pages/settings/Controls';

const CONFIRM = 'MoMo';

/** What the user is told after a reset, and whether it can be tried again (something failed, or nothing ran). */
export function resetNote(r: MomoResetResult): { text: string; tone: 'info' | 'error'; retry: boolean } {
  const failed = r.notReset.filter((s) => s.reason === 'failed');
  const absent = r.notReset.filter((s) => s.reason === 'absent');
  if (failed.length)
    return { text: `Couldn't delete ${failed.map((s) => s.label).join(', ')}. MoMo stays paused; try again.`, tone: 'error', retry: true };
  if (absent.length)
    return {
      text: `MoMo was reset, except ${absent.map((s) => s.label).join(', ')}: this build can't reach them.`,
      tone: 'info',
      retry: false,
    };
  return { text: 'MoMo was reset', tone: 'info', retry: false };
}

type FormProps = { onDone: () => void; onSaid: (text: string | null) => void; busy: boolean; setBusy: (b: boolean) => void };

function ResetForm({ onDone, onSaid, busy, setBusy }: FormProps) {
  const [typed, setTyped] = useState('');
  const alive = useRef(true);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // the form opens on its confirmation, as a dialog would
    field.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async () => {
    // the page keeps it (Resume waits for it), so a closed form never leaves it on
    setBusy(true);
    onSaid(null);
    let retry = true;
    let said: string;
    try {
      const note = resetNote(await native.momoReset.run());
      toast(note.text, note.tone);
      said = note.text;
      retry = note.retry;
    } catch (e) {
      said = errorText(e);
      toast(said, 'error');
    }
    // the reset finishes, and says so, even when the page went away meanwhile
    setBusy(false);
    if (!alive.current) return;
    // the row keeps saying how it ended after the toast is gone (#2291)
    onSaid(said);
    if (!retry) onDone();
  };
  return (
    <div className="settings-row momo-reset-form">
      <input
        className="text-input slim wide"
        aria-label={`Type ${CONFIRM} to confirm`}
        placeholder={`Type ${CONFIRM} to confirm`}
        ref={field}
        value={typed}
        {...busyField(busy)}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => !busy && cancelOnEscape(e, onDone)}
      />
      <button className="btn-pill" disabled={busy} onClick={onDone}>
        Cancel
      </button>
      <button className="btn-pill danger outline" disabled={busy || typed !== CONFIRM} onClick={() => void run()}>
        {busy ? 'Resetting…' : 'Reset'}
      </button>
    </div>
  );
}

export function PauseResetSettings() {
  const { paused, onboarding } = useMomoPrefs();
  const [resetting, setResetting] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // setup opens on the MoMo page (from the start once it was done); once, however often it is clicked
  const opening = useRef(false);
  const openSetup = async () => {
    if (opening.current) return;
    opening.current = true;
    const saved = await saveMomoPref('onboarding', { done: false, step: onboarding.step });
    opening.current = false;
    if (saved) navigate({ name: 'momo' });
  };
  // while a reset runs MoMo stays paused (main refuses a resume then too)
  const [busy, setBusy] = useState(false);
  return (
    <Group title="MoMo">
      <Row title="Setup" desc="Go through name, color and connections again">
        <button className="btn-pill" onClick={() => void openSetup()}>
          Open setup
        </button>
      </Row>
      <Row title="Pause MoMo" desc={paused ? 'Paused' : 'Routines and background reads wait until you resume.'}>
        <button className="btn-pill" disabled={busy} onClick={() => void saveMomoPref('paused', !paused)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
      </Row>
      <Row
        title="Reset MoMo"
        desc={
          said === null ? (
            'Deletes everything MoMo keeps on this Mac. Your accounts and coding chats stay.'
          ) : (
            <span role="status">{said}</span>
          )
        }
      >
        {!resetting && (
          <button
            className="btn-pill danger outline"
            onClick={() => {
              setSaid(null);
              setResetting(true);
            }}
          >
            Reset…
          </button>
        )}
      </Row>
      {resetting && <ResetForm onDone={() => setResetting(false)} onSaid={setSaid} busy={busy} setBusy={setBusy} />}
    </Group>
  );
}
