// A cloud machine's Cloud section (host.cloud; Remote Run X6): the provider, size, region and network it was made with, Stop now, and Delete…, which names the chats that run on it first, offers to push each one's unpushed work to a branch, and says what is lost. The idle minutes and hours per day come with the Host's own setting (U2).
import { useEffect, useState } from 'react';
import { Modal } from '../../ui/Modal';
import { native } from '../../../lib/native';
import type { CloudDeletePlan, CloudRecord } from '../../../lib/native/host';
import { cloudOn } from '../../../lib/hostCloud';
import { toast } from '../../../store/core';
import { userError } from '../../../../shared/userError.mjs';

type Machine = { id: string; name: string; cloud?: CloudRecord };

/** Delete…: what is lost first, then the red Delete with the plan's token and the chats whose work is pushed first. */
function DeleteCloudSheet({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  const [plan, setPlan] = useState<CloudDeletePlan | null>(null);
  const [carry, setCarry] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    native.host.cloudPlan(machine.id).then(
      (p) => live && setPlan(p),
      (e) => live && setError(userError(e)),
    );
    return () => {
      live = false;
    };
  }, [machine.id]);
  const toggle = (chatId: string, on: boolean) =>
    setCarry((cur) => {
      const next = new Set(cur);
      if (on) next.add(chatId);
      else next.delete(chatId);
      return next;
    });
  const remove = async () => {
    // the Delete button is off until the plan is read
    const planned = plan as NonNullable<typeof plan>;
    setBusy(true);
    setError('');
    try {
      await native.host.cloudDelete(machine.id, {
        token: planned.token,
        carry: planned.chats.filter((c) => carry.has(c.chatId)).map((c) => c.chatId),
      });
      toast(`${machine.name} deleted`);
      onClose();
    } catch (e) {
      setError(userError(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Delete ${machine.name}`} onClose={onClose}>
      <div className="machine-sheet">
        <p className="machine-sheet-lede">
          {plan && plan.chats.length > 0
            ? `Delete ${machine.name}? These chats run on it: ${plan.chats.map((c) => c.title).join(', ')}.`
            : `Delete ${machine.name}?`}
        </p>
        {plan && plan.chats.length > 0 && (
          <ul className="cloud-chats" aria-label="Chats on this machine">
            {plan.chats.map((c) => (
              <li key={c.chatId} className="cloud-chat">
                <span className="cloud-chat-title">{c.title}</span>
                <label className="cloud-option">
                  <input type="checkbox" checked={carry.has(c.chatId)} onChange={(e) => toggle(c.chatId, e.target.checked)} />
                  <span>Push unpushed work to a branch first</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="machine-sheet-lede">Files that were not pushed are gone.</p>
        {error && (
          <div className="machine-sheet-error" role="alert">
            {error}
          </div>
        )}
        <div className="machine-sheet-actions">
          <button className="btn-pill soft" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn-pill danger" disabled={!plan || busy} onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function CloudMachineSection({ machine }: { machine: Machine }) {
  const [deleting, setDeleting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const cloud = machine.cloud;
  if (!cloudOn() || !cloud) return null;
  const stop = async () => {
    setStopping(true);
    try {
      await native.host.cloudStop(machine.id);
    } catch (e) {
      toast(userError(e), 'error');
    } finally {
      setStopping(false);
    }
  };
  const facts: [string, string][] = [
    ['Provider', cloud.provider],
    ['Size', cloud.size],
    ['Region', cloud.region],
    ['Network', cloud.network === 'limited' ? 'Limited' : 'Full'],
  ];
  return (
    <section className="cloud-section" aria-label="Cloud">
      <h3 className="settings-group-title">Cloud</h3>
      <dl className="cloud-facts">
        {facts.map(([k, v]) => (
          <div key={k} className="cloud-fact">
            <dt>{k}</dt>
            <dd>{v || '–'}</dd>
          </div>
        ))}
      </dl>
      <div className="machine-sheet-actions">
        <button className="btn-pill soft" disabled={stopping} onClick={() => void stop()}>
          Stop now
        </button>
        <button className="btn-pill danger outline" onClick={() => setDeleting(true)}>
          Delete…
        </button>
      </div>
      {deleting && <DeleteCloudSheet machine={machine} onClose={() => setDeleting(false)} />}
    </section>
  );
}

/** The section in a sheet, opened from the machine's row menu (Cloud…). */
export function CloudMachineSheet({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  return (
    <Modal title={machine.name} onClose={onClose}>
      <div className="machine-sheet">
        <CloudMachineSection machine={machine} />
      </div>
    </Modal>
  );
}
