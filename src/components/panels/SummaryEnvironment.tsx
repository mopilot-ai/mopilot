// Machine identity and the active harness's Remote Control in the rail's Environment card.
import { useState } from 'react';
import { useRemoteControlRow } from '../../session/useRemoteControlRow';
import { openLink } from '../../session/open';
import type { ChatMachine } from '../../lib/chatMachine';
import { Laptop, MonitorSmartphone, Server } from '../ui/icons';
import { Toggle } from '../pages/settings/Controls';
import { RemoteControlConfirm } from './RemoteControlConfirm';

export function SummaryMachine({
  machine,
  pending,
  unavailable,
}: {
  machine: ChatMachine | null;
  pending: boolean;
  unavailable?: boolean;
}) {
  const where = unavailable ? 'Workspace unavailable' : pending ? 'Locating workspace…' : (machine?.name ?? 'This computer');
  const Icon = machine ? Server : Laptop;
  return (
    <span className="summary-machine" title={where}>
      <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
      <span className="summary-label">{where}</span>
    </span>
  );
}

export function SummaryRemoteControl({ threadId }: { threadId: string }) {
  const row = useRemoteControlRow(threadId);
  // a switch that reaches past this chat asks before it turns on
  const [confirming, setConfirming] = useState(false);
  const canConfirm = row.visible && row.confirmOn && !row.disabled && !row.on;
  if (confirming && !canConfirm) setConfirming(false);
  if (!row.visible) return null;
  return (
    <>
      <div className="summary-row static summary-remote">
        <MonitorSmartphone size={15} strokeWidth={1.7} aria-hidden="true" />
        <span className="summary-label">Remote Control</span>
        {row.manage && row.on && (
          <button className="link-btn" onClick={row.manage}>
            Manage
          </button>
        )}
        {row.url && (
          <button className="link-btn" onClick={() => openLink(row.url!)}>
            Open
          </button>
        )}
        <Toggle
          on={row.on}
          disabled={row.disabled}
          label="Remote Control"
          onChange={(next) => (next && row.confirmOn ? setConfirming(true) : row.set(next))}
        />
      </div>
      {row.note && <p className="summary-note">{row.note}</p>}
      {confirming && canConfirm && (
        <RemoteControlConfirm
          onCancel={() => setConfirming(false)}
          onAllow={() => {
            setConfirming(false);
            row.set(true);
          }}
        />
      )}
    </>
  );
}
