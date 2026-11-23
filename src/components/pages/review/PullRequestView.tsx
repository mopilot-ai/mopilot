// PR overview, file diff, check results and review-discussion actions.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, toast } from '../../../store/core';
import { currentCwdForNewChat } from '../../../store/projects';
import { navigate } from '../../../store/panes';
import { startDefaultChat } from '../../../store/actions';
import { sendOrDraft } from '../../../store/send';
import { errorText } from '../../../lib/ignored';
import { openLink } from '../../../session/open';
import { withKeys } from '../../../lib/listKeys';
import { basename } from '../../../lib/paths';
import { Markdown } from '../../markdown/Markdown';
import { parseUnifiedDiff, InlineDiff } from '../../diff/DiffView';
import { GitPullRequestArrow, GitBranch, Spinner, ExternalLink, CircleCheck, CircleX, CircleDot } from '../../ui/icons';

import { gh, type PR } from './state';

/** `gh pr view --json ...`: the fields PRView reads. */
interface PRInfo {
  title: string;
  body: string;
  author?: { login: string } | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  state: string;
  mergeable: string;
  reviewDecision: string | null;
  url: string;
  /** gh's comment objects carry their GraphQL node id (checked against `gh pr view --json comments`) */
  comments: { id: string; author?: { login: string } | null; body: string }[];
}

/** `gh pr checks --json name,state,link` */
interface PRCheck {
  name: string;
  state: string;
  link?: string | null;
}

/**
 * `gh pr checks` answers a branch with no checks with exit 1 and "no checks reported on the '<branch>' branch"
 * (gh 2.92, checked against a pull request without checks); pending and failing checks still exit 0 with --json.
 * That answer is an empty list, not a failure.
 */
export const noChecksReported = (error: string) => /^no checks reported\b/i.test(error);

