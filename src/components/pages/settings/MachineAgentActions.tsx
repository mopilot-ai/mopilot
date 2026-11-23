// A machine row's agent controls in Settings › My machines: the sign-in the row speaks about, the code field, Open page and Cancel while a sign-in runs, and the row's one action (Sign in, Get a new code, Install) from its status line.
import { useState } from 'react';
import { toast } from '../../../store/core';
import { native } from '../../../lib/native';
import { isEnter } from '../../../lib/focus';
import type { HostMachineRow, MachineAgent } from '../../../lib/hostMachines';
import { signinAgents } from '../../../lib/machineAgents';
import type { MachineAction } from '../../../lib/machineStatus';
import { RUNNING, cancelSignin, sendSigninCode, signinKey, startSignin, wantsCode, type HostSigninView } from '../../../lib/hostSignin';
import { userError } from '../../../../shared/userError.mjs';
import { SIGNIN_WORDS } from '../../../../shared/host/signinWords.mjs';
import { INSTALL_WORDS } from '../../../../shared/host/installWords.mjs';

/**
 * Installs an agent the machine lacks (the one-click install).
 * Resolves when the install ended; a refusal rejects with the reason to show.
 */
export type InstallAgent = (machineId: string, harness: string) => Promise<unknown>;

/** The sign-in the row speaks about: one under way, else the latest that ended without signing in, among the agents still signed out. */
export function currentSignin(
  machineId: string,
  agents: readonly MachineAgent[],
  signins: ReadonlyMap<string, HostSigninView>,
): { agent: MachineAgent; view: HostSigninView } | null {
  const found = signinAgents(agents).flatMap((agent) => {
    const view = signins.get(signinKey(machineId, agent.id));
    return view && view.state !== 'signed-in' && view.state !== 'cancelled' ? [{ agent, view }] : [];
  });
  return found.find((f) => RUNNING.has(f.view.state)) ?? found[0] ?? null;
}

const fail = (e: unknown) => toast(userError(e), 'error');

/** The code a sign-in's page shows, typed back to the machine that waits for it. */
function SigninCode({ id, harness }: { id: string; harness: string }) {
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    try {
      if (await sendSigninCode(id, harness, code)) setCode('');
      else toast(SIGNIN_WORDS.ended, 'error');
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      <input
        className="text-input slim"
        placeholder={SIGNIN_WORDS.codeField}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => isEnter(e) && code.trim() && !sending && void send()}
        aria-label={SIGNIN_WORDS.codeField}
      />
      <button className="btn-pill soft small" disabled={sending || !code.trim()} onClick={() => void send()}>
        {SIGNIN_WORDS.send}
      </button>
    </>
  );
}

/** While a sign-in runs: the code field when its page asks for one, Open page, and Cancel. */
export function SigninRunning({
  machine,
  agent,
  view,
}: {
  machine: Pick<HostMachineRow, 'id' | 'name'>;
  agent: MachineAgent;
  view: HostSigninView;
}) {
  return (
    <>
      {wantsCode(view) && <SigninCode id={machine.id} harness={agent.id} />}
      {view.url && (
        <button className="btn-pill soft small" onClick={() => void native.shell.openExternal(view.url as string).catch(fail)}>
          {SIGNIN_WORDS.openPage}
        </button>
      )}
      <button
        className="btn-pill soft small"
        onClick={() => void cancelSignin(machine.id, agent.id).catch(fail)}
        aria-label={`Cancel signing in to ${agent.label} on ${machine.name}`}
      >
        {SIGNIN_WORDS.cancel}
      </button>
    </>
  );
}

/** The row's one action: start a sign-in, or install a missing agent (busy while it runs). */
export function ActionButton({
  machine,
  action,
  onInstall,
}: {
  machine: Pick<HostMachineRow, 'id' | 'name'>;
  action: MachineAction;
  onInstall: InstallAgent;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await (action.kind === 'install' ? onInstall(machine.id, action.agent.id) : startSignin(machine.id, action.agent.id));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const what = action.kind === 'install' ? 'Install' : action.expired ? `${SIGNIN_WORDS.newCode} for` : 'Sign in to';
  return (
    <button
      className="btn-pill soft small"
      disabled={busy}
      onClick={() => void run()}
      aria-label={`${what} ${action.agent.label} on ${machine.name}`}
    >
      {busy && action.kind === 'install' ? INSTALL_WORDS.installing : action.label}
    </button>
  );
}

/** The row's Check again for a machine that does not answer: asks every machine now; the line then says what it finds. */
export function CheckButton({ machine, label }: { machine: HostMachineRow; label: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await native.host.check();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn-pill soft small" disabled={busy} onClick={() => void run()} aria-label={`${label} ${machine.name}`}>
      {busy ? 'Checking…' : label}
    </button>
  );
}
