// Add a machine, from the host chip or Settings › Machines: one field (an address, user@host:port or a name from the ssh config) with the machines found on this network, Tailscale and the ssh config under it, and Any network (Add by command) as a link. Picking one installs over SSH with one progress line, ssh's questions answered in place, the machine's folder picker once it is ready, and a pairing code when the machine did not pair by itself. A Mac nobody is signed in on is added again with its administrator password, its Host started before anyone signs in (DaemonPasswordRow).
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../ui/Modal';
import { InstallCard, type InstallStep } from './InstallCard';
import { HostConnectPrompt, useConnectPrompt } from './HostConnectPrompt';
import { AddMachinePicker } from './AddMachinePicker';
import { AddByCommandCard } from './AddByCommandCard';
import { DaemonPasswordRow } from './DaemonPasswordRow';
import { explainFailure } from '../../../../shared/host/installFailure.mjs';
import { pickNewChatHost, setNewChatHostFolder } from '../../../store/projects';
import { HostFolderPicker } from '../../composer/HostFolderPicker';
import { navigate } from '../../../store/panes';
import { useStore, setPrefs, toast } from '../../../store/core';
import { native } from '../../../lib/native';
import { busyField, isEnter } from '../../../lib/focus';
import { ignoring } from '../../../lib/ignored';
import { userError } from '../../../../shared/userError.mjs';
import { normalDestination as normal } from '../../../lib/hostAddress';

type Added = Awaited<ReturnType<typeof native.host.add>>;
type Mode = 'list' | 'any';
const SOURCES = ['network', 'tailscale', 'config'] as const;
/** user@host, host:port or a name from the ssh config; ssh:// is the same thing spelled as a URL */
const DESTINATION = /^(ssh:\/\/)?[\w.@:-]+\/?$/;
const NO_HOSTS: string[] = [];

/** The steps of one install, as they start and end; a step seen again replaces its line. */
function useInstallSteps(destination: string | null) {
  const [steps, setSteps] = useState<InstallStep[]>([]);
  const latest = useRef(destination === null ? null : normal(destination));
  latest.current = destination === null ? null : normal(destination);
  useEffect(() => {
    if (!destination) return;
    setSteps([]);
    return native.host.onInstallStep((e) => {
      // main names the event by the address as it was typed; the add by its normal form
      if (normal(e.destination) !== latest.current) return;
      // steps run in order, so a step seen again (it ended) is the newest one: it replaces its earlier line
      setSteps((cur) => [...cur.filter((s) => s.id !== e.step.id), e.step]);
    });
  }, [destination]);
  return steps;
}

