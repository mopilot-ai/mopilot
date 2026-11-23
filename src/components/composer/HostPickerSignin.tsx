// The remote account sign-in dialog opened by the model picker, following the Host's attempt for that machine and harness.
import { useRef, useState } from 'react';
import { userError } from '../../../shared/userError.mjs';
import type { HostMachineRow, MachineAgent } from '../../lib/hostMachines';
import { RUNNING, signinKey, startSignin, useHostSigninReadSettled, useHostSignins, type HostSigninView } from '../../lib/hostSignin';
import { signinStatus } from '../../lib/hostSigninCopy';
import { accountSigninAction, reportedCliLoginState } from '../../lib/machinePicker';
import { native } from '../../lib/native';
import { SigninRunning } from '../pages/settings/MachineAgentActions';
import { useFocusWhileOpen } from '../ui/MenuList';
import { Modal } from '../ui/Modal';

type SigninDialog = {
  machine: HostMachineRow;
  agent: MachineAgent;
  view: HostSigninView | undefined;
  opening: boolean;
  error: string | null;
  previousSuccess: boolean;
  check: { pending: boolean; run: () => void } | null;
  verified: boolean;
  retry: { label: string; run: () => void } | null;
  onClose: () => void;
};

type Renewal = {
  agentId: string;
  before?: HostSigninView;
  previous?: HostSigninView;
  profile?: 'checking' | 'signed-in' | 'lapsed' | 'unavailable';
  opening: boolean;
  error: string | null;
};

/** The picker is keyed to its chat and machine. Closing the dialog leaves the main-owned sign-in available to reopen. */
export function useHostPickerSignin(hostId: string, machine: HostMachineRow | undefined) {
  const signins = useHostSignins();
  const settled = useHostSigninReadSettled();
  const [request, setRequest] = useState<Renewal | null>(null);
  const agent = request && machine?.agents.find((x) => x.id === request.agentId && x.state !== 'missing');
  if (request && !agent) setRequest(null);

  const viewOf = (id: string) => signins.get(signinKey(hostId, id));
  const start = async (agentId: string) => {
    const opening: Renewal = { agentId, before: viewOf(agentId), opening: true, error: null };
    setRequest(opening);
    let error: string | null = null;
    try {
      await startSignin(hostId, agentId);
    } catch (e) {
      error = userError(e);
    }
    setRequest((current) => (current === opening ? { ...opening, opening: false, error } : current));
  };
  const open = (agentId: string) => {
    const previous = viewOf(agentId);
    if (previous) setRequest({ agentId, previous, opening: false, error: null });
    else if (settled) void start(agentId);
  };
  const available = (agentId: string) => settled || !!viewOf(agentId);
  if (!request || !agent || !machine) return { open, available, dialog: null };

  // A fresh paired read, independent of the registry's queued heartbeats, distinguishes a later lapse from stale status.
  const checkProfile = async () => {
    const checking: Renewal = { ...request, profile: 'checking', error: null };
    setRequest(checking);
    let profile: Renewal['profile'] = 'unavailable';
    let error: string | null = null;
    try {
      const state = reportedCliLoginState(await native.host.hostStatus(hostId), agent.id);
      if (state) profile = state === 'ok' ? 'signed-in' : 'lapsed';
    } catch (e) {
      error = userError(e);
    }
    setRequest((current) => (current === checking ? { ...checking, profile, error } : current));
  };
  const view = viewOf(agent.id);
  const retry = machine.status === 'offline' ? null : accountSigninAction(agent);
  const previousSuccess = view?.state === 'signed-in' && view === request.previous;
  const verified = previousSuccess && request.profile === 'signed-in';
  const check = previousSuccess && !!retry && request.profile !== 'lapsed' && !verified;
  const dialog: SigninDialog = {
    machine,
    agent,
    view: view === request.before ? undefined : view,
    opening: request.opening,
    error: request.error ?? (request.profile === 'unavailable' ? 'Couldn’t read the account status.' : null),
    previousSuccess,
    check: check ? { pending: request.profile === 'checking', run: () => void checkProfile() } : null,
    verified,
    retry: !check && !verified && retry ? { label: retry.label, run: () => void start(agent.id) } : null,
    onClose: () => setRequest(null),
  };
  return { open, available, dialog };
}

export function HostPickerSignin({ machine, agent, view, opening, error, previousSuccess, check, verified, retry, onClose }: SigninDialog) {
  const content = useRef<HTMLDivElement>(null);
  useFocusWhileOpen(content);
  const pending = opening && !view;
  const refused = !view || previousSuccess ? error : null;
  const status = signinStatus(view, agent.label);
  const line =
    refused ??
    (previousSuccess && !verified ? 'The last sign-in completed.' : status?.text) ??
    (pending ? 'Opening the sign-in page…' : 'Start the sign-in again.');
  const retryLabel = view?.state === 'signed-in' ? (previousSuccess ? retry?.label : null) : 'Try again';
  return (
    <Modal title={`Sign in to ${agent.label} on ${machine.name}`} onClose={onClose}>
      <div ref={content} tabIndex={-1} className="machine-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className={refused ? 'machine-sheet-error' : 'machine-sheet-lede'} role={refused ? 'alert' : 'status'}>
          {line}
          {status?.code && <code className="host-signin-code">{status.code}</code>}
        </div>
        {view && RUNNING.has(view.state) ? (
          <div className="machine-controls">
            <SigninRunning machine={machine} agent={agent} view={view} />
          </div>
        ) : check ? (
          <div className="machine-sheet-actions">
            <button type="button" className="btn-pill soft" disabled={check.pending} onClick={check.run}>
              {check.pending ? 'Checking…' : 'Check again'}
            </button>
          </div>
        ) : (
          !pending &&
          retry &&
          retryLabel && (
            <div className="machine-sheet-actions">
              <button type="button" className="btn-pill primary" onClick={retry.run}>
                {retryLabel}
              </button>
            </div>
          )
        )}
      </div>
    </Modal>
  );
}
