// Settings → Worktrees → Import from Conductor: the workspaces Conductor left on this machine, and bringing them over in place. Also the hook the welcome page's row shares.

import { useEffect, useRef, useState } from 'react';
import { Group, Row } from './Controls';
import { Spinner } from '../../ui/icons';
import { native } from '../../../lib/native';
import { abbreviateHome } from '../../../lib/paths';
import { errorText, ignoring } from '../../../lib/ignored';
import { toast } from '../../../store/core';
import { counted, failures, importedText, pending } from '../../../lib/conductorImport';
import type { ConductorFound, ConductorImported } from '../../../lib/native/conductor';

/** Read what Conductor left on this machine; a look that fails leaves what was known. */
const look = (set: (found: ConductorFound) => void) => native.conductor.discover().then(set, ignoring("look for Conductor's workspaces"));

/**
 * What Conductor left here (null until read, and when it could not be read: there is then nothing to offer), and
 * importing it. An import adds each repository as a project and opens its workspaces where they are; main looks again
 * itself, so `only` names repositories and never a folder to open. After each attempt the machine is read again.
 */
export function useConductorImport() {
  const [found, setFound] = useState<ConductorFound | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ConductorImported | null>(null);
  useEffect(() => {
    void look(setFound);
  }, []);
  // one import at a time, and nothing is offered again until the machine has been read after it: the ref also stops
  // a second click that lands before `busy` is drawn
  const running = useRef(false);
  const run = async (only?: string[]) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const r = await native.conductor.import(only);
      setDone(r);
      toast(importedText(r), failures(r).length ? 'error' : 'info');
    } catch (e) {
      toast(errorText(e), 'error');
    }
    await look(setFound);
    running.current = false;
    setBusy(false);
  };
  return { found, busy, done, run };
}

/** Nothing on a machine with nothing from Conductor; else each repository with workspaces to bring over, then what an import left out. */
export function ConductorImport() {
  const { found, busy, done, run } = useConductorImport();
  const repos = pending(found);
  const failed = failures(done);
  const skipped = found?.skipped ?? [];
  // why folders are not offered: each reason once, and a look that stopped before the end
  const reasons = [...new Set(skipped.map((x) => x.reason)), ...(found?.truncated ? ['there are more folders than one look covers'] : [])];
  if (!repos.length && !done) return null;
  return (
    <Group
      title="Import from Conductor"
      desc="Workspaces Conductor made on this Mac. They open where they are, on their own branches, and are never deleted from here."
      action={
        repos.length > 1 && (
          <button className="btn-pill soft" aria-label="Import all" aria-busy={busy} disabled={busy} onClick={() => run()}>
            {busy ? <Spinner size={12} /> : 'Import all'}
          </button>
        )
      }
    >
      {repos.map((r) => (
        <Row key={r.repo} title={r.name} desc={`${counted(r.workspaces, 'workspace')} · ${abbreviateHome(r.repo)}`}>
          <button className="btn-pill soft" aria-label={`Import ${r.name}`} disabled={busy} onClick={() => run([r.repo])}>
            Import
          </button>
        </Row>
      ))}
      {!repos.length && <div className="connections-empty">Nothing left to import</div>}
      {failed.map((f) => (
        <Row key={f.path} title={`Couldn’t import ${f.name}`} desc={f.error} />
      ))}
      {reasons.length > 0 && (
        <Row
          title={skipped.length ? `${counted(skipped.length, 'folder')} left out` : 'Not every folder was looked at'}
          desc={reasons.join('; ')}
        />
      )}
    </Group>
  );
}
