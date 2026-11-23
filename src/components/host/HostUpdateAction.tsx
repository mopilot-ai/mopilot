// The Update action a machine chat shows beside a sentence that asks for the machine's Host to be updated: the machine row's own control and words (machineStatus.ts hostUpdateLine, UpdateButton.tsx), so a button appears only where the row's Update works.
import { UpdateButton } from './UpdateButton';
import { useHostMachines } from '../../lib/hostMachines';
import { asksHostUpdate, hostUpdateLine } from '../../lib/machineStatus';

/** @param text the sentence shown beside it; nothing is drawn unless it asks for an update. */
export function HostUpdateAction({ hostId, text }: { hostId: string | undefined; text: string | null | undefined }) {
  const { machines } = useHostMachines();
  const machine = machines.find((m) => m.id === hostId);
  const line = machine && asksHostUpdate(text) ? hostUpdateLine(machine) : null;
  if (!machine || !line) return null;
  if (line.update) return <UpdateButton machine={machine} label={line.update.label} />;
  // a newer Host, a machine added by command, an update under way: the row's words, not a button
  return (
    <span className="host-update-note" title={line.title}>
      {line.text}
    </span>
  );
}
