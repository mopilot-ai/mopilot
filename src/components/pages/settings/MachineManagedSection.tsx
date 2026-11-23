// A machine page's Managed: "Managed by <organization>" and the settings it fixes, each shown locked in its own section too. Absent for a person.
import type { MachineManaged } from '../../../lib/machinePageData';
import { Group, Row } from './Controls';

export const LOCKED_TITLE: Record<string, string> = {
  permissionMax: 'Most a chat may do',
  approvals: 'Pause a run after',
  notify: 'Notifications',
  spend: 'Spending limits',
};

export function MachineManagedSection({ managed }: { managed: MachineManaged }) {
  return (
    <Group title="Managed">
      <Row title={`Managed by ${managed.org}`} />
      {managed.locked.map((key) => (
        <Row key={key} title={LOCKED_TITLE[key] ?? key} desc="Locked" />
      ))}
    </Group>
  );
}