/** A read that failed: what it was, gh's reason, and a way to try again. */
function LoadFailed({ what, error, retry }: { what: string; error: string; retry: () => void }) {
  return (
    <div className="pr-load-failed" role="alert">
      <span>
        {what}: {error}
      </span>
      <button type="button" className="btn-pill" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

export function PRView({ pr }: { pr: PR }) {
  const [tab, setTab] = useState<'overview' | 'files' | 'checks'>('overview');
  const [info, setInfo] = useState<PRInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [checks, setChecks] = useState<PRCheck[] | null>(null);
  const [checksError, setChecksError] = useState<string | null>(null);
  const projects = useStore((s) => s.savedProjects);
  const repo = pr.repository.nameWithOwner;
  // the newest read of each kind: an answer for an older one is dropped (another pull request is another PRView)
  const reads = useRef({ info: 0, diff: 0, checks: 0 });
  const read = useCallback(
    <T,>(
      kind: 'info' | 'diff' | 'checks',
      args: string[],
      parse: (out: string) => T,
      done: (v: T) => void,
      failed: (e: string) => void,
    ) => {
      const n = ++reads.current[kind];
      gh(args)
        .then(parse)
        .then(
          (v) => reads.current[kind] === n && done(v),
          (e) => reads.current[kind] === n && failed(errorText(e)),
        );
    },
    [],
  );
  const loadInfo = useCallback(() => {
    setInfo(null);
    setInfoError(null);
    read(
      'info',
      [
        'pr',
        'view',
        String(pr.number),
        '--repo',
        repo,
        '--json',
        'title,body,author,headRefName,baseRefName,additions,deletions,changedFiles,state,mergeable,reviewDecision,url,comments',
      ],
      (o) => JSON.parse(o) as PRInfo,
      setInfo,
      setInfoError,
    );
  }, [read, pr.number, repo]);
  useEffect(() => loadInfo(), [loadInfo]);
  // the files and checks load the first time their tab opens, and again from Retry
  const loaded = useRef({ diff: false, checks: false });
  const loadDiff = () => {
    loaded.current.diff = true;
    setDiff(null);
    setDiffError(null);
    read('diff', ['pr', 'diff', String(pr.number), '--repo', repo], (o) => o, setDiff, setDiffError);
  };
  const loadChecks = () => {
    loaded.current.checks = true;
    setChecks(null);
    setChecksError(null);
    read(
      'checks',
      ['pr', 'checks', String(pr.number), '--repo', repo, '--json', 'name,state,link'],
      (o) => JSON.parse(o) as PRCheck[],
      setChecks,
      (e) => (noChecksReported(e) ? setChecks([]) : setChecksError(e)),
    );
  };
  const show = (t: typeof tab) => {
    setTab(t);
    if (t === 'files' && !loaded.current.diff) loadDiff();
    if (t === 'checks' && !loaded.current.checks) loadChecks();
  };
  const files = useMemo(() => (diff ? parseUnifiedDiff(diff) : []), [diff]);

  const reviewChat = async () => {
    // Prefer a local checkout of this repository.
    const name = pr.repository.name.toLowerCase();
    const proj = projects.find((p) => p.roots.some((r) => basename(r.path).toLowerCase() === name)) ?? null;
    const cwd = proj?.roots[0].path ?? currentCwdForNewChat();
    try {
      const id = await startDefaultChat(cwd, proj?.id ?? null);
      navigate({ name: 'thread', id });
      // one main didn't take waits in the new chat's composer
      await sendOrDraft(
        id,
        `Review pull request ${pr.url} (#${pr.number} in ${repo}). Use \`gh pr view ${pr.number} --repo ${repo}\` and \`gh pr diff ${pr.number} --repo ${repo}\` to read it. Find bugs, regressions, security issues and risky changes; list findings by severity with file and line references. Do not push or comment on GitHub.`,
      );
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return (
    <div className="pr-view">
      <div className="pr-head">
        <div className="pr-title-row">
          <h1 className="page-title">{pr.title}</h1>
          <span className="pr-num">#{pr.number}</span>
        </div>
        <div className="auto-meta">
          <span className="auto-meta-item">
            <GitPullRequestArrow size={12} /> {repo}
          </span>
          {info && (
            <>
              <span className="auto-meta-item">
                <GitBranch size={12} /> {info.headRefName} → {info.baseRefName}
              </span>
              <span>@{info.author?.login}</span>
              <span className="diff-stat">
                <span className="plus">+{info.additions}</span> <span className="minus">-{info.deletions}</span>
              </span>
              {info.reviewDecision && <span className="status-pill">{info.reviewDecision.toLowerCase().replace(/_/g, ' ')}</span>}
            </>
          )}
        </div>
        <div className="pr-actions">
          <button className="btn primary sm" onClick={reviewChat}>
            <GitPullRequestArrow size={14} /> Review in a new chat
          </button>
          <button className="btn-pill" onClick={() => openLink(pr.url)}>
            Open on GitHub <ExternalLink size={12} />
          </button>
        </div>
      </div>
      <div className="segmented tabs-seg">
        {(['overview', 'files', 'checks'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => show(t)}>
            {t === 'overview' ? 'Overview' : t === 'files' ? `Files${info ? ` ${info.changedFiles}` : ''}` : 'Checks'}
          </button>
        ))}
      </div>
      {tab === 'overview' &&
        (infoError ? (
          <LoadFailed what="Couldn't load the pull request" error={infoError} retry={loadInfo} />
        ) : info ? (
          <div className="pr-body">
            <Markdown text={info.body || '_No description provided._'} />
            {info.comments?.length > 0 && (
              <>
                <div className="task-section-label">Comments</div>
                {info.comments.map((c) => (
                  <div key={c.id} className="pr-comment">
                    <div className="pr-comment-author">@{c.author?.login}</div>
                    <Markdown text={c.body} />
                  </div>
                ))}
              </>
            )}
          </div>
        ) : (
          <div className="center-pad">
            <Spinner size={16} />
          </div>
        ))}
      {tab === 'files' &&
        (diffError ? (
          <LoadFailed what="Couldn't load the changes" error={diffError} retry={loadDiff} />
        ) : diff === null ? (
          <div className="center-pad">
            <Spinner size={16} />
          </div>
        ) : (
          <div className="pr-files">
            {files.map((f) => (
              <InlineDiff key={f.path} file={f} maxHeight={600} />
            ))}
          </div>
        ))}
      {tab === 'checks' &&
        (checksError ? (
          <LoadFailed what="Couldn't load the checks" error={checksError} retry={loadChecks} />
        ) : checks === null ? (
          <div className="center-pad">
            <Spinner size={16} />
          </div>
        ) : (
          <div className="settings-card">
            {checks.length === 0 && <div className="settings-pad settings-row-desc">No checks</div>}
            {withKeys(checks, (c) => JSON.stringify([c.name, c.link])).map(({ key, item: c }) => (
              <button key={key} className="settings-row clickable" onClick={() => c.link && openLink(c.link)}>
                {c.state === 'SUCCESS' ? (
                  <CircleCheck size={16} className="check-state ok" />
                ) : c.state === 'FAILURE' ? (
                  <CircleX size={16} className="check-state failed" />
                ) : (
                  <CircleDot size={16} className="check-state pending" />
                )}
                <div className="settings-row-text">
                  <div className="settings-row-title">{c.name}</div>
                  <div className="settings-row-desc">{c.state.toLowerCase()}</div>
                </div>
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}
