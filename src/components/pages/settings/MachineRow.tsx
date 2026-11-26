// One machine in Settings › My machines: its glyph, name and one status line (src/lib/machineStatus.ts), at most one button when the person must act, and a ⋯ menu (Sign in to another agent, Install an agent…, Open terminal, Keep running after restart on a Mac added over SSH, Rename, Remove).
import { useState } from 'react';
import { Ellipsis, Monitor } from '../../ui/icons';
import { Menu, MenuItem, MenuSeparator, Tooltip, useAnchor } from '../../ui/Popover';
import { Modal } from '../../ui/Modal';
import { toast } from '../../../store/core';
import { native } from '../../../lib/native';
import { isEnter, onActivate } from '../../../lib/focus';
import type { HostMachineRow } from '../../../lib/hostMachines';
import { needsSignin, signinAgents } from '../../../lib/machineAgents';
import { installOffers, machineStatus } from '../../../lib/machineStatus';
import { INSTALLING, type HostInstallView } from '../../../lib/hostInstall';
import { RUNNING, startSignin, type HostSigninView } from '../../../lib/hostSignin';
import { openSshTerminal } from './Connections';
import { ActionButton, CheckButton, SigninRunning, currentSignin, type InstallAgent } from './MachineAgentActions';
import { UpdateButton } from '../../host/UpdateButton';
import { KEEP_RUNNING, KeepRunningSheet } from './KeepRunningSheet';
import { RemoveSheet } from './RemoveSheet';
import { MachineDetails } from './MachineDetails';
import { CloudMachineSheet } from './CloudMachineSection';
import { cloudOn } from '../../../lib/hostCloud';
import { GIT_HOST, GIT_SIGNIN_HINT, gitSignInRowNote, type GitSignIn } from '../../../lib/hostGitSignIn';
import { userError } from '../../../../shared/userError.mjs';
import { useMachinePageFlag } from '../../../lib/machinePageData';
import { MachinePage } from './MachinePage';
import { InstallByHand } from '../../host/InstallByHand';
import { manualOffers } from '../../../../shared/host/installHelp.mjs';

const fail = (e: unknown) => toast(userError(e), 'error');

