// The welcome page's Conductor row: shown only on a machine with Conductor workspaces, it brings them over in place (the same import as Settings → Git).
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)

import { FolderInput } from 'lucide-react';
import { failures, importedText, pending, pendingText } from '../../lib/conductorImport';
import { Spinner } from '../ui/icons';
import { useConductorImport } from './settings/ConductorImport';

/** Nothing unless Conductor left workspaces here; else Import and how much, then what the import did. */
export function WelcomeConductor() {
  const { found, busy, done, run } = useConductorImport();
  const repos = pending(found);
  const failed = failures(done);
  // after an import with failures the row keeps what it did and why, whether or not anything is left to try again
  const said =
    done && (failed.length || !repos.length)
      ? importedText(done)
      : repos.length
        ? `${pendingText(repos)}. They open where they are, on their own branches.`
        : null;
  if (said === null) return null;
  return (
    <>
      <p className="welcome-optional" id="welcome-conductor">
        Coming from Conductor
      </p>
      <div className="welcome-list" role="list" aria-labelledby="welcome-conductor">
        <div className="welcome-row" role="listitem" data-testid="welcome-conductor">
          <div className="welcome-row-head">
            <FolderInput size={18} />
            <span className="welcome-row-label">Bring your workspaces</span>
            {repos.length ? (
              <button type="button" className="btn-pill" aria-label="Import" aria-busy={busy} disabled={busy} onClick={() => run()}>
                {busy ? <Spinner size={12} /> : 'Import'}
              </button>
            ) : (
              !failed.length && <span className="welcome-row-state">Done</span>
            )}
          </div>
          <p className="login-hint welcome-row-hint">{said}</p>
          {failed.map((f) => (
            <p key={f.path} className="welcome-row-error" role="alert">
              {f.name}: {f.error}
            </p>
          ))}
        </div>
      </div>
    </>
  );
}
