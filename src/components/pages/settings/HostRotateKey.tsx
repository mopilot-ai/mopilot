// Settings › Connections › Machines: "Rotate this Mac's key", a small text button under the sign-in row. It gives every machine a new key for this Mac and then drops the old one (main: electron/host/keyRotation.cjs). A refusal names the machines that stopped it and preserves the backend’s recovery notice; a machine that did not drop the old key is named and told on the next press.
import { useState } from 'react';
import { native } from '../../../lib/native';
import { pluralize } from '../../../lib/format';
import type { HostMachineRow } from '../../../lib/hostMachines';
import { userError } from '../../../../shared/userError.mjs';

type Result = { machines: number; pending: { id: string; error: string }[] };

/** What a finished rotation says: every machine has the new key by then; some may still hold the old one (named, with why). */
export function rotateLines(r: Result, machines: readonly Pick<HostMachineRow, 'id' | 'name'>[]): string[] {
  const nameOf = (id: string) => machines.find((m) => m.id === id)?.name ?? id;
  const all = pluralize(r.machines + r.pending.length, 'machine');
  return [
    r.pending.length === 0 ? `New key on ${all}.` : `New key on ${all}; the old key is gone from ${r.machines}.`,
    ...r.pending.map((p) => `${nameOf(p.id)} still has the old key: ${p.error} Press again to retry.`),
  ];
}

export function HostRotateKey({ machines }: { machines: readonly HostMachineRow[] }) {
  const [asking, setAsking] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<{ text: string; error: boolean }[]>([]);
  const run = async () => {
    setAsking(false);
    setRunning(true);
    setLines([]);
    try {
      setLines(rotateLines(await native.host.rotateKey(), machines).map((text, i) => ({ text, error: i > 0 })));
    } catch (e) {
      setLines([{ text: userError(e), error: true }]);
    } finally {
      setRunning(false);
    }
  };
  if (machines.length === 0) return null;
  return (
    <div className="machines-foot">
      {asking ? (
        <div className="signout-ask" role="group" aria-label="Rotate this Mac's key">
          <span>Gives every machine a new key for this Mac, then drops the old one. Every machine must be online and up to date.</span>
          <button className="btn-pill soft small" onClick={() => setAsking(false)}>
            Cancel
          </button>
          <button className="btn-pill primary small" onClick={() => void run()}>
            Rotate
          </button>
        </div>
      ) : (
        <button className="link-subtle" disabled={running} onClick={() => setAsking(true)}>
          {running ? 'Rotating the key…' : 'Rotate this Mac’s key'}
        </button>
      )}
      <div role="status" aria-live="polite" aria-atomic="true" aria-label="Key rotation result">
        {lines.length > 0 && (
          <ul className="host-signout-results">
            {lines.map((l) => (
              <li key={l.text} className={l.error ? 'host-signout offline' : 'host-signout'}>
                {l.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