/** Rename: the name the machine is shown by everywhere (kept in the registry); a refusal keeps the sheet open with what was typed. */
function RenameSheet({ machine, onClose }: { machine: HostMachineRow; onClose: () => void }) {
  const [name, setName] = useState(machine.rawName ?? machine.name);
  const [busy, setBusy] = useState(false);
  const ready = !busy && !!name.trim();
  const save = async () => {
    setBusy(true);
    try {
      await native.host.rename(machine.id, name);
      onClose();
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };
  return (
    <Modal title="Rename machine" onClose={onClose}>
      <div className="machine-sheet">
        <input
          className="text-input"
          autoFocus
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => isEnter(e) && ready && void save()}
          aria-label="Machine name"
        />
        <div className="machine-sheet-actions">
          <button className="btn-pill soft" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-pill primary" disabled={!ready} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Install an agent…: each missing agent the machine's Host can install (Claude Code and Codex first, then the others), with its own Install: the same install the composer's note and the row's button start. */
function InstallSheet({ machine, onInstall, onClose }: { machine: HostMachineRow; onInstall: InstallAgent; onClose: () => void }) {
  return (
    <Modal title={`Install on ${machine.name}`} onClose={onClose}>
      <div className="machine-sheet">
        <div className="machine-list">
          {installOffers(machine).map((agent) => (
            <div key={agent.id} className="machine-item">
              <div className="machine-main">
                <div className="machine-name">{agent.label}</div>
              </div>
              <ActionButton machine={machine} action={{ kind: 'install', agent, label: 'Install' }} onInstall={onInstall} />
            </div>
          ))}
          {/* an agent its Host cannot install: the vendor's own command to run there, or its page */}
          {manualOffers(machine).map((agent) => (
            <div key={agent.id} className="machine-item">
              <div className="machine-main">
                <div className="machine-name">{agent.label}</div>
                <InstallByHand machine={machine} agent={agent.id} label={agent.label} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function MachineRow({
  machine,
  signins,
  installs,
  onInstall,
  now,
  gitSignIn,
}: {
  machine: HostMachineRow;
  signins: ReadonlyMap<string, HostSigninView>;
  installs: ReadonlyMap<string, HostInstallView>;
  onInstall: InstallAgent;
  now: number;
  /** whether git can sign in to github.com on the machine, when its Host said (never polled) */
  gitSignIn?: GitSignIn;
}) {
  const menu = useAnchor<HTMLButtonElement>();
  const [sheet, setSheet] = useState<'rename' | 'install' | 'keep-running' | 'remove' | 'cloud' | 'page' | 'details' | null>(null);
  // with `host.machinePage` the row opens the machine's page
  const hasPage = useMachinePageFlag();
  const online = machine.status !== 'offline';
  const signin = online ? currentSignin(machine.id, machine.agents, signins) : null;
  // an install under way on the machine says so ("Installing Codex…"); how one ended is a toast's to say
  const installing = [...installs.values()].find((v) => v.hostId === machine.id && INSTALLING.has(v.state));
  const line = machineStatus(machine, { now, signin, installing });
  const running = signin && RUNNING.has(signin.view.state) ? signin : null;
  // the agents still signed out besides the one the row's action is for: each gets its own menu item
  const otherSignins = online
    ? signinAgents(machine.agents).filter((a) => needsSignin(a) && a !== line.action?.agent && a !== running?.agent)
    : [];
  // a Mac whose Host answers over SSH can be switched; the sheet takes its administrator password
  const keepRunning = online && machine.platform === 'darwin' && machine.id.startsWith('ssh:') && machine.startsAtBoot !== 'unknown';
  return (
    <div className="machine-item">
      <div className="machine-glyph" aria-hidden="true">
        <Monitor size={17} strokeWidth={1.6} />
      </div>
      <div
        className="machine-main"
        {...(hasPage
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': `${machine.name}, open its page`,
              onClick: () => setSheet('page'),
              onKeyDown: onActivate(() => setSheet('page')),
            }
          : {})}
      >
        <div className="machine-name">{machine.name}</div>
        {/* the hint (the registry's sentence, how to allow Local Network) in the app's own tooltip, and read out with the line */}
        <Tooltip label={line.title} disabled={!line.title} placement="top">
          <div className="machine-sub" aria-description={line.title}>
            <span className={`machine-dot ${line.dot}`} aria-hidden="true" />
            <span className="machine-status">{line.text}</span>
          </div>
        </Tooltip>
        {online && gitSignIn === 'no' && (
          <Tooltip label={GIT_SIGNIN_HINT} placement="top">
            <div className="machine-sub machine-git">
              <span className="machine-dot warn" aria-hidden="true" />
              <span className="machine-status">{gitSignInRowNote(GIT_HOST)}</span>
            </div>
          </Tooltip>
        )}
      </div>
      <div className="machine-controls">
        {running ? (
          <SigninRunning machine={machine} agent={running.agent} view={running.view} />
        ) : (
          line.action && <ActionButton machine={machine} action={line.action} onInstall={onInstall} />
        )}
        {line.update && <UpdateButton machine={machine} label={line.update.label} />}
        {line.check && <CheckButton machine={machine} label={line.check.label} />}
        {line.remove && (
          <button className="btn-pill soft small" onClick={() => setSheet('remove')} aria-label={`${line.remove.label} ${machine.name}`}>
            {line.remove.label}
          </button>
        )}
        <button ref={menu.ref} className="icon-btn" onClick={menu.toggle} aria-label={`More for ${machine.name}`}>
          <Ellipsis size={16} />
        </button>
      </div>
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={210}>
        <MenuItem onSelect={() => setSheet('details')}>Details</MenuItem>
        <MenuItem onSelect={() => setSheet('rename')}>Rename</MenuItem>
        {otherSignins.map((a) => (
          <MenuItem key={a.id} onSelect={() => void startSignin(machine.id, a.id).catch(fail)}>
            Sign in to {a.label}
          </MenuItem>
        ))}
        {(installOffers(machine).length > 0 || manualOffers(machine).length > 0) && (
          <MenuItem onSelect={() => setSheet('install')}>Install an agent…</MenuItem>
        )}
        {machine.id.startsWith('ssh:') && <MenuItem onSelect={() => openSshTerminal(machine.id.slice(4))}>Open terminal</MenuItem>}
        {keepRunning && (
          <MenuItem checked={machine.startsAtBoot === 'yes'} onSelect={() => setSheet('keep-running')}>
            {KEEP_RUNNING}
          </MenuItem>
        )}
        {machine.cloud && cloudOn() && <MenuItem onSelect={() => setSheet('cloud')}>Cloud…</MenuItem>}
        <MenuSeparator />
        <MenuItem danger onSelect={() => setSheet('remove')}>
          Remove
        </MenuItem>
      </Menu>
      {sheet === 'page' && <MachinePage machine={machine} now={now} onClose={() => setSheet(null)} />}
      {sheet === 'details' && <MachineDetails machine={machine} now={now} onClose={() => setSheet(null)} />}
      {sheet === 'remove' && <RemoveSheet machine={machine} onClose={() => setSheet(null)} />}
      {sheet === 'cloud' && <CloudMachineSheet machine={machine} onClose={() => setSheet(null)} />}
      {sheet === 'rename' && <RenameSheet machine={machine} onClose={() => setSheet(null)} />}
      {sheet === 'install' && <InstallSheet machine={machine} onInstall={onInstall} onClose={() => setSheet(null)} />}
      {sheet === 'keep-running' && (
        <KeepRunningSheet machine={machine} on={machine.startsAtBoot !== 'yes'} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}
