// The Allow sheet on this Mac (R2b of #5576, behind host.codePair): another device typed this Mac's code and asks to control it. The person sees the name the other device gave itself, compares the safety number, reads what allowing grants (GRANT_TEXT) and how long they have, and allows it through the system's own Touch ID or password prompt, or does not. Its Escape is its own: it never closes the dialog under it.
import { useEffect, useId, useState } from 'react';
import { native } from '../../../lib/native';
import { imeComposing } from '../../../lib/focus';
import { visiblePoll } from '../../../lib/visiblePoll';
import { ignoring } from '../../../lib/ignored';
import { userError } from '../../../../shared/userError.mjs';
import { refusalWords } from '../../../../shared/host/refusalWords.mjs';
import { approvalWords } from '../../../../shared/host/approvalWords.mjs';

/** What allowing grants (owner's decision A on #5617: no extra sandbox), said once: change it here and only here. The name is the other device's own claim. */
/** The name as the sheet quotes it: a quote mark inside it would end the quotation early, so each one becomes an apostrophe. */
export const shownName = (name: string) =>
  name.replace(/["\u201C\u201D\u201E\u201F\u00AB\u00BB\u2039\u203A\u275D\u275E\u301D\u301E\uFF02]/g, "'");

export const GRANT_TEXT = (name: string) =>
  `The device named “${shownName(name)}” will fully control this Mac as you: run commands, read and change files, see every chat. Removing it later may not undo what it already did.`;

/** The line under the grant on a Mac whose approval key is in software, not the Secure Enclave: in practice an older Intel Mac without a T2 chip (an Apple silicon Mac, a VM on one included, has the Secure Enclave). */
export const WEAK_KEY_TEXT = 'This Mac has no Secure Enclave, so approval uses a software key.';

export function AllowSheet({
  offerId,
  name,
  safety,
  expiresAt,
  weak = false,
  onClose,
}: {
  offerId: string;
  name: string;
  safety: string;
  /** when the request stops waiting (ms) */
  expiresAt: number;
  weak?: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const label = useId();
  /** Tab stays inside the sheet: from the last control to the first and back. @param {React.KeyboardEvent} e */
  const trap = (e: React.KeyboardEvent<HTMLElement>) => {
    const controls = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  useEffect(() => visiblePoll('code-pair-allow', 1000, () => setNow(Date.now())), []);
  // a request that stopped waiting cannot be allowed: the sheet goes with it
  useEffect(() => {
    if (left === 0) onClose();
  }, [left, onClose]);
  const allow = async () => {
    setBusy('allow');
    setError('');
    try {
      const r = await native.codePair.allow({ offerId });
      if ('accepted' in r) return onClose();
      setError(
        approvalWords(r.error.code) ??
          refusalWords(r.error.code, { machine: 'This Mac' } as never)?.line ??
          'Allowing didn’t work. Try again.',
      );
    } catch (e) {
      setError(userError(e));
    } finally {
      setBusy(null);
    }
  };
  const deny = async () => {
    setBusy('deny');
    await Promise.resolve()
      .then(() => native.codePair.deny({ offerId }))
      .catch(ignoring('say Don’t allow to the other device'));
    onClose();
  };
  return (
    <div
      className="sketch-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Tab') return trap(e);
        if (e.key !== 'Escape' || imeComposing(e)) return;
        // this sheet's Escape only: the dialog under it stays; and never a Don't allow while the system prompt is up for Allow
        e.stopPropagation();
        if (busy === null) void deny();
      }}
    >
      <div className="dialog acct-dialog code-sheet" role="alertdialog" aria-modal="true" aria-labelledby={label}>
        <div className="dialog-head">
          <span id={label}>Allow the device named “{shownName(name)}” to control this Mac?</span>
        </div>
        <div className="acct-dialog-hint">
          <p>Named by the other device. Check that it shows the same number:</p>
          <div role="group" aria-label="Safety number" className="code-safety">
            {safety}
          </div>
          <p className="code-grant">{GRANT_TEXT(name)}</p>
          {weak && <p>{WEAK_KEY_TEXT}</p>}
          <p>
            Waits {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more.
          </p>
          {error && (
            <p className="machine-sheet-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="acct-dialog-actions">
          <button type="button" className="btn sm" autoFocus disabled={busy !== null} onClick={() => void deny()}>
            Don’t allow
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn danger sm" disabled={busy !== null} onClick={() => void allow()}>
            {busy === 'allow' ? 'Allowing…' : 'Allow'}
          </button>
        </div>
      </div>
    </div>
  );
}
