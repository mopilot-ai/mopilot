// The harness picker's quiet note that a harness has an update ("Update available: 2.1.302"): secondary text only,
// picking the harness still works. Settings → All harnesses runs it.
import { useVersionOf } from '../../harness/harnessUpdates';

export function UpdateAvailable({ kind }: { kind: string }) {
  const v = useVersionOf(kind);
  if (!v?.updatable || v.state !== 'idle') return null;
  return <span className="menu-desc hp-update">Update available: {v.latest}</span>;
}
