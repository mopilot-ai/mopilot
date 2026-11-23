// "Allow Chrome to connect?": the dialog that pairs MoPilot's Chrome extension when it asks by itself (electron/capabilities/browser/chromePairOffers.cjs).

import { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { busyField, cancelOnEscape, isEnter } from '../../lib/focus';
import { native } from '../../lib/native';
import { useNativeAvailability } from '../../session/nativeAvailability';
import { toastFailure } from '../../store/core';
import styles from '../chromeAllowDialog.module.css';

/**
 * Up while main asks (the extension's health says chrome.allow); gone once answered or the extension connects. A dialog
 * rather than a sidebar card: the user has just turned the extension on in Chrome and come here to answer, and the
 * name field needs more room than the sidebar has. Escape is Not now; Enter in the name is Allow.
 */
export function ChromeAllowDialog() {
  const asking = useNativeAvailability()?.extension?.reasonCode === 'chrome.allow';
  const [name, setName] = useState('My Chrome');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // the name has the keyboard when the question comes up, selected so typing replaces it
  useEffect(() => {
    if (!asking) return;
    input.current?.focus();
    input.current?.select();
  }, [asking]);
  if (!asking) return null;
  const canAllow = !busy && !!name.trim();
  const answer = (allow: boolean) => {
    setBusy(true);
    native.availability
      .chromeAllow(allow, allow ? name.trim() : undefined)
      .catch(toastFailure(allow ? "Couldn't allow Chrome" : "Couldn't dismiss"))
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="sketch-backdrop"
      // a click on the backdrop keeps the keyboard in the dialog (Escape still answers) rather than answering for the user
      onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}
      onKeyDown={(e) => cancelOnEscape(e, () => !busy && answer(false))}
    >
      <div
        className={`dialog ${styles.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chrome-allow-title"
        aria-describedby="chrome-allow-body"
        data-testid="chrome-allow-dialog"
      >
        <span className={styles.icon}>
          <Globe size={20} strokeWidth={1.8} />
        </span>
        <div id="chrome-allow-title" className={styles.title}>
          Allow Chrome to connect?
        </div>
        <p id="chrome-allow-body" className={styles.body}>
          The MoPilot extension in Chrome asked to connect. Once you allow it, agents can work in your signed-in Chrome.
        </p>
        <label className={styles.field}>
          Name this Chrome
          <input
            ref={input}
            className="text-input"
            maxLength={80}
            value={name}
            aria-describedby="chrome-allow-hint"
            {...busyField(busy)}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => isEnter(e) && canAllow && answer(true)}
          />
        </label>
        {/* as Claude's pairing prompt asks: the name Settings → Browser and the extension's page show */}
        <p id="chrome-allow-hint" className={styles.hint}>
          Shown in Settings → Browser and in the extension.
        </p>
        <div className={styles.actions}>
          <button className="btn sm" disabled={busy} onClick={() => answer(false)}>
            Not now
          </button>
          <button className="btn primary sm" disabled={!canAllow} onClick={() => answer(true)}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
