// Explicit recovery for a Git operation on one remote machine; shares the Host device flow, keeps failures visible and never replays a Git command.
import { useState } from 'react';
import { KeyRound } from '../ui/icons';
import { GIT_HOST, GIT_LOGIN, gitDevicePage } from '../../../shared/host/gitLogin.mjs';
import { isLocalHostId } from '../../../shared/host/localMachine.mjs';
import { native } from '../../lib/native';
import { copyText } from '../../session/clipboard';
import { RUNNING, cancelSignin, signinKey, startSignin, useHostSignins } from '../../lib/hostSignin';
import { signinStatus } from '../../lib/hostSigninCopy';
import { gitSignInChatNote } from '../../lib/hostGitSignIn';
import { openSshTerminal } from '../pages/settings/Connections';
import type { ChatMachine } from '../../lib/chatMachine';

export function RemoteGitSignin({
  machine,
  host,
  recoveryKey,
  onOpenMachines,
}: {
  machine: ChatMachine;
  host: string;
  recoveryKey: string;
  onOpenMachines?: () => void;
}) {
  const signins = useHostSignins();
  const [error, setError] = useState('');
  if (isLocalHostId(machine.id)) return null;
  const latest = signins.get(signinKey(machine.id, GIT_LOGIN));
  const supported = host.toLowerCase() === GIT_HOST;
  const relevant = supported && latest?.recoveryKeys?.includes(recoveryKey);
  const view = relevant ? latest : undefined;
  const needsUpdate = view?.state === 'failed' && view.reason === 'host_update';
  const status = signinStatus(needsUpdate ? undefined : view, 'GitHub');
  const code = status?.code;
  const running = !!view && RUNNING.has(view.state);
  const done = view?.state === 'signed-in';
  const page = running && view?.url && gitDevicePage(view.url) ? view.url : null;
  const act = async () => {
    setError('');
    try {
      if (running) await cancelSignin(machine.id, GIT_LOGIN);
      else {
        await startSignin(machine.id, GIT_LOGIN, recoveryKey);
      }
    } catch {
      setError('Couldn’t contact the machine. Reconnect and try again.');
    }
  };
  const line = machine.away
    ? `${machine.name} is offline. Reconnect to sign in or retry.`
    : needsUpdate
      ? `The last sign-in attempt required a Host update. Check ${machine.name} in Settings › Connections › My machines for update options.`
      : view?.state === 'cancelled'
        ? 'Sign-in cancelled. You can try again.'
        : done
          ? null
          : code
            ? 'Enter this code on GitHub'
            : (status?.text ?? (supported ? null : `Sign in to ${host} on ${machine.name}, then retry the operation.`));
  const message = (!done && error) || line;
  return (
    <div className="fa-banner host-signin-card git-signin-strip" role="status" data-git-signin-note>
      <KeyRound size={16} strokeWidth={1.8} className="fa-icon" aria-hidden="true" />
      <div className="fa-text">
        <div className="fa-title">
          {done && !machine.away ? `Git is signed in to ${host} on ${machine.name}` : gitSignInChatNote(host, machine.name)}
        </div>
        {message && (
          <div className="host-signin-line">
            {message}
            {code && (
              <>
                <code className="host-signin-code">{code}</code>
                <button className="host-signin-link" onClick={() => copyText(code, 'Code copied')}>
                  Copy code
                </button>
              </>
            )}
            {page && (
              <button
                className="host-signin-link"
                onClick={() => {
                  setError('');
                  void native.shell.openExternal(page).catch(() => setError('Couldn’t open the sign-in page. Try again.'));
                }}
              >
                Open GitHub
              </button>
            )}
          </div>
        )}
        {status?.details && (
          <details className="host-signin-details">
            <summary>Details</summary>
            <span className="host-signin-said">{status.details}</span>
          </details>
        )}
      </div>
      {needsUpdate && onOpenMachines && (
        <button className="fa-dont" onClick={onOpenMachines}>
          My machines
        </button>
      )}
      {supported && !done && (
        <button className={needsUpdate ? 'host-signin-link' : 'fa-dont'} disabled={machine.away && !running} onClick={() => void act()}>
          {running ? 'Cancel' : needsUpdate ? 'Try sign-in after updating' : view ? 'Sign in again' : 'Sign in to GitHub'}
        </button>
      )}
      {!supported && machine.id.startsWith('ssh:') && (
        <button className="fa-dont" disabled={machine.away} onClick={() => openSshTerminal(machine.id.slice(4))}>
          Open remote terminal
        </button>
      )}
    </div>
  );
}
