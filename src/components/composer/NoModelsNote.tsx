// The model picker's note when a machine has reported no models, said by its real cause: it is offline (Check again), its Host is out of date (the row's Update), or it has not answered yet (wait). One note for the picker's empty list and the agent flyout.
import { useState } from 'react';
import { HostUpdateAction } from '../host/HostUpdateAction';
import { native } from '../../lib/native';
import { toast } from '../../store/core';
import { userError } from '../../../shared/userError.mjs';
import type { HostMachineRow } from '../../lib/hostMachines';

/** The sentence for `machine`'s empty report; `what` names the agent when the note is for one. */
export function noModelsText(
  machine: Pick<HostMachineRow, 'status' | 'hostStale' | 'hostDiffers'> | undefined,
  name: string,
  what?: string,
): string {
  const models = what ? `models for ${what}` : 'its models';
  if (machine?.status === 'offline') return `${name} is offline, so ${models} are not shown.`;
  if (machine?.hostStale && !machine.hostDiffers)
    return `${name}'s Host is out of date and has not reported ${what ? models : 'models'}. Update the Host.`;
  return what ? `${name} has not reported models for ${what} yet.` : `Waiting for ${name} to report its models.`;
}

export function NoModelsNote({
  machine,
  hostId,
  name,
  what,
}: {
  machine: HostMachineRow | undefined;
  hostId: string;
  name: string;
  what?: string;
}) {
  const [busy, setBusy] = useState(false);
  const text = noModelsText(machine, name, what);
  const check = async () => {
    setBusy(true);
    try {
      await native.host.check();
    } catch (e) {
      toast(userError(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="menu-desc hp-note">
      {text}
      {machine?.status === 'offline' ? (
        <button type="button" className="btn-pill host-strip-action" disabled={busy} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Check again'}
        </button>
      ) : (
        <HostUpdateAction hostId={hostId} text={text} />
      )}
    </div>
  );
}
