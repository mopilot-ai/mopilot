// The Switch host dialog's fix for a machine that cannot take the chat's agent: the same Install and Sign in controls as Settings › My machines (ActionButton, SigninRunning), fed the target machine; when it ends the dialog reads the machine again.
import { useEffect, useRef } from 'react';
import { installAndWait, installKey, installLine, useHostInstalls } from '../../lib/hostInstall';
import { RUNNING, signinKey, useHostSignins } from '../../lib/hostSignin';
import { ACTION_LABEL, signinStatus } from '../../lib/hostSigninCopy';
import type { SwitchFix } from '../../lib/hostSwitch';
import { ActionButton, SigninRunning } from '../pages/settings/MachineAgentActions';

export function SwitchHostFix({ fix, onDone }: { fix: SwitchFix; onDone: () => void }) {
  const { machine, agent, label } = fix;
  const installs = useHostInstalls();
  const signins = useHostSignins();
  const install = installs.get(installKey(machine.id, agent));
  const signin = signins.get(signinKey(machine.id, agent));
  const status = fix.kind === 'signin' ? signinStatus(signin, label) : null;
  const done = fix.kind === 'install' ? install?.state === 'installed' : signin?.state === 'signed-in';
  // the dialog's callback changes with every render: the latest one is called once per finish
  const finish = useRef(onDone);
  finish.current = onDone;
  useEffect(() => {
    if (done) finish.current();
  }, [done]);
  const there = { id: agent, label, state: fix.kind === 'install' ? ('missing' as const) : ('signin' as const), reason: '' };
  const retry = status?.action === 'retry';
  const action = {
    kind: fix.kind,
    agent: there,
    label: retry ? ACTION_LABEL.retry : fix.kind === 'install' ? `Install on ${machine.name}` : `Sign in on ${machine.name}`,
    ...(signin?.state === 'expired' && { expired: true }),
  };
  const running = !!signin && RUNNING.has(signin.state);
  const line = done ? `Checking ${machine.name}…` : fix.kind === 'install' ? installLine(install) : (status?.text ?? '');
  return (
    <div className="switch-host-fix" role="status" data-switch-fix={fix.kind}>
      {line && (
        <span>
          {line}
          {status?.code && <code className="host-signin-code"> {status.code}</code>}
        </span>
      )}
      {!done &&
        (running && signin ? (
          <SigninRunning machine={machine} agent={there} view={signin} />
        ) : (
          <ActionButton machine={machine} action={action} onInstall={installAndWait} />
        ))}
    </div>
  );
}
