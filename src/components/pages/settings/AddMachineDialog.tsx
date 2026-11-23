// The one Add a machine sheet of the app, mounted once: it opens from the host chip and from Settings › Machines, stays mounted while closed so an install keeps running, and hands over to New cloud machine… when that is offered.
import { useCallback, useState } from 'react';
import { closeAddMachine, openAddMachine, useAddMachineOpen } from '../../../lib/addMachine';
import { cloudOn } from '../../../lib/hostCloud';
import { useHostAccess } from '../../../lib/host';
import { AddMachineSheet } from './AddMachineSheet';
import { NewCloudMachineSheet } from './NewCloudMachineSheet';

export function AddMachineDialog() {
  const allowed = useHostAccess();
  const open = useAddMachineOpen();
  const [cloud, setCloud] = useState(false);
  const cloudIn = cloudOn();
  const toCloud = useCallback(() => (closeAddMachine(), setCloud(true)), []);
  if (!allowed) return null;
  return (
    <>
      <AddMachineSheet open={open} onOpen={openAddMachine} onClose={closeAddMachine} onCloud={cloudIn ? toCloud : undefined} />
      {cloud && <NewCloudMachineSheet onClose={() => setCloud(false)} />}
    </>
  );
}
