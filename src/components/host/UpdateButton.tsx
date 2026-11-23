// The Update (or Try again) button for a machine's Host: the one control Settings › My machines and a machine chat's sentences both show.
import { useState } from 'react';
import { toast } from '../../store/core';
import { native } from '../../lib/native';
import type { HostMachineRow } from '../../lib/hostMachines';
import { userError } from '../../../shared/userError.mjs';

/** The row's Update (or Try again) for a Host older than the app's: uploads the build the machine takes once it is idle; a refusal says why in a toast. */
export function UpdateButton({ machine, label }: { machine: HostMachineRow; label: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await native.host.update(machine.id);
    } catch (e) {
      toast(userError(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn-pill soft small" disabled={busy} onClick={() => void run()} aria-label={`${label} the Host on ${machine.name}`}>
      {busy ? 'Updating…' : label}
    </button>
  );
}
