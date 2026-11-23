// The strip above a started chat's composer when its machine does not answer: the machine row's own words for the state ("Restarted · disk locked", "Offline · Remote Login is off") and its one action (Check again), so the chat says what Settings › My machines says. What waits for the machine keeps its own labels in the queue ("Waiting for host").
import { useState } from 'react';
import { Server } from '../ui/icons';
import { useChatMachine } from '../../lib/chatMachine';
import { machineStatus } from '../../lib/machineStatus';
import { native } from '../../lib/native';
import { toast } from '../../store/core';
import { userError } from '../../../shared/userError.mjs';

export function HostAwayStrip({ threadId }: { threadId: string }) {
  const { machine } = useChatMachine(threadId);
  const [busy, setBusy] = useState(false);
  if (!machine?.away) return null;
  const line = machine.row ? machineStatus(machine.row, { now: Date.now(), signin: null, installing: undefined }) : null;
  const title = line ? `${machine.name} · ${line.text}` : `${machine.name} is offline`;
  // the Host is down while ssh works: starting it is the fix (the row offers the same); else the way forward is asking again
  const stopped = machine.row?.hostStopped === true;
  const check = async () => {
    setBusy(true);
    try {
      await (stopped ? native.host.startHost(machine.id) : native.host.check());
    } catch (e) {
      toast(userError(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fa-banner host-away-strip" role="status" aria-label={title}>
      <Server size={16} strokeWidth={1.8} className="fa-icon" aria-hidden="true" />
      <div className="fa-text">
        <div className="fa-title">{title}</div>
        {line?.title && <div className="fa-hint">{line.title}</div>}
      </div>
      {line?.check && (
        <button type="button" className="btn-pill host-strip-action" disabled={busy} onClick={() => void check()}>
          {busy ? (stopped ? 'Starting…' : 'Checking…') : stopped ? 'Start Host' : line.check.label}
        </button>
      )}
    </div>
  );
}
