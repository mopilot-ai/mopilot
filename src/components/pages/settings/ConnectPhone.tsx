// Connect your phone: the one dialog every entry opens. Sign-in when it is missing (choosing Connect is the consent), the pairing QR with its code to copy, one Connect / Decline prompt with the safety number folded beside it, then it closes itself with a toast.
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { native } from '../../../lib/native';
import { ignoring, userError } from '../../../lib/ignored';
import { closeConnectPhone, useConnectPhoneOpen } from '../../../lib/phoneEntry';
import type { RemoteSettingsState } from '../../../lib/native/remoteSettings';
import { copyText } from '../../../session/clipboard';
import { groupSafety } from '../../../../shared/remote/safetyNumber.mjs';
import { REFUSAL_TEXT } from '../../../../shared/remote/relayRefusal.mjs';
import { Modal } from '../../ui/Modal';
import { GetTheApp } from './GetTheApp';

/** Pairing states after which the next QR starts by itself; a failure or a recovery state waits for the user. */
const RENEW = ['expired', 'declined', 'cancelled'];
/** How the last pairing ended, for a dialog opened after that: the new one starts clean. */
const ENDED = ['paired', 'failed', 'rejected'];
/** A phone is waiting on the person's answer or being saved: only Connect or Decline ends this, not a stray Escape. */
const HELD = ['confirming', 'finishing'];
/** A code lives two minutes: after this many in a row nobody is scanning, and a dialog left open stops showing secrets. */
export const MAX_RENEWALS = 10;

function Body({ text, error, children }: { text: ReactNode; error?: string; children?: ReactNode }) {
  return (
    <div className="connect-phone">
      <div className="settings-row-desc">{text}</div>
      {error && (
        <div className="settings-row-desc" role="alert">
          {error}
        </div>
      )}
      {children && <div className="acct-dialog-actions">{children}</div>}
    </div>
  );
}

/** The phone's own name from the prompt's line: a re-pair says `Replaces "old" with "new"`, and only the new one is who connected. */
function phoneName(shown: string): string {
  const swap = /^Replaces ".*" with "(.*)"$/s.exec(shown);
  return swap ? swap[1] : shown;
}

// loaded when it is needed: the dialog is part of the app's first load, and these settings controls are not
const Connected = lazy(() => import('./ConnectPhoneConnected').then((m) => ({ default: m.Connected })));

