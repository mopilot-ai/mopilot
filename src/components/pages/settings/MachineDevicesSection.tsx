// A machine page's Devices: every client the Host knows ("Work MacBook Pro · this Mac", "Pocket iPhone · added 3 Nov"). A phone has the switch "Use from <phone>"; any device but this Mac has Remove, which asks first (naming the device and what happens) and then the Host acts on at once. A device removed from the list is gone before the Host's answer is drawn again.
import { useState } from 'react';
import { toast } from '../../../store/core';
import type { MachineDevice } from '../../../lib/machinePageData';
import { removeDevice, setPhoneDirect } from '../../../lib/machinePageData';
import { userError } from '../../../../shared/userError.mjs';
import { Modal } from '../../ui/Modal';
import { Group, Row, Toggle } from './Controls';

const when = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** The line under a device's name. */
export const deviceLine = (d: MachineDevice): string =>
  d.thisMac ? `${d.name} · this Mac` : d.addedAt ? `${d.name} · added ${when(d.addedAt)}` : d.name;

export function MachineDevicesSection({
  machineId,
  machineName,
  devices,
}: {
  machineId: string;
  machineName: string;
  devices: MachineDevice[];
}) {
  // the device whose Remove was pressed: it goes only after the owner confirms
  const [asked, setAsked] = useState<MachineDevice | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [direct, setDirect] = useState<ReadonlyMap<string, boolean>>(new Map());
  const fail = (e: unknown) => toast(userError(e), 'error');
  const remove = async (d: MachineDevice) => {
    setGone((s) => new Set(s).add(d.id));
    try {
      await removeDevice(machineId, d.id);
    } catch (e) {
      setGone((s) => {
        const next = new Set(s);
        next.delete(d.id);
        return next;
      });
      fail(e);
    }
  };
  return (
    <>
      <Group title="Devices">
        {devices
          .filter((d) => !gone.has(d.id))
          .map((d) => (
            <Row key={d.id} title={deviceLine(d)}>
              {d.direct && (
                <Toggle
                  label={`Use from ${d.name}`}
                  on={direct.get(d.id) ?? d.direct.state !== 'off'}
                  onChange={async (on) => {
                    setDirect((m) => new Map(m).set(d.id, on));
                    try {
                      await setPhoneDirect(machineId, d.direct!.pairId, on);
                    } catch (e) {
                      setDirect((m) => new Map(m).set(d.id, !on));
                      fail(e);
                    }
                  }}
                />
              )}
              {!d.thisMac && (
                <button className="btn-pill soft small" onClick={() => setAsked(d)} aria-label={`Remove ${d.name}`}>
                  Remove
                </button>
              )}
            </Row>
          ))}
      </Group>
      {asked && (
        <Modal title={`Remove ${asked.name}`} onClose={() => setAsked(null)}>
          <div className="machine-sheet">
            <p className="machine-sheet-lede">{`${asked.name} loses its access to ${machineName} now: its open connections close at once and it cannot reconnect.`}</p>
            <p className="machine-sheet-lede">{`It can come back only by being added again with a new pairing code. Its chats and files on ${machineName} stay where they are.`}</p>
            <div className="machine-sheet-actions">
              <button className="btn-pill soft" onClick={() => setAsked(null)}>
                Cancel
              </button>
              <button
                className="btn-pill primary"
                onClick={() => {
                  const d = asked;
                  setAsked(null);
                  void remove(d);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
