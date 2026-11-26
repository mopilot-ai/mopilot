// Add › Computer on Control this Mac (R2b of #5576, behind host.codePair): this Mac's own code for the other Mac to type, how long it lasts, what the run is doing, and the Allow sheet when the other Mac asks; a Mac that cannot ask for approval yet offers its one-time setup.
import { useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import { visiblePoll } from '../../../lib/visiblePoll';
import { userError } from '../../../../shared/userError.mjs';
import { ignoring } from '../../../lib/ignored';
import { refusalWords } from '../../../../shared/host/refusalWords.mjs';
import { approvalWords } from '../../../../shared/host/approvalWords.mjs';
import type { CodePairEvent } from '../../../lib/native/codePair';
import { AllowSheet } from './AllowSheet';
import { RESET_FIXES, ResetApproval, resetDone } from './ResetApproval';
import { toast } from '../../../store/core';

/** What each step of a run says while it is open, and how a closed one ended. */
const PHASE_LINE: Record<string, string> = {
  waiting: 'Enter this code on the other Mac, in Settings › Connections › Control other devices › Add.',
  connecting: 'The other Mac is connecting…',
  proving: 'Checking the code…',
  done: 'Added. It can control this Mac now.',
  denied: 'Not allowed. Make a new code to try again.',
  used_up: 'That code was used up. Make a new code.',
  expired: 'The code expired. Make a new one.',
  cancelled: 'Cancelled.',
};

/** A refusal in its words for this Mac, or the main process's own message. @param {{ code: string, message?: string }} e */
const said = (e: { code: string; message?: string }) =>
  approvalWords(e.code) ?? refusalWords(e.code, { machine: 'This Mac' } as never)?.line ?? 'That didn’t work. Make a new code.';

type Offer = { offerId: string; code: string; expiresAt: number };

export function ComputerCodePane() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [event, setEvent] = useState<CodePairEvent | null>(null);
  const [problem, setProblemText] = useState('');
  // whether the refusal on show is fixed by resetting this Mac's pairing approval
  const [resettable, setResettable] = useState(false);
  const setProblem = (words: string, code = '') => {
    setProblemText(words);
    setResettable(RESET_FIXES.includes(code));
  };
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [weak, setWeak] = useState(false);
  // the sheet a person closed (Don't allow, Escape, its time ran out) stays closed for that offer
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [confirmedAt, setConfirmedAt] = useState(0);
  const make = async () => {
    setProblem('');
    setEvent(null);
    // the old code is not valid any more, whatever the new one does
    setOffer(null);
    try {
      const status = await native.codePair.status();
      setWeak(status.approval.weak === true);
      if (!status.approval.available && status.approval.reason === 'no_approval_helper') return setSetupNeeded(true);
      if (!status.approval.available)
        return setProblem(said({ code: status.approval.reason ?? 'unsupported_platform' }), status.approval.reason);
      const r = await native.codePair.offer();
      if ('error' in r) return setProblem(said(r.error), r.error.code);
      setOffer(r);
    } catch (e) {
      setProblem(userError(e));
    }
  };
  // the first code is made once, when the pane opens (a New code makes the next ones)
  const first = useRef(make);
  useEffect(() => {
    void first.current();
    // the countdown moves each second while the window shows
    return visiblePoll('code-pair-countdown', 1000, () => setNow(Date.now()));
  }, []);
  useEffect(
    () =>
      native.codePair.onEvent((e) => {
        if (!offer || e.offerId !== offer.offerId) return;
        if (e.phase === 'confirm') setConfirmedAt(Date.now());
        setEvent(e);
      }),
    [offer],
  );
  // closing the pane closes an offer that is still open
  useEffect(
    () => () =>
      void (
        offer &&
        Promise.resolve()
          .then(() => native.codePair.cancel({ offerId: offer.offerId }))
          .catch(ignoring('close this Mac’s code'))
      ),
    [offer],
  );
  const setup = async () => {
    const r = await Promise.resolve()
      .then(() => native.codePair.setup())
      .catch((e) => ({ error: { code: 'failed', message: userError(e) } }));
    if ('error' in r) return setProblem(said(r.error), r.error.code);
    setSetupNeeded(false);
    void make();
  };
  const phase = event?.phase ?? 'waiting';
  const left = offer ? Math.max(0, Math.round((offer.expiresAt - now) / 1000)) : 0;
  const over =
    phase === 'failed' ||
    (Object.hasOwn(PHASE_LINE, phase) && !['waiting', 'connecting', 'proving'].includes(phase)) ||
    (offer && left === 0);
  return (
    <div className="machine-sheet code-sheet">
      {setupNeeded ? (
        <>
          <p className="machine-sheet-lede">
            Once, this Mac sets up how you allow another Mac to control it, with Touch ID or your password.
          </p>
          <div className="machine-sheet-actions">
            <button type="button" className="btn-pill primary" onClick={() => void setup()}>
              Set up
            </button>
          </div>
        </>
      ) : offer ? (
        <>
          <div className="code-shown" role="group" aria-label="This Mac's code">
            {offer.code}
          </div>
          <p className="machine-sheet-lede">
            {phase === 'failed' ? said({ code: event?.code ?? 'failed' }) : Object.hasOwn(PHASE_LINE, phase) ? PHASE_LINE[phase] : ''}
            {!over && left > 0 && ` Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`}
          </p>
          {over && phase !== 'done' && (
            <div className="machine-sheet-actions">
              <button type="button" className="btn-pill primary" onClick={() => void make()}>
                New code
              </button>
            </div>
          )}
        </>
      ) : (
        !problem && <p className="machine-sheet-lede">Making a code…</p>
      )}
      {problem && (
        <p className="machine-sheet-error" role="alert">
          {problem}
        </p>
      )}
      {problem && resettable && (
        <div className="machine-sheet-actions">
          {/* the key is gone after a reset: making a code reads the status again, which offers the one-time setup */}
          {/* a refused reset keeps this button: it is still the fix, and the line says what to do first */}
          <ResetApproval
            onDone={(n) => {
              toast(resetDone(n));
              void make();
            }}
            onProblem={setProblemText}
          />
        </div>
      )}
      {offer && event?.phase === 'confirm' && event.name && event.safety && dismissed !== offer.offerId && (
        <AllowSheet
          offerId={offer.offerId}
          name={event.name}
          safety={event.safety}
          expiresAt={confirmedAt + (event.expiresInMs ?? 0)}
          weak={weak}
          onClose={() => setDismissed(offer.offerId)}
        />
      )}
    </div>
  );
}
