// A registry package install's shared main-owned log and Stop action, available again after closing Settings.
import { useState } from 'react';
import { native } from '../../lib/native';
import { runTransport, useRunOf } from '../../session/harness/harnessRuns';
import { TermView } from '../panels/TerminalPanel';

export function RegistryInstallOutput({ id }: { id: string }) {
  const run = useRunOf(`acp:registry-${id}`);
  const [outputOf, setOutputOf] = useState<string | null>(null);
  if (!run) return null;
  const running = run.state === 'running';
  return (
    <>
      {(running || outputOf === run.id) && (
        <div className="basic-login-term install-term">
          <TermView
            tab={{ id: run.id, cwd: '', title: run.command }}
            visible
            readOnly
            transport={runTransport(run.id)}
            onExit={() => undefined}
          />
        </div>
      )}
      <div className="install-foot">
        {running && run.stopped && <span role="status">Stopping…</span>}
        {running ? (
          <button className="btn-pill" onClick={() => void native.harnessRuns.stop(run.id)}>
            Stop
          </button>
        ) : (
          <button className="text-link" onClick={() => setOutputOf(outputOf === run.id ? null : run.id)}>
            {outputOf === run.id ? 'Hide installation output' : 'Show installation output'}
          </button>
        )}
      </div>
    </>
  );
}
