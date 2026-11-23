// A machine's page, opened from its row in Settings › My machines: Status, Devices, Rules, Spending, Activity, Managed, in that order. A section with no data is absent, never empty; every control writes through the Host (or the owner's policy that is sent to it) and shows what came back.
import { useEffect, useState } from 'react';
import { Modal } from '../../ui/Modal';
import type { HostMachineRow } from '../../../lib/hostMachines';
import { loadMachinePage, readRules, readSpend, type MachinePageData, type OwnerDoc } from '../../../lib/machinePageData';
import { MachineStatusSection } from './MachineStatusSection';
import { MachineDevicesSection } from './MachineDevicesSection';
import { MachineRulesSection } from './MachineRulesSection';
import { MachineSpendingSection } from './MachineSpendingSection';
import { MachineActivitySection } from './MachineActivitySection';
import { MachineManagedSection } from './MachineManagedSection';

export function MachinePage({ machine, now, onClose }: { machine: HostMachineRow; now: number; onClose: () => void }) {
  const [data, setData] = useState<MachinePageData>({});
  useEffect(() => {
    let live = true;
    void loadMachinePage(machine.id).then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [machine.id]);
  // a control's write: the document main kept is what the rules show next
  const saved = (doc: OwnerDoc) =>
    setData((d) => ({
      ...d,
      ownerDoc: doc,
      rules: readRules(doc) ?? d.rules,
      spending: d.spending && readSpend({ spend: { dayUsd: d.spending.dayUsd, unpriced: d.spending.unpriced ? 1 : 0 } }, doc),
    }));
  return (
    <Modal title={machine.name} onClose={onClose}>
      <div className="machine-page">
        <MachineStatusSection machine={machine} now={now} />
        {data.devices && <MachineDevicesSection machineId={machine.id} machineName={machine.name} devices={data.devices} />}
        {data.rules && data.ownerDoc && (
          <MachineRulesSection doc={data.ownerDoc} rules={data.rules} managed={data.managed} onSaved={saved} />
        )}
        {data.spending && <MachineSpendingSection doc={data.ownerDoc} spend={data.spending} managed={data.managed} onSaved={saved} />}
        {data.activity && <MachineActivitySection name={machine.name} lines={data.activity} />}
        {data.managed && <MachineManagedSection managed={data.managed} />}
      </div>
    </Modal>
  );
}
