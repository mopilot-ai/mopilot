// The browser pane's sign-in notices: a sign-in window it opened, a page waiting on a passkey (at macOS's passkey sheet or not), and an identity provider's page, each with Continue in Chrome where a chat can continue there, and a close that puts only that notice away.
import { useState } from 'react';
import type { BrowserPageEvent } from '../../../lib/native';
import { displayHost } from './auxiliary';
import { PaneNotice } from './PaneNotice';

const NOTICE_KINDS = ['failed', 'crashed', 'slow', 'blocked', 'unresponsive'];
const hostOf = (origin: string | undefined) => (origin && origin !== 'null' ? displayHost(origin) : '');

/**
 * `popup`: the tab's open popup window (`popupHung` when its own unresponsive notice shows instead); `passkeyPage`: a
 * page waiting on a passkey; `signIn`: the identity provider the tab or its popup is on ('' when none). Closing a notice
 * hides it for that window, that page's request or that provider; the window, the request and the page carry on.
 */
export function SignInNotices({
  popup,
  popupHung,
  passkeyPage,
  signIn,
  handingOff,
  onChrome,
  popupAction,
  cancelPasskey,
}: {
  popup: BrowserPageEvent | undefined;
  popupHung: boolean;
  passkeyPage: BrowserPageEvent | undefined;
  signIn: string;
  handingOff: boolean;
  onChrome: (() => void) | null;
  popupAction: (action: 'focusPopup' | 'closePopup') => void;
  cancelPasskey: (legacy?: boolean) => void;
}) {
  const [closed, setClosed] = useState<{ popup?: number; passkey?: number; signIn?: string }>({});
  const close = (patch: typeof closed) => () => setClosed((c) => ({ ...c, ...patch }));
  const chrome = onChrome && <button onClick={onChrome}>Continue in Chrome</button>;
  return (
    <>
      {popup && !popupHung && closed.popup !== popup.pageId && (
        <PaneNotice onClose={close({ popup: popup.pageId })}>
          <span>
            {NOTICE_KINDS.includes(popup.kind)
              ? popup.message
              : `Sign-in window open${hostOf(popup.origin) ? ` for ${hostOf(popup.origin)}` : ''}. Finish there, then come back.`}
          </span>
          <div className="browser-notice-actions">
            <button onClick={() => popupAction('focusPopup')}>Show window</button>
            <button onClick={() => popupAction('closePopup')}>Cancel window</button>
            {chrome}
          </div>
        </PaneNotice>
      )}
      {passkeyPage && !handingOff && closed.passkey !== passkeyPage.pageId && (
        <PaneNotice onClose={close({ passkey: passkeyPage.pageId })}>
          <span>
            {passkeyPage.passkeySystem
              ? `Finish in the passkey window to sign in${hostOf(passkeyPage.origin) ? ` to ${hostOf(passkeyPage.origin)}` : ''}.`
              : `${hostOf(passkeyPage.origin) || 'This page'} wants a passkey, which this browser can't provide.`}
          </span>
          <div className="browser-notice-actions">
            <button onClick={() => cancelPasskey()}>Use another method</button>
            {passkeyPage.passkeySystem && passkeyPage.legacyPasskeys && (
              <button onClick={() => cancelPasskey(true)}>Use a passkey saved here</button>
            )}
            {chrome}
          </div>
        </PaneNotice>
      )}
      {signIn && !passkeyPage && !handingOff && closed.signIn !== signIn && (
        <PaneNotice onClose={close({ signIn })}>
          <span>Chrome and iCloud passkeys don't work here.</span>
          {chrome && <div className="browser-notice-actions">{chrome}</div>}
        </PaneNotice>
      )}
    </>
  );
}
