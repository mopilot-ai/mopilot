// Settings → Connections: SSH hosts.

import { Group, Row } from './Controls';
import { isWin } from '../../../lib/platform';
import { SquareTerminal, Trash2 } from '../../ui/icons';
import { useState } from 'react';
import { useStore, setPrefs, toast } from '../../../store/core';
import { navigate, openPaneTab } from '../../../store/panes';
import { Tooltip } from '../../ui/Popover';
import { isEnter } from '../../../lib/focus';
import { useHostMachines } from '../../../lib/hostMachines';

/** The Host machine id a saved ssh target becomes (electron/host/machines.cjs). */
export const sshMachineId = (target: string) => `ssh:${target}`;

/** Open `ssh <target>` in a terminal tab. */
export function openSshTerminal(target: string) {
  openPaneTab('terminal', { title: target, cwd: useStore.getState().home ?? '/', command: [isWin ? 'ssh.exe' : '/usr/bin/ssh', target] });
  navigate({ name: 'home' });
}

/** Saved SSH hosts; opening one starts `ssh <host>` in a terminal tab. */
export function SshConnections() {
  const prefs = useStore((s) => s.prefs);
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState('');
  const hosts = prefs.sshHosts ?? [];
  // a target that is also a Host machine is listed once, under My machines
  const { machines } = useHostMachines();
  const asMachine = new Set(machines.map((m) => m.id));
  const plain = hosts.filter((h) => !asMachine.has(sshMachineId(h)));
  const add = () => {
    const h = host.trim();
    if (!/^[\w.@:-]+$/.test(h)) return toast('Enter a host like user@example.com', 'error');
    setPrefs({ sshHosts: [...new Set([...hosts, h])] });
    setHost('');
    setAdding(false);
  };
  return (
    <Group title="SSH connections from this Mac">
      {plain.map((h) => (
        <Row key={h} title={h} desc="SSH">
          <button className="btn-pill soft" onClick={() => openSshTerminal(h)}>
            Connect
          </button>
          <Tooltip label="Remove">
            <button className="icon-btn xs" onClick={() => setPrefs({ sshHosts: hosts.filter((x) => x !== h) })} aria-label="Remove">
              <Trash2 size={14} />
            </button>
          </Tooltip>
        </Row>
      ))}
      {adding ? (
        <Row title="Host">
          <input
            className="text-input slim wide"
            autoFocus
            placeholder="user@example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => isEnter(e) && add()}
          />
          <button className="btn-pill soft" onClick={add}>
            Save
          </button>
        </Row>
      ) : (
        !hosts.length && (
          <div className="connections-empty">
            <span className="conn-icons">
              <SquareTerminal size={20} strokeWidth={1.5} />
            </span>
            <div>Connect to a remote device through SSH connection</div>
            <button className="btn-white" onClick={() => setAdding(true)}>
              Add
            </button>
          </div>
        )
      )}
      {hosts.length > 0 && !adding && (
        <Row title="Add another host">
          <button className="btn-pill soft" onClick={() => setAdding(true)}>
            Add
          </button>
        </Row>
      )}
    </Group>
  );
}
