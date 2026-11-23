// Add by command (#2709): for a machine this Mac cannot reach over SSH. Get command shows one line to run on the machine, with Copy
// and how long it lasts; when the machine runs it, the card says who it is (its name, system, user and where it connected from) and
// asks Allow or "Didn't run this? Deny". Allowed, the machine is in My machines at once and the card says it is being set up until it
// has joined; a command or join that failed shows the add card's own failure (InstallCard: cause and Try again); expired and denied say so with Get a new command.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import type { HostBootView } from '../../../lib/native/host';
import { Spinner } from '../../ui/icons';
import { InstallCard } from './InstallCard';
import { copyText } from '../../../session/clipboard';
import { visiblePoll } from '../../../lib/visiblePoll';
import { toast } from '../../../store/core';
import { userError } from '../../../../shared/userError.mjs';
import { explainBootFailure } from '../../../../shared/host/installFailure.mjs';

const IDLE: HostBootView = { state: 'idle', command: '', expiresAt: 0, machine: null, error: '' };
const SYSTEMS: Record<string, string> = { darwin: 'macOS', linux: 'Linux' };

/** How the machine described itself, in one line: "macOS arm64 · user ops · from 203.0.113.9". @param {NonNullable<HostBootView['machine']>} m */
export function machineFacts(m: NonNullable<HostBootView['machine']>) {
  return [[SYSTEMS[m.os] ?? m.os, m.arch].filter(Boolean).join(' '), m.user ? `user ${m.user}` : '', m.ip ? `from ${m.ip}` : '']
    .filter(Boolean)
    .join(' · ');
}

/** What is left of a command's time, in whole minutes ("Expires in 14 min"; the last one says "under a minute"). */
export function expiresIn(expiresAt: number, now: number) {
  const left = expiresAt - now;
  if (left <= 0) return 'Expired';
  return left < 60_000 ? 'Expires in under a minute' : `Expires in ${Math.ceil(left / 60_000)} min`;
}

/** The ends that close the card, each said in one line; Get a new command starts over. */
const ENDS: Partial<Record<HostBootView['state'], string>> = {
  expired: 'That command expired.',
  denied: 'The machine was not added.',
};

export function AddByCommandCard({ open, onClose, onUseSsh }: { open: boolean; onClose: () => void; onUseSsh: () => void }) {
  const [view, setView] = useState<HostBootView>(IDLE);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  // a machine that finished joining closes the card (only a live event: a card that was closed meanwhile is left alone)
  const live = useRef({ open, onClose });
  live.current = { open, onClose };
  useEffect(
    () =>
      native.host.onBoot((v) => {
        setView(v);
        if (v.state === 'ready' && live.current.open) live.current.onClose();
      }),
    [],
  );
  // the countdown moves while the command waits
  const waiting = view.state === 'waiting' && !!view.command;
  useEffect(() => {
    if (!waiting) return;
    return visiblePoll('host-boot-countdown', 15_000, () => setNow(Date.now()));
  }, [waiting]);

  // stable: it only sets this card's own state
  const start = useCallback(async (retryJoin = false) => {
    setBusy(true);
    try {
      setView(await native.host.bootStart(retryJoin));
      setNow(Date.now());
    } catch (e) {
      setView({ ...IDLE, state: 'failed', error: userError(e) });
    } finally {
      setBusy(false);
    }
  }, []);
  // opening the card makes a command
  useEffect(() => {
    if (!open) return;
    setView(IDLE); // never the last command's end
    void start();
  }, [open, start]);
  if (!open) return null;

  // the command ends with the card; if the app could not end it, the person is told (it still runs out on its own)
  const close = () => {
    native.host.bootDeny().catch((e) => toast(userError(e), 'error'));
    onClose();
  };
  /** @param name what the machine called itself (the card shows Allow only for a machine that said) */
  const allow = async (name: string) => {
    try {
      await native.host.bootAllow();
      toast(`Added ${name || 'the machine'}`);
      // the machine is listed; the card stays until it has joined, or says why it did not (a view that already said so is kept)
      setView((v) => (v.state === 'ready' || v.state === 'join_failed' ? v : { ...v, state: 'joining' }));
    } catch (e) {
      toast(userError(e), 'error');
    }
  };
  const copy = () => copyText(view.command, 'Copied');

  const joinFailed = view.state === 'join_failed';
  // a failed command and a failed join are the add card's own failure (InstallCard: title, cause, Try again), as the SSH add shows them
  const failure =
    joinFailed || view.state === 'failed'
      ? (!joinFailed && explainBootFailure(view.error)) || {
          title: joinFailed ? 'Couldn’t finish setting up the machine' : 'Couldn’t add the machine',
          reason: view.error,
          action: { kind: 'retry' as const },
          cause: 'other' as const,
        }
      : null;
  const end = ENDS[view.state];
  return (
    <div className="host-install host-boot" role="group" aria-label="Add by command">
      {view.state === 'joining' || view.state === 'joined' || failure ? (
        <>
          <InstallCard
            target={view.machine?.name || 'the machine'}
            running={!failure}
            steps={[]}
            ok={false}
            failure={failure}
            onAction={() => (failure?.action.kind === 'ssh' ? onUseSsh() : void start(joinFailed))}
          />
          <div className="host-boot-actions">
            <button className="btn-pill soft" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : view.state === 'asking' && view.machine ? (
        <>
          <div className="host-install-line" role="status">
            <b>{view.machine.name || 'A machine'}</b> wants to join
          </div>
          <div className="host-install-reason">{machineFacts(view.machine)}</div>
          <div className="host-boot-actions">
            <button className="btn-pill" onClick={() => void allow(view.machine!.name)}>
              Allow
            </button>
            <button className="btn-pill soft" onClick={close}>
              Didn’t run this? Deny
            </button>
          </div>
        </>
      ) : end ? (
        <>
          <div className="host-install-line" role="alert">
            {end}
          </div>
          <div className="host-boot-actions">
            <button className="btn-pill soft" disabled={busy} onClick={() => void start()}>
              Get a new command
            </button>
            <button className="btn-pill soft" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : waiting ? (
        <>
          <div className="host-install-line">Run this on the machine (macOS or Linux, no admin needed):</div>
          <code className="host-boot-command">{view.command}</code>
          <div className="host-boot-actions">
            <button className="btn-pill" onClick={copy}>
              Copy
            </button>
            <button className="btn-pill soft" onClick={close}>
              Cancel
            </button>
            <span className="host-install-reason" role="status">
              <Spinner size={12} /> Waiting for the machine · {expiresIn(view.expiresAt, now)}
            </span>
          </div>
        </>
      ) : (
        <div className="host-install-line" role="status">
          <Spinner size={12} /> Making a command…
        </div>
      )}
    </div>
  );
}
