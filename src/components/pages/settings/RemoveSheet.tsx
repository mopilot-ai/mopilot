// Remove from a machine's ⋯ menu: on a machine that answers over ssh (its Host running or stopped) it stops the Host there and deletes its files first (asking when a turn runs, and for the administrator password when the Host is a boot daemon); a machine that does not answer is only forgotten here, and the sheet says the Host is still there. A machine added by command (`relay:` id) is never uninstalled from here: the sheet says so and shows the line to run on it.
import { useEffect, useState } from 'react';
import { Modal } from '../../ui/Modal';
import { toast } from '../../../store/core';
import { forgetHostMachine } from '../../../store/projects';
import { native } from '../../../lib/native';
import { copyText } from '../../../session/clipboard';
import { isEnter } from '../../../lib/focus';
import type { HostMachineRow } from '../../../lib/hostMachines';
import { userError } from '../../../../shared/userError.mjs';
import { HOST_UNINSTALL_LINE } from '../../../../shared/host/hostUninstallLine.mjs';

/** A machine added by command has only the relay to this Mac (its id is `relay:<host id>`): there is no ssh to uninstall over. */
export const addedByCommand = (id: string) => id.startsWith('relay:');

export type RemovePlan = Awaited<ReturnType<typeof native.host.removePlan>>;

/** What the sheet says before it acts: whether the Host is uninstalled too, and what that stops. */
export function removeLede(plan: RemovePlan, name: string, byCommand = false): string[] {
  if (byCommand)
    return [
      `Removes ${name} from this Mac. The Host stays installed on it.`,
      ...(plan.daemon ? ['Keep running is on there, so the Host keeps starting at boot. Turn it off first to be able to delete it.'] : []),
      `To delete the Host and its files, run this on ${name}:`,
    ];
  if (!plan.ssh || !plan.reachable)
    return [
      `The Host and chats' files stay on ${name}. This only removes it here.`,
      'To delete those files later, add the machine again and choose Remove, or delete ~/.mopilot-host and the Host data directory there.',
    ];
  if (plan.shared)
    return [
      plan.why === 'unknown'
        ? `${name}'s Host and files stay: it can't be told apart from ${plan.shared}. It's only removed here.`
        : `${plan.shared} uses the same Host. ${name} is only removed here; the Host and its files stay.`,
    ];
  if (plan.unsure)
    return [`Can't tell whether Keep running is on at ${name}. It's removed here; its Host may still run and its files stay.`];
  return [
    `Stops the Host on ${name} and deletes its files.`,
    ...(plan.busy === 'yes'
      ? ['A turn is running there. It will stop.']
      : plan.busy === 'unknown'
        ? ['A turn may be running there. It will stop.']
        : []),
    ...(plan.daemon ? ['Keep running is on. Without the password the Host stays.'] : []),
  ];
}

/** The toast once the machine is gone from the list: says what is still on the machine. */
export function removedNote(
  name: string,
  uninstalled: boolean,
  left: '' | 'daemon' | 'unsure' | 'shared',
  byCommand = false,
  other?: { shared?: string; why?: 'same' | 'unknown' },
): string {
  if (byCommand) return `${name} removed here. Its Host is still installed there.`;
  if (left === 'daemon') return `${name} removed. Its Host still runs there.`;
  if (left === 'unsure') return `${name} removed here. Its Host may still run there.`;
  if (left === 'shared')
    return other?.why === 'unknown'
      ? `${name} removed here. Its Host and files stay: it can't be told apart from ${other.shared}.`
      : `${name} removed here. Its Host and files stay: ${other?.shared} uses the same Host.`;
  return uninstalled
    ? `${name} removed`
    : `${name} removed here. Its Host and chats' files remain there; add it again and Remove to delete them.`;
}

export function RemoveSheet({ machine, onClose }: { machine: HostMachineRow; onClose: () => void }) {
  const [plan, setPlan] = useState<RemovePlan | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    native.host
      .removePlan(machine.id)
      .then((p) => live && setPlan(p))
      // a plan that cannot be made is the offline case: only forget it here
      .catch(
        () =>
          live &&
          setPlan({ ssh: false, reachable: false, online: false, busy: 'unknown', daemon: false, unsure: false, shared: '', why: '' }),
      );
    return () => {
      live = false;
    };
  }, [machine.id]);
  const byCommand = addedByCommand(machine.id);
  const remote = !!plan && plan.ssh && plan.reachable && !byCommand;
  const run = async (uninstall: boolean) => {
    setBusy(true);
    setError('');
    try {
      const out = uninstall
        ? await native.host.uninstall(machine.id, plan?.daemon ? password : '')
        : { left: '' as const, shared: '', why: undefined };
      await native.host.remove(machine.id);
      forgetHostMachine(machine.id);
      toast(removedNote(machine.name, uninstall, out.left, byCommand, out));
      onClose();
    } catch (e) {
      setPassword('');
      setError(userError(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Remove ${machine.name}`} onClose={onClose}>
      <div className="machine-sheet">
        {plan &&
          removeLede(plan, machine.name, byCommand).map((line) => (
            <p key={line} className="machine-sheet-lede">
              {line}
            </p>
          ))}
        {plan && byCommand && (
          <div className="machine-sheet-field">
            <code className="host-boot-command">{HOST_UNINSTALL_LINE}</code>
            <button className="btn-pill soft" onClick={() => copyText(HOST_UNINSTALL_LINE, 'Copied')}>
              Copy
            </button>
          </div>
        )}
        {remote && plan.daemon && (
          <div className="machine-sheet-field">
            <input
              className="text-input"
              type="password"
              autoComplete="off"
              placeholder="Administrator password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => isEnter(e) && !busy && void run(true)}
              aria-label={`Administrator password for ${machine.name}`}
            />
          </div>
        )}
        {error && <div className="machine-sheet-error">{error}</div>}
        <div className="machine-sheet-actions">
          <button className="btn-pill soft" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {remote && error && (
            <button className="btn-pill soft" disabled={busy} onClick={() => void run(false)}>
              Remove here only
            </button>
          )}
          <button className="btn-pill primary" disabled={!plan || busy} onClick={() => void run(remote)}>
            Remove
          </button>
        </div>
      </div>
    </Modal>
  );
}
