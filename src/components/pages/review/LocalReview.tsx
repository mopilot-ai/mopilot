// Local uncommitted, branch, commit and custom-target review controls.

import { useEffect, useState } from 'react';
import { useStore, toast } from '../../../store/core';
import { startReview } from '../../../store/actions';
import { currentCwdForNewChat } from '../../../store/projects';
import { errorText, ignoring } from '../../../lib/ignored';
import { native } from '../../../lib/native';
import { basename } from '../../../lib/paths';
import { GitPullRequestArrow, GitBranch, GitCommitHorizontal, FileDiff, MessageSquareText, Spinner, GitMerge } from '../../ui/icons';
import type { ReviewTarget } from '../../../protocol/v2/ReviewTarget';

/* Review of local changes (uncommitted / branch / commit / custom) */
export function LocalReview() {
  useStore((s) => s.newChatProjectId);
  const cwd = currentCwdForNewChat();
  const [target, setTarget] = useState<'uncommittedChanges' | 'baseBranch' | 'commit' | 'custom'>('uncommittedChanges');
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState('main');
  const [commits, setCommits] = useState<{ sha: string; title: string }[]>([]);
  const [commit, setCommit] = useState('');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // the folder can change while git answers: only the current one's branches and commits show
    let live = true;
    native.git.info(cwd).then((g) => {
      if (!live) return;
      setBranches(g?.branches ?? []);
      if (g?.branches.includes('main')) setBase('main');
      else if (g?.branches.includes('master')) setBase('master');
      // unreadable: the branch list stays empty, and the other targets still work
    }, ignoring("list the folder's branches for a review"));
    native.git.run(cwd, ['log', '--format=%H%x09%s', '-n', '20']).then((r) => {
      if (!live) return;
      const list = r.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [sha, ...t] = l.split('\t');
          return { sha, title: t.join('\t') };
        });
      setCommits(list);
      if (list[0]) setCommit(list[0].sha);
      // unreadable: the commit list stays empty, and the other targets still work
    }, ignoring("list the folder's recent commits for a review"));
    return () => {
      live = false;
    };
  }, [cwd]);
  const start = async () => {
    setBusy(true);
    try {
      const t: ReviewTarget =
        target === 'uncommittedChanges'
          ? { type: 'uncommittedChanges' }
          : target === 'baseBranch'
            ? { type: 'baseBranch', branch: base }
            : target === 'commit'
              ? { type: 'commit', sha: commit, title: commits.find((c) => c.sha === commit)?.title ?? null }
              : { type: 'custom', instructions: custom };
      await startReview(null, t);
    } catch (e) {
      toast(errorText(e), 'error');
    }
    setBusy(false);
  };
  const options = [
    {
      id: 'uncommittedChanges',
      icon: <FileDiff size={18} />,
      title: 'Uncommitted changes',
      desc: 'Staged, unstaged and untracked changes',
    },
    { id: 'baseBranch', icon: <GitBranch size={18} />, title: 'Against a base branch', desc: 'The diff between this branch and another' },
    { id: 'commit', icon: <GitCommitHorizontal size={18} />, title: 'A commit', desc: 'The changes introduced by one commit' },
    {
      id: 'custom',
      icon: <MessageSquareText size={18} />,
      title: 'Custom instructions',
      desc: 'Tell the reviewer exactly what to look for',
    },
  ] as const;
  return (
    <div className="local-review">
      <span className="sched-empty-icon">
        <GitMerge size={30} strokeWidth={1.4} />
      </span>
      <div className="sched-empty-title">Review changes</div>
      <div className="sched-empty-sub">Pick a pull request on the left, or review local changes in {basename(cwd)}.</div>
      <div className="review-options">
        {options.map((o) => (
          <button key={o.id} className={`review-option ${target === o.id ? 'on' : ''}`} onClick={() => setTarget(o.id)}>
            <span className="review-option-icon">{o.icon}</span>
            <span className="review-option-title">{o.title}</span>
            <span className="review-option-desc">{o.desc}</span>
          </button>
        ))}
      </div>
      {target === 'baseBranch' && (
        <select className="text-input" value={base} onChange={(e) => setBase(e.target.value)}>
          {branches.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      )}
      {target === 'commit' && (
        <select className="text-input" value={commit} onChange={(e) => setCommit(e.target.value)}>
          {commits.map((c) => (
            <option key={c.sha} value={c.sha}>
              {c.sha.slice(0, 7)} {c.title}
            </option>
          ))}
        </select>
      )}
      {target === 'custom' && (
        <textarea
          className="text-area"
          rows={4}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Review the auth middleware for security issues"
        />
      )}
      <button className="btn primary sm" disabled={busy || (target === 'custom' && !custom.trim())} onClick={start}>
        {busy ? <Spinner size={13} /> : <GitPullRequestArrow size={14} />} Start review
      </button>
    </div>
  );
}
