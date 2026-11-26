// Reset pairing approval (R2b of #5576, behind host.codePair): the repair for an approval key this Mac and its Host no longer share. It asks first with what it removes, then runs the service's reset through codePair:resetApproval. Shown on this Mac's code pane where a refusal's fix is the reset.
import { useState } from 'react';
import { native } from '../../../lib/native';
import { userError } from '../../../../shared/userError.mjs';
import { approvalWords } from '../../../../shared/host/approvalWords.mjs';
import { ConsequenceConfirm } from './ConsequenceConfirm';

export const RESET_CONSEQUENCE = 'Removes this Mac’s approval key and every Mac paired by code. They must pair again.';
/** Refusals whose fix is resetting this Mac's pairing approval. */
export const RESET_FIXES: readonly string[] = ['approval_out_of_sync', 'reset_incomplete'];

/** What a refused reset says, keyed for the reset alone (the Host's own `busy` also means a set-up or an Allow is open): each line is the cause and the fix, and the fix is this same button. */
const RESET_WORDS: Readonly<Record<string, string>> = {
  busy: 'A code or a set-up is open on this Mac. Close it, then reset again.',
  reset_incomplete: 'The reset didn’t finish. Reset again to finish it.',
  host_unreachable: 'This Mac’s Host isn’t answering. Wait a moment, then reset again.',
  unsupported: 'This Mac’s Host is too old to reset pairing approval. Update MoPilot, then reset again.',
  failed: 'Resetting pairing approval didn’t work. Reset again.',
};

/** A reset's refusal: its own words, then this Mac's approval helper's, then main's message, then plain words. */
const resetSaid = (e: { code: string; message?: string }) =>
  (Object.hasOwn(RESET_WORDS, e.code) ? RESET_WORDS[e.code] : null) ?? approvalWords(e.code) ?? e.message ?? RESET_WORDS.failed;

/** What a finished reset says: how many paired Macs it removed. */
export const resetDone = (n: number) =>
  n === 0
    ? 'Pairing approval reset. No paired Macs were removed.'
    : `Pairing approval reset. ${n === 1 ? '1 paired Mac was' : `${n} paired Macs were`} removed and must pair again.`;

export function ResetApproval({
  onDone,
  onProblem,
}: {
  onDone: (controllers: number) => void;
  onProblem: (words: string, code: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [running, setRunning] = useState(false);
  const run = async () => {
    setAsking(false);
    setRunning(true);
    const r = await Promise.resolve()
      .then(() => native.codePair.resetApproval())
      // a thrown reset (a page that changed, main away) says main's own message
      .catch((e) => ({ error: { code: 'thrown', message: userError(e) } }));
    setRunning(false);
    if ('error' in r) return onProblem(resetSaid(r.error), r.error.code);
    onDone(r.controllers);
  };
  return (
    <>
      <button type="button" className="btn-pill" disabled={running} onClick={() => setAsking(true)}>
        {running ? 'Resetting…' : 'Reset pairing approval'}
      </button>
      {asking && (
        <ConsequenceConfirm
          title="Reset pairing approval?"
          lines={[RESET_CONSEQUENCE]}
          action="Reset"
          onCancel={() => setAsking(false)}
          onConfirm={() => void run()}
        />
      )}
    </>
  );
}
