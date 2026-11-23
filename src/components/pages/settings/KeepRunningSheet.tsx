// Keep running after restart, from a Mac's ⋯ menu in Settings › My machines: the machine's administrator password in a secure field, sent once to its sudo (electron/host/startAtBoot.cjs) and never kept, or the command to run at the machine instead. On: the Host starts at boot, before anyone signs in; off: it starts once someone signs in again.
import { useState } from 'react';
import { Modal } from '../../ui/Modal';
import { toast } from '../../../store/core';
import { native } from '../../../lib/native';
import { isEnter } from '../../../lib/focus';
import { copyText } from '../../../session/clipboard';
import type { HostMachineRow } from '../../../lib/hostMachines';
import { userError } from '../../../../shared/userError.mjs';

export const KEEP_RUNNING = 'Keep running after restart';

/** What the sheet says before the field: what changes, and FileVault's limit when it is on. */
export function keepRunningLede(machine: HostMachineRow, on: boolean): string[] {
  if (!on) return ['It will start again only after someone signs in. Needs an administrator password.'];
  return [
    'Starts before anyone signs in. Needs an administrator password once.',
    ...(machine.fileVault === 'on' ? ['FileVault is on: after a power loss, someone must unlock the disk first.'] : []),
  ];
}

/** `on`: what the change turns it to (the opposite of what the machine says now). */
export function KeepRunningSheet({ machine, on, onClose }: { machine: HostMachineRow; on: boolean; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = !busy && !!password;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await native.host.setStartAtBoot(machine.id, on, password);
      toast(on ? `${machine.name} keeps running after restart` : `${machine.name} starts after sign-in again`);
      onClose();
    } catch (e) {
      // a wrong password keeps the sheet open, the field emptied for another try
      setPassword('');
      setError(userError(e));
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      // the sheet closes once the command is on the clipboard; a failed copy says so and keeps it open
      copyText(await native.host.startAtBootCommand(machine.id), () => {
        toast('Command copied. Run it on the machine.');
        onClose();
      });
    } catch (e) {
      setError(userError(e));
    }
  };
  return (
    <Modal title={KEEP_RUNNING} onClose={onClose}>
      <div className="machine-sheet">
        {keepRunningLede(machine, on).map((line) => (
          <p key={line} className="machine-sheet-lede">
            {line}
          </p>
        ))}
        <div className="machine-sheet-field">
          <input
            className="text-input"
            type="password"
            autoComplete="off"
            autoFocus
            placeholder="Administrator password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => isEnter(e) && ready && void save()}
            aria-label={`Administrator password for ${machine.name}`}
          />
        </div>
        {error && <div className="machine-sheet-error">{error}</div>}
        <div className="machine-sheet-actions">
          {on && (
            <button className="btn-pill soft" disabled={busy} onClick={() => void copy()}>
              Copy command
            </button>
          )}
          <button className="btn-pill soft" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-pill primary" disabled={!ready} onClick={() => void save()}>
            {busy ? (on ? 'Turning on…' : 'Turning off…') : on ? 'Turn on' : 'Turn off'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
