// Add a device by its code (R2b of #5576, behind host.codePair): the other Mac shows an 8-character code, the person types it here in eight boxes (4 and 4) and it is sent on the eighth; the dialog says how the pairing ends in the main process's own words (electron/host/codePairClient.cjs), with its one fix in place, and on success the safety number both Macs show.
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../ui/Modal';
import { native } from '../../../lib/native';
import { openAddMachine } from '../../../lib/addMachine';
import { userError } from '../../../../shared/userError.mjs';
import { ignoring } from '../../../lib/ignored';
import type { AddByCodeResult } from '../../../lib/hostCodePairTypes';
import { toast } from '../../../store/core';

/** The characters a code is made of (shared/host/codePair.mjs ALPHABET: no I, L, O, 0 or 1); kept here so the renderer does not load the pairing protocol. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 8;

/** What a typed or pasted text gives, as the code's characters in order: upper case, only the code's letters, at most eight. */
export const codeChars = (text: string) => [...text.toUpperCase()].filter((c) => CODE_ALPHABET.includes(c)).slice(0, LENGTH);

type Phase = { kind: 'enter' } | { kind: 'pairing'; code: string } | { kind: 'ended'; code: string; result: AddByCodeResult };

/** The line under the boxes when a typed character is not one a code uses. */
export const NOT_IN_CODES = 'Codes don’t use O, I, L, 0 or 1.';
const EMPTY = Array.from({ length: LENGTH }, () => '');

export function AddByCodeDialog({ onClose }: { onClose: () => void }) {
  const [chars, setChars] = useState<string[]>(EMPTY);
  const [phase, setPhase] = useState<Phase>({ kind: 'enter' });
  const [hint, setHint] = useState('');
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  // what the effect cleanup and a late answer read: whether this dialog is still open, and whether a run is under way
  const open = useRef(true);
  const pairing = useRef(false);
  useEffect(
    () => () => {
      open.current = false;
      // closed by anything while it pairs (another tab, navigation, Host access going): the run in main stops too
      if (pairing.current)
        void Promise.resolve()
          .then(() => native.host.cancelAddByCode())
          .catch(ignoring('stop a pairing by code'));
    },
    [],
  );
  const focus = (i: number) => boxes.current[Math.max(0, Math.min(i, LENGTH - 1))]?.focus();
  const send = async (code: string) => {
    pairing.current = true;
    setPhase({ kind: 'pairing', code });
    let result: AddByCodeResult;
    try {
      result = await native.host.addByCode(code);
    } catch (e) {
      result = { ok: false, code: 'failed', cause: userError(e), fix: { id: 'retry', label: 'Try again' } };
    }
    pairing.current = false;
    // a pairing that ended after the dialog closed still names the number to compare: it is the one check the person must make
    if (result.ok) toast(open.current ? `Added ${result.name}` : `Added ${result.name}. Check that it shows ${result.safety}.`);
    if (open.current) setPhase({ kind: 'ended', code, result });
  };
  /** The boxes with `typed` from `at` on; a full code sends itself. */
  const fill = (next: string[]) => {
    setChars(next);
    if (next.every(Boolean)) void send(next.join(''));
  };
  const type = (i: number, raw: string) => {
    // the last thing typed in this box is its character; a pasted text comes through onPaste
    const last = raw.slice(-1);
    if (!last) return fill(chars.map((c, j) => (j === i ? '' : c)));
    const [c] = codeChars(last);
    if (!c) return setHint(NOT_IN_CODES);
    setHint('');
    fill(chars.map((x, j) => (j === i ? c : x)));
    focus(i + 1);
  };
  const paste = (i: number, text: string) => {
    const typed = codeChars(text);
    if (!typed.length) return setHint(NOT_IN_CODES);
    setHint('');
    // a whole code fills every box whatever box has the focus; a part fills on from this box
    const from = typed.length === LENGTH ? 0 : i;
    const next = chars.map((c, j) => (j >= from && j - from < typed.length ? typed[j - from] : c));
    fill(next);
    focus(from + typed.length);
  };
  const again = () => {
    setChars(EMPTY);
    setHint('');
    setPhase({ kind: 'enter' });
    setTimeout(() => focus(0));
  };
  const cancel = () => onClose();
  const ended = phase.kind === 'ended' ? phase.result : null;
  return (
    <Modal title="Add a device" onClose={cancel}>
      <div className="machine-sheet code-sheet">
        {ended?.ok ? (
          <>
            <p className="machine-sheet-lede" role="status">
              {ended.name} is added. Check that {ended.name} shows the same number:
            </p>
            <div className="code-safety" role="group" aria-label="Safety number">
              {ended.safety}
            </div>
            <div className="machine-sheet-actions">
              <button type="button" className="btn-pill primary" autoFocus onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <ol className="code-steps">
              <li>Open MoPilot on the other Mac.</li>
              <li>In Settings › Connections › Control this Mac, click Add, then Computer.</li>
              <li>Enter the code it shows below.</li>
            </ol>
            <div className="code-boxes" role="group" aria-label="Code">
              {chars.map((c, i) => (
                <input
                  // biome-ignore lint/suspicious/noArrayIndexKey: eight fixed boxes, their place is their identity
                  key={i}
                  ref={(el) => {
                    boxes.current[i] = el;
                  }}
                  className={`code-box ${i === 3 ? 'code-box-gap' : ''}`}
                  aria-label={`Character ${i + 1} of ${LENGTH}`}
                  autoFocus={i === 0}
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  readOnly={phase.kind !== 'enter'}
                  aria-readonly={phase.kind !== 'enter'}
                  value={c}
                  onChange={(e) => !(e.nativeEvent as InputEvent).isComposing && type(i, e.target.value)}
                  onPaste={(e) => {
                    e.preventDefault();
                    paste(i, e.clipboardData.getData('text'));
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Backspace' || phase.kind !== 'enter') return;
                    // a filled box is emptied where it is; an empty one empties the one before and moves there
                    if (c) return;
                    e.preventDefault();
                    setChars(chars.map((x, j) => (j === i - 1 ? '' : x)));
                    focus(i - 1);
                  }}
                />
              ))}
            </div>
            {hint && <p className="machine-sheet-lede">{hint}</p>}
            <p className="machine-sheet-lede" role="status" aria-live="polite">
              {phase.kind === 'pairing' ? 'Pairing… The other Mac asks the person there to allow it.' : ''}
            </p>
            {ended && !ended.ok && (
              <>
                <p className="machine-sheet-error" role="alert">
                  {ended.cause}
                </p>
                {ended.fix && (
                  <div className="machine-sheet-actions">
                    <button
                      type="button"
                      className="btn-pill primary"
                      onClick={() => (ended.fix?.id === 'retry' && phase.kind === 'ended' ? void send(phase.code) : again())}
                    >
                      {ended.fix.label}
                    </button>
                  </div>
                )}
              </>
            )}
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                cancel();
                openAddMachine();
              }}
            >
              Or connect over SSH
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
