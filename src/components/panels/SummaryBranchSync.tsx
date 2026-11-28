// The Changes section's branch row, as Claude Desktop's: "{branch} → {upstream}", how many commits wait to be pushed and how
// far it is behind, and Push on the user's click. Read from git alone, so every harness's chat on this Mac has it.
import { useEffect, useMemo, useState } from 'react';
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { pluralize } from '../../lib/format';
import { toastFailure } from '../../store/core';
import { GitBranch } from '../ui/icons';

/** Where the branch stands against its upstream; `upstream` null when it has none yet (Push publishes it). */
export type BranchSync = { branch: string; upstream: string | null; ahead: number; behind: number };

const git = (cwd: string, args: string[]) => native.git.run(cwd, args);

/** The branch's standing, or null outside a branch (a detached head) or when git can't say. */
export async function readBranchSync(cwd: string): Promise<BranchSync | null> {
  const head = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.ok ? head.stdout.trim() : '';
  if (!branch || branch === 'HEAD') return null;
  const up = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!up.ok) return { branch, upstream: null, ahead: 0, behind: 0 };
  const counts = await git(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  const [behind, ahead] = counts.ok ? counts.stdout.trim().split(/\s+/).map(Number) : [Number.NaN, Number.NaN];
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { branch, upstream: up.stdout.trim(), ahead, behind };
}

/** What the row says under the branch: commits to push and behind, as Claude Desktop words it. */
export function syncWords(s: BranchSync): string {
  if (!s.upstream) return 'Not pushed yet';
  const parts = [s.ahead && `${pluralize(s.ahead, 'commit')} to push`, s.behind && `${s.behind} behind`].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Up to date';
}

/** `version`: a change that may have moved the branch (a turn, a refresh), so it is read again. */
export function SummaryBranchSync({ cwd, version }: { cwd: string; version: unknown }) {
  const [sync, setSync] = useState<{ cwd: string; value: BranchSync | null } | null>(null);
  const [pushing, setPushing] = useState(false);
  const [reread, setReread] = useState(0);
  // read again for a turn, a refresh or a push
  const request = useMemo(() => ({ cwd, version, reread }), [cwd, version, reread]);
  useEffect(() => {
    let current = true;
    const folder = request.cwd;
    readBranchSync(folder).then(
      (value) => current && setSync({ cwd: folder, value }),
      (error) => noteIgnored("read the branch's standing against its upstream", error),
    );
    return () => {
      current = false;
    };
  }, [request]);
  const s = sync?.cwd === cwd ? sync.value : null;
  if (!s) return null;
  const canPush = !s.upstream || s.ahead > 0;
  const push = () => {
    setPushing(true);
    // a branch with no upstream is published to origin and tracks it, as Claude Desktop's Push does
    git(cwd, s.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'])
      .then((r) => {
        if (!r.ok) throw new Error(r.stderr.trim() || `git push exited with ${r.code}`);
      })
      .catch(toastFailure(`Couldn't push ${s.branch}`))
      .finally(() => {
        setPushing(false);
        setReread((n) => n + 1);
      });
  };
  return (
    <div className="summary-task summary-branch-sync">
      <div className="summary-row static" title={s.upstream ? `${s.branch} → ${s.upstream}` : s.branch}>
        <GitBranch size={15} aria-hidden="true" />
        <span className="summary-label">{s.upstream ? `${s.branch} → ${s.upstream}` : s.branch}</span>
        <span className="summary-hint">{pushing ? 'Pushing…' : syncWords(s)}</span>
      </div>
      {canPush && (
        <button type="button" className="summary-action-btn" disabled={pushing} onClick={push}>
          Push
        </button>
      )}
    </div>
  );
}