/** Stays mounted while closed: an install keeps running, and a question ssh asks for it opens the sheet again. */
export function AddMachineSheet({
  open,
  onOpen,
  onClose,
  onCloud,
  onStartChat,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** host.cloud: the fourth way in, New cloud machine… (absent: not offered) */
  onCloud?: () => void;
  /** what Start a chat on it does with the machine just added (absent: pick it for the next new chat and go home) */
  onStartChat?: (machine: { id: string; name: string }) => void;
}) {
  // the saved list itself: a fresh [] on every read would make the selector look changed on each render
  const known = useStore((s) => s.prefs.sshHosts) ?? NO_HOSTS;
  const [mode, setMode] = useState<Mode>('list');
  const [browsing, setBrowsing] = useState(false);
  const [destination, setDestination] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [targetDestination, setTargetDestination] = useState('');
  const [result, setResult] = useState<Added | null>(null);
  const [code, setCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState('');
  // the administrator password field a Mac nobody is signed in on asks for (Keep running without sign-in)
  const [askingPassword, setAskingPassword] = useState(false);
  const machineField = useRef<HTMLInputElement>(null);
  // bumped to put the cursor before the host in the SSH field, for the user name
  const [askUser, setAskUser] = useState(0);
  useEffect(() => {
    if (!askUser) return;
    machineField.current?.focus();
    machineField.current?.setSelectionRange(0, 0);
  }, [askUser]);
  // each time the sheet opens it starts on the field, never inside a command a closed sheet left behind
  useEffect(() => {
    if (open) setMode('list');
  }, [open]);
  const steps = useInstallSteps(running);
  const prompt = useConnectPrompt(running);
  useEffect(() => {
    if (prompt) onOpen();
  }, [prompt, onOpen]);

  /** Add `typed` (the SSH field, or a machine picked from a list, shown by its own name); with `daemonPassword`, a Mac's Host starts at boot. */
  const install = async (typed = destination, name = '', daemonPassword = '') => {
    const d = typed.trim();
    if (!DESTINATION.test(d) || d.startsWith('@')) return toast('Enter a machine like user@example.com', 'error');
    setDestination(d);
    setResult(null);
    setTarget(name || normal(d));
    setTargetDestination(d);
    setRunning(d);
    setAskingPassword(false);
    setPairError('');
    setCode('');
    try {
      const out = await (daemonPassword ? native.host.add(d, { daemonPassword }) : native.host.add(d));
      setResult(out);
      if (out.ok) {
        setPrefs({ sshHosts: [...new Set([...known, d])] });
        if (out.paired) {
          setDestination('');
          toast(`Added ${d}`);
          // ready: straight into a folder on it, then the composer on that machine
          setBrowsing(true);
        }
      }
    } catch (e) {
      setResult({ ok: false, paired: false, error: userError(e), id: '', steps: [] });
    } finally {
      setRunning(null);
    }
  };
  /** Pair the machine a finished install left unpaired. */
  const pair = async (done: Added) => {
    setPairing(true);
    setPairError('');
    try {
      await native.host.pair(done.id, code);
      setResult({ ...done, paired: true, error: '' });
      setCode('');
      setDestination('');
      toast(`Paired ${done.id.replace(/^ssh:/, '')}`);
      setBrowsing(true);
    } catch (e) {
      setPairError(userError(e));
    } finally {
      setPairing(false);
    }
  };
  /** The machine's user isn't this computer's: the field, with the host filled in and the cursor where the name goes. */
  const otherAccount = () => {
    setResult(null);
    setDestination(`@${targetDestination.slice(targetDestination.lastIndexOf('@') + 1)}`);
    setMode('list');
    setAskUser((n) => n + 1);
  };
  // leaving Any network ends its command (the machine was not added); the card's own Cancel does the same
  const leave = (next: Mode | null) => {
    if (mode === 'any' && next !== 'any') native.host.bootDeny().catch(ignoring('end an Add by command command'));
    if (next) setMode(next);
    else onClose();
  };
  if (!open) return null;

  const shownSteps = running ? steps : (result?.steps ?? []);
  const failedStep = shownSteps.find((s) => s.state === 'failed');
  // a failure of the install itself, said as its cause with one action; a pairing failure keeps the code field below
  const failure =
    !running && result && !result.ok && !result.cancelled
      ? explainFailure({
          step: failedStep?.id ?? '',
          output: result.error || failedStep?.output || '',
          target,
          destination: targetDestination,
          rolledBack: result.rolledBack,
          publicKey: result.publicKey,
        })
      : null;
  const pick = (m: { destination: string; name: string }) => void install(m.destination, m.name);

  return (
    <Modal title="Add a machine" onClose={() => leave(null)}>
      <div className="machine-sheet add-machine-sheet">
        {mode === 'list' && (
          <>
            <div className="machine-sheet-field">
              <input
                className="text-input"
                list="host-ssh-known"
                placeholder="user@host, host:port or a name from your SSH config"
                ref={machineField}
                value={destination}
                {...busyField(running !== null)}
                onChange={(e) => setDestination(e.target.value)}
                onKeyDown={(e) => isEnter(e) && running === null && void install()}
                aria-label="Machine"
              />
              <datalist id="host-ssh-known">
                {known.map((h) => (
                  <option key={h} value={h} />
                ))}
              </datalist>
              <button
                className="btn-pill"
                disabled={running !== null || !destination.trim() || destination.startsWith('@')}
                onClick={() => void install()}
              >
                {running ? 'Adding…' : 'Add'}
              </button>
            </div>
            <AddMachinePicker open={running === null} filter={destination} sources={SOURCES} onPick={pick} />
            <div className="machine-sheet-links">
              <button className="link-btn" onClick={() => leave('any')}>
                Any network (add by command)
              </button>
              {onCloud && (
                <button className="link-btn" onClick={onCloud}>
                  New cloud machine…
                </button>
              )}
            </div>
          </>
        )}
        {mode === 'any' && (
          <>
            <p className="machine-sheet-lede">Run one command on the other machine.</p>
            {/* the card ends its own command (Deny, Cancel) or saw it end, so closing from it denies nothing more */}
            <AddByCommandCard open onClose={onClose} onUseSsh={() => leave('list')} />
            <div className="machine-sheet-links">
              <button className="link-btn" onClick={() => leave('list')}>
                Back
              </button>
            </div>
          </>
        )}
        {/* an add under way stays in view in either mode: ssh may ask a question it waits on */}
        {(mode !== 'any' || running !== null) && (
          <>
            <HostConnectPrompt key={prompt?.id} open={prompt} />
            <InstallCard
              target={target}
              running={running !== null}
              steps={shownSteps}
              ok={!!result?.ok && result.paired}
              failure={failure}
              onAction={() =>
                failure?.action.kind === 'account'
                  ? otherAccount()
                  : failure?.action.kind === 'daemon'
                    ? setAskingPassword(true)
                    : failure?.action.kind === 'copy'
                      ? void native.clipboard.write(failure.action.text).then(
                          () => toast('Copied'),
                          () => toast('Couldn’t copy', 'error'),
                        )
                      : void install(targetDestination, target)
              }
              check={() => native.host.reachable(targetDestination)}
              // while ssh asks a question its own row has the Cancel: one button, not two
              onCancel={prompt ? undefined : () => void native.host.cancelAdd(normal(targetDestination)).catch(ignoring('stop an add'))}
              cancelled={!running && result?.cancelled ? { undone: result.rolledBack === true } : null}
              onStartChat={
                result?.ok && result.paired
                  ? () =>
                      onStartChat
                        ? onStartChat({ id: result.id, name: target })
                        : (pickNewChatHost({ id: result.id, name: target }), navigate({ name: 'home' }))
                  : undefined
              }
            />
            {askingPassword && failure?.action.kind === 'daemon' && (
              <DaemonPasswordRow
                target={target}
                onCancel={() => setAskingPassword(false)}
                onSubmit={(pw) => void install(targetDestination, target, pw)}
              />
            )}
            {result?.ok && !result.paired && (
              <>
                <div className="host-install-reason" role="status">
                  {result.error || `Couldn’t connect to ${target} yet.`}
                  <button type="button" className="btn-pill soft" onClick={() => void install(targetDestination, target)}>
                    Try again
                  </button>
                </div>
                <details className="host-install-details">
                  <summary>Have a pairing code?</summary>
                  {pairError && (
                    <div className="machine-sheet-error" role="alert">
                      {pairError}
                    </div>
                  )}
                  <div className="machine-sheet-field">
                    <input
                      className="text-input"
                      placeholder="Pairing code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      onKeyDown={(e) => isEnter(e) && !pairing && void pair(result)}
                      aria-label="Pairing code"
                    />
                    <button className="btn-pill" disabled={pairing || !code.trim()} onClick={() => void pair(result)}>
                      Pair
                    </button>
                  </div>
                </details>
              </>
            )}
          </>
        )}
      </div>
      {browsing && result?.ok && result.paired && (
        <HostFolderPicker
          hostId={result.id}
          name={target}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            const machine = { id: result.id, name: target };
            pickNewChatHost(machine);
            setNewChatHostFolder(machine, path);
            setBrowsing(false);
            onClose();
            navigate({ name: 'home' });
          }}
        />
      )}
    </Modal>
  );
}
