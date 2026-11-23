// The question ssh asks while a machine is added, answered in place: a first-seen host key with its fingerprint (Trust and connect), a password or passphrase in a secure field, or ssh's own yes/no. The answer goes to ssh only; nothing here keeps it.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Row } from './Controls';
import { native } from '../../../lib/native';
import type { HostSshPrompt } from '../../../lib/native/host';
import { isEnter } from '../../../lib/focus';
import { normalDestination } from '../../../lib/hostAddress';
import { toast } from '../../../store/core';
import { userError } from '../../../../shared/userError.mjs';

type Open = { id: string; prompt: HostSshPrompt };

/** The question open for `destination` (the machine being added), or null. */
export function useConnectPrompt(destination: string | null): Open | null {
  const [open, setOpen] = useState<Open | null>(null);
  // the main process names the add by the address's normal form
  const wanted = destination === null ? null : normalDestination(destination);
  const latest = useRef(wanted);
  latest.current = wanted;
  useEffect(() => {
    setOpen(null);
    if (!destination) return;
    return native.host.onPrompt((e) => {
      if (normalDestination(e.destination) !== latest.current) return;
      setOpen((cur) => (e.prompt ? { id: e.id, prompt: e.prompt } : cur?.id === e.id ? null : cur));
    });
  }, [destination]);
  return open;
}

/** What the row says for a question: its title, the line under it, and whether it takes typed text. */
function wording(p: HostSshPrompt): { title: string; desc: ReactNode; secret: boolean; yes: string; says?: string } {
  switch (p.kind) {
    case 'hostKey':
      return {
        title: `Connect to ${p.host}?`,
        // ssh asks only for a machine it has not seen: the fingerprint is on the row, not behind a hover
        desc: (
          <>
            First time connecting to this machine.{' '}
            <span className="host-fingerprint">
              {p.keyType} {p.fingerprint}
            </span>
          </>
        ),
        secret: false,
        yes: 'Connect',
      };
    case 'password':
      return { title: `Password for ${p.account}`, desc: 'Not saved.', secret: true, yes: 'Connect' };
    case 'passphrase':
      return { title: `Passphrase for ${p.key}`, desc: 'Not saved.', secret: true, yes: 'Connect' };
    case 'keyConsent':
      // said before anything is made or added: the key's name, where it goes, and that Cancel leaves both as they are
      return {
        title: `Add a MoPilot key to ${p.host}?`,
        desc: `MoPilot reconnects in the background, so it adds the key in ${p.publicKeyFile} to ${p.addsTo} on ${p.host}. Cancel adds nothing.`,
        secret: false,
        yes: 'Add key',
        says: 'add',
      };
    case 'confirm':
      return { title: p.text, desc: '', secret: false, yes: 'Yes' };
    default:
      return { title: p.text, desc: 'Used once to connect. MoPilot doesn’t keep it.', secret: true, yes: 'Connect' };
  }
}

/** Keyed by the question's id where it is drawn, so a new question starts with an empty field. */
export function HostConnectPrompt({ open }: { open: Open | null }) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  if (!open) return null;
  const w = wording(open.prompt);
  const answer = async (text: string | null) => {
    setSending(true);
    try {
      await native.host.answerPrompt(open.id, text);
      setValue('');
    } catch (e) {
      toast(userError(e), 'error');
    } finally {
      setSending(false);
    }
  };
  const confirm = () => void answer(w.secret ? value : (w.says ?? 'yes'));
  return (
    <Row title={w.title} desc={w.desc}>
      {w.secret && (
        <input
          className="text-input slim wide"
          type="password"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => isEnter(e) && value && !sending && confirm()}
          aria-label={w.title}
        />
      )}
      <button className="btn-pill soft" disabled={sending} onClick={() => void answer(null)}>
        Cancel
      </button>
      <button className="btn-pill primary" disabled={sending || (w.secret && !value)} onClick={confirm}>
        {w.yes}
      </button>
    </Row>
  );
}
