// The chat's sign-in card above the composer: shown only when the chat's agent is signed out on the machine the chat runs on (or the new chat was pointed at), it signs in from this Mac (the page opens in this Mac's browser, any code shows here with Copy and Open page), says how it went in plain words, names the agent new chats start on meanwhile (so no second line repeats it), and goes away once the agent is ready. Every harness reaches it the same way; the menu never signs in.
import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { userError } from '../../../shared/userError.mjs';
import { RUNNING, cancelSignin, sendSigninCode, signinKey, startSignin, useHostSignins, wantsCode } from '../../lib/hostSignin';
import { ACTION_LABEL, type SigninAction, signinStatus } from '../../lib/hostSigninCopy';
import { needsSignin } from '../../lib/machineAgents';
import { native } from '../../lib/native';
import { toast } from '../../store/core';
import { navigate } from '../../store/panes';
import { useHostAgentThere } from '../../session/useHostSigninNeed';

/**
 * @param threadId the chat, or null for the new chat (whose machine is the Run on chip's pick)
 * @param agent the chat's agent: a first-tier harness id or a basic agent's id (`host-claude` reads as Claude Code); a new chat on a machine asks for the agent its pick wants (useHostAgentChoice)
 */
export function HostSigninCard({ threadId, agent }: { threadId: string | null; agent: string | null }) {
  const need = useHostAgentThere(threadId, agent);
  const signins = useHostSignins();
  const [code, setCode] = useState('');
  const machine = need?.machine;
  const there = need?.agent;
  const view = machine && there ? signins.get(signinKey(machine.id, there.id)) : undefined;
  const running = !!view && RUNNING.has(view.state);
  // only when needed: the agent is signed out there, or a sign-in for it is still going
  // a read still under way ("Checking…") is no need for a sign-in
  if (!machine || !there || (!needsSignin(there) && !running)) return null;
  const status = signinStatus(view, there.label);
  const fail = (e: unknown) => toast(userError(e), 'error');
  const act = (action: SigninAction) => {
    if (action === 'cancel') return void cancelSignin(machine.id, there.id).catch(fail);
    if (action === 'api-key') return navigate({ name: 'settings', section: 'connections' });
    void startSignin(machine.id, there.id).catch(fail);
  };
  const submit = () => {
    const text = code.trim();
    if (!text) return;
    setCode('');
    void sendSigninCode(machine.id, there.id, text).catch(fail);
  };
  const copy = (text: string) =>
    void native.clipboard.write(text).then(
      () => toast('Code copied'),
      () => toast('Couldn’t copy the code', 'error'),
    );
  // before a sign-in starts, the line says what waits on it: the agent new chats start on meanwhile, else the send
  const idle = need.standInLabel ? `Until then, new chats start in ${need.standInLabel}` : 'Sign in to send messages here';
  const action = status?.action ?? (view?.state === 'signed-in' ? null : 'sign-in');
  return (
    <div className="host-signin-card" role="status" aria-label={`Sign in to ${there.label} on ${machine.name}`}>
      <LogIn size={16} strokeWidth={1.8} className="host-signin-icon" aria-hidden="true" />
      <div className="host-signin-text">
        <div className="host-signin-title">
          Sign in to {there.label} on {machine.name}
        </div>
        <div className="host-signin-line">
          {status ? status.text : idle}
          {status?.code && (
            <>
              <code className="host-signin-code">{status.code}</code>
              <button className="host-signin-link" onClick={() => copy(status.code as string)}>
                Copy
              </button>
            </>
          )}
        </div>
        {/* a sign-in that ended without one (failed, expired) still says where new chats go meanwhile */}
        {status && !running && view?.state !== 'signed-in' && need.standInLabel && <div className="host-signin-line">{idle}</div>}
        {status?.details && (
          <details className="host-signin-details">
            <summary>Details</summary>
            <span className="host-signin-said">{status.details}</span>
          </details>
        )}
        {wantsCode(view) && (
          <form
            className="host-signin-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste the code from the page"
              aria-label="Sign-in code"
            />
            <button type="submit" className="btn-pill" disabled={!code.trim()}>
              Send
            </button>
          </form>
        )}
      </div>
      <div className="host-signin-actions">
        {running && view?.url && (
          <button className="btn-pill ghost" onClick={() => void native.shell.openExternal(view.url as string).catch(fail)}>
            Open page
          </button>
        )}
        {action === 'cancel' ? (
          <button className="btn-pill ghost host-signin-act" onClick={() => act('cancel')}>
            {ACTION_LABEL.cancel}
          </button>
        ) : action ? (
          <button className="btn-pill primary host-signin-act" onClick={() => act(action === 'sign-in' ? 'retry' : action)}>
            {action === 'sign-in' ? 'Sign in' : ACTION_LABEL[action]}
          </button>
        ) : null}
      </div>
    </div>
  );
}
