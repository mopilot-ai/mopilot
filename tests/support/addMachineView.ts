// Renders Settings › Machines together with the one app-level Add a machine sheet (AddMachineDialog), which its Add machine button opens through the store.
import { render, act } from './settings-harness.ts';

/** Call after `setup()`: HostMachines beside AddMachineDialog, the sheet closed again when the view unmounts. */
export async function renderMachines(props: Record<string, unknown> = {}) {
  const { createElement: h, Fragment } = await import('react');
  const { HostMachines } = await import('../../src/components/pages/settings/HostMachines.tsx');
  const { AddMachineDialog } = await import('../../src/components/pages/settings/AddMachineDialog.tsx');
  const { closeAddMachine } = await import('../../src/lib/addMachine.ts');
  const view = await render(h(Fragment, null, h(HostMachines, props), h(AddMachineDialog)));
  return {
    ...view,
    unmount: async () => {
      await act(() => closeAddMachine());
      await view.unmount();
    },
  };
}