function Panel({ held }: { held: { current: boolean } }) {
  const [state, setState] = useState<RemoteSettingsState | null>(null);
  const [error, setError] = useState('');
  const [image, setImage] = useState('');
  const [renewals, setRenewals] = useState(0);
  const revision = useRef(0);
  const mounted = useRef(true);
  const starting = useRef(false);
  const acting = useRef(false);
  // the account this dialog switched phone access on for: another account signing in is switched on too
  const consent = useRef<string | null>(null);
  const device = useRef('');
  useEffect(() => {
    let active = true;
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    const read = async () => {
      const mine = ++revision.current;
      try {
        let next = await native.remoteSettings.state();
        if (first && next.visible && ENDED.includes(next.pairing?.state ?? '')) {
          await native.remoteSettings.cancel();
          next = await native.remoteSettings.state();
        }
        first = false;
        if (active && mine === revision.current) setState(next);
      } catch (e) {
        // a read that fails once the page is up changes nothing: the next one will tell
        if (first && active && mine === revision.current) setError(userError(e));
      }
      if (active) timer = setTimeout(read, 1000);
    };
    void read();
    return () => {
      active = false;
      mounted.current = false;
      revision.current++;
      clearTimeout(timer);
      void native.remoteSettings.cancel().catch(ignoring('cancel Mobile Remote pairing'));
    };
  }, []);
  const visible = state?.visible ? state : null;
  const pairing = visible?.pairing ?? null;
  const phase = pairing?.state;
  // a Mac the relay is turning away cannot register a code: the reason shows instead, and the code follows once it is let in
  const pairable = !!visible && visible.signedIn && visible.enabled && visible.running && !visible.locked && !visible.refusal;
  const stopped = renewals >= MAX_RENEWALS;
  held.current = HELD.includes(phase ?? '');
  // the phone behind the last prompt names the toast; a renewed code is a new phone, so it starts blank
  if (pairing?.device) device.current = phoneName(pairing.device);
  else if (phase === 'waiting') device.current = '';
  // the gate closed while it was open: there is nothing left to show
  const gone = state?.visible === false;
  useEffect(() => {
    if (gone) closeConnectPhone();
  }, [gone]);
  const begin = useCallback(async () => {
    starting.current = true;
    ++revision.current;
    try {
      await native.remoteSettings.begin();
    } catch (e) {
      if (mounted.current) setError(userError(e));
    } finally {
      starting.current = false;
    }
  }, []);
  // the QR is up as soon as it can be, and a lapsed one is replaced until nobody seems to be scanning
  useEffect(() => {
    if (!pairable || error || stopped || starting.current || acting.current || (pairing && !RENEW.includes(pairing.state))) return;
    if (pairing) setRenewals((n) => n + 1);
    void begin();
  }, [pairable, pairing, error, stopped, begin]);
  useEffect(() => {
    let active = true;
    setImage('');
    if (pairing?.qr)
      void QRCode.toDataURL(pairing.qr, { margin: 2, width: 280 }).then(
        (url) => {
          if (active) setImage(url);
        },
        (e) => {
          if (active) setError(userError(e));
        },
      );
    return () => {
      active = false;
    };
  }, [pairing?.qr]);
  const action = async (work: () => Promise<unknown>) => {
    ++revision.current;
    acting.current = true;
    try {
      setError('');
      await work();
    } catch (e) {
      if (mounted.current) setError(userError(e));
    } finally {
      acting.current = false;
    }
    // what the action did shows at once when it can be read, else at the next read
    const mine = ++revision.current;
    try {
      const next = await native.remoteSettings.state();
      if (mounted.current && mine === revision.current) setState(next);
    } catch (e) {
      ignoring('read Mobile Remote after an action')(e);
    }
  };
  const account = visible?.account ?? '';
  const enable = () => {
    consent.current = account;
    void action(() => native.remoteSettings.setEnabled(true));
  };
  const retry = () => {
    setRenewals(0);
    if (!visible?.enabled) {
      // phone access is not on yet: it is switched on again, and the code follows
      setError('');
      enable();
    } else void action(begin);
  };
  // choosing Connect is the consent: phone access turns on by itself, once per account, as soon as someone is signed in
  useEffect(() => {
    if (!visible?.signedIn || visible.enabled || error || consent.current === account) return;
    enable();
  });
  if (!visible) return error ? <Body text={<span role="alert">{error}</span>} /> : null;
  const close = closeConnectPhone;
  const answer = (allow: boolean) => () => action(() => native.remoteSettings.answer(allow));
  if (!visible.signedIn)
    return (
      <Body text="Sign in to MoPilot on this Mac first. Use the same account on your phone." error={error}>
        <button
          className="btn primary sm"
          onClick={() =>
            action(async () => {
              const r = await native.mopilot.signIn();
              if (!r.ok && r.error) throw new Error(r.error);
            })
          }
        >
          Sign in to MoPilot
        </button>
      </Body>
    );
  if (visible.refusal && visible.running && phase !== 'confirming' && phase !== 'finishing' && phase !== 'paired')
    return (
      <Body text={<span role="alert">{REFUSAL_TEXT[visible.refusal]}</span>}>
        <button className="btn sm" onClick={close}>
          Close
        </button>
      </Body>
    );
  if (phase === 'confirming')
    return (
      <Body
        error={error}
        text={
          <>
            <strong>Connect {pairing?.device || 'this phone'}?</strong>
            <details>
              <summary>Safety number</summary>
              Same number on the phone: {groupSafety(pairing?.safetyNumber ?? '')}
            </details>
          </>
        }
      >
        <button className="btn sm" onClick={answer(false)}>
          Decline
        </button>
        <button className="btn primary sm" autoFocus onClick={answer(true)}>
          Connect
        </button>
      </Body>
    );
  if (error)
    return (
      <Body text={<span role="alert">{error}</span>}>
        <button className="btn sm" onClick={close}>
          Close
        </button>
        <button className="btn primary sm" onClick={retry}>
          Try again
        </button>
      </Body>
    );
  if (phase === 'uncertain' || phase === 'storage-locked' || visible.locked)
    return <Body text="Phone storage needs recovery. Restart MoPilot, then check your paired phones." />;
  // switched off from another window after this dialog switched it on: it stays off until the person says so
  if (!visible.enabled && consent.current === account && !acting.current && phase !== 'finishing' && phase !== 'paired')
    return (
      <Body text="Phone access is off.">
        <button className="btn primary sm" onClick={retry}>
          Turn on
        </button>
      </Body>
    );
  if (!visible.running) return <Body text="Starting…" />;
  if (phase === 'finishing') return <Body text="Connecting…" />;
  if (phase === 'paired')
    return (
      <Suspense fallback={null}>
        <Connected name={device.current || 'this phone'} close={close} />
      </Suspense>
    );
  if (phase === 'failed' || phase === 'rejected')
    return (
      <Body text="Couldn't pair that phone.">
        <button className="btn primary sm" onClick={retry}>
          Try again
        </button>
      </Body>
    );
  if (phase === 'elsewhere')
    return (
      <Body text="Pairing is open in another window.">
        <button className="btn primary sm" onClick={retry}>
          Show here
        </button>
      </Body>
    );
  if (stopped)
    return (
      <Body text="The code timed out.">
        <button className="btn primary sm" onClick={retry}>
          Show code
        </button>
      </Body>
    );
  if (!pairing?.qr) return <Body text="Starting…" />;
  return (
    <div className="mobile-remote-qr">
      {image && <img src={image} width={200} height={200} alt="Pairing QR code" />}
      <div className="settings-row-desc">Scan with MoPilot on your phone. Only connect devices you own.</div>
      {visible.account && <div className="settings-row-desc">Signed in as {visible.account}</div>}
      <button type="button" className="btn-pill soft" onClick={() => copyText(pairing.qr as string, 'Code copied')}>
        Copy code
      </button>
      <GetTheApp />
    </div>
  );
}

export function ConnectPhoneDialog() {
  const open = useConnectPhoneOpen();
  const held = useRef(false);
  const close = useCallback(() => {
    if (!held.current) closeConnectPhone();
  }, []);
  if (!open) return null;
  return (
    <Modal title="Connect your phone" onClose={close}>
      <Panel held={held} />
    </Modal>
  );
}
