// Settings › My machines › Sign out everywhere: a small red text button under the sign-in row that forgets the API keys here and, on every machine, takes the key back and signs out the agents that sign in with their own CLI; asked once more before it runs, then each machine's result on its own line.
import { useState } from 'react';
import { toast } from '../../../store/core';
import { native } from '../../../lib/native';
import type { HostSignOutResult } from '../../../lib/native/host';
import { userError } from '../../../../shared/userError.mjs';
import { agentLabel } from '../../../../shared/host/agentReadiness.mjs';

/** The agents a machine signs out with their own CLI (electron/host/signOut.cjs CLI_AGENTS), by their catalog names. */
const SIGNED_OUT = ['claude', 'codex'].map(agentLabel).join(' and ');

/** One machine's line: what was signed out, or why it was not. */
export function signOutLine(r: HostSignOutResult): string {
  if (r.state === 'offline') return `${r.name}: ${r.error ?? 'not reached'}`;
  const out = r.agents.filter((a) => a.signedOut).map((a) => a.label);
  const left = r.agents.filter((a) => !a.signedOut).map((a) => `${a.label}: ${a.error}`);
  const parts = [out.length ? `${out.join(' and ')} signed out` : '', ...left, r.error ?? ''].filter(Boolean);
  return `${r.name}: ${parts.join('. ') || 'nothing was signed in'}`;
}

export function HostSignOut({ onSignedOut }: { onSignedOut: () => void }) {
  const [asking, setAsking] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<HostSignOutResult[] | null>(null);
  const run = async () => {
    setAsking(false);
    setRunning(true);
    try {
      setResults(await native.host.signOutEverywhere());
      onSignedOut();
    } catch (e) {
      toast(userError(e), 'error');
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="machines-foot">
      {asking ? (
        <div className="signout-ask" role="group" aria-label="Sign out everywhere">
          <span>Removes your API keys here and signs {SIGNED_OUT} out on every machine.</span>
          <button className="btn-pill soft small" onClick={() => setAsking(false)}>
            Cancel
          </button>
          <button className="btn-pill danger small" onClick={() => void run()}>
            Sign out
          </button>
        </div>
      ) : (
        <button className="link-danger" disabled={running} onClick={() => setAsking(true)}>
          {running ? 'Signing out…' : 'Sign out everywhere'}
        </button>
      )}
      {results && (
        <ul className="host-signout-results" aria-label="Sign out results">
          {results.length === 0 ? (
            <li>No machines.</li>
          ) : (
            results.map((r) => (
              <li key={r.id} className={`host-signout ${r.state}`}>
                {signOutLine(r)}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
