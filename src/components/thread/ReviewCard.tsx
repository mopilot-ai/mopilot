// A review's result card, as Claude Code's app shows it: findings by file with status, Apply fixes and Walk through in diff; else Markdown.

import { useLinkCwd } from '../../lib/remoteFolder';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '../markdown/Markdown';
import { ChevronDown } from '../ui/icons';
import { reviewTargetLabel } from './reviewTarget';
import { StatusBadge } from '../diff/FindingBadge';
import { fileName } from '../../lib/paths';
import { isWin } from '../../lib/platform';
import { openMessageLink } from '../../session/open';
import { leftToActOn, reviewState } from '../../lib/reviewState';
import { askFixes, openFindingsWalk, rerunReview } from '../../store/reviews';
import { useStore } from '../../store/core';
import {
  findingLocation,
  findingsByFile,
  isReReport,
  outcomeSummary,
  reviewFindingsOf,
  rowLabel,
  scenarioOf,
  type FindingStatus,
  type ReviewFinding,
} from '../../../shared/reviewFindings.mjs';

/** A review result item as the card reads it. */
export interface ReviewCardSource {
  id: string;
  review: string;
  target?: { type?: string } | null;
  findings?: ReviewFinding[];
  level?: string | null;
}

/**
 * The Changes scope a review's findings are walked in: a review of uncommitted changes shows them; any other (a branch,
 * a commit, Claude Code's own /code-review, which reads the branch's diff) shows the branch's, which holds them all.
 */
const walkScope = (target: string | null) => (target === 'uncommittedChanges' ? 'uncommitted' : 'branch');

/** Rows the user opened stay open when the card mounts again (scrolling a long chat, switching chats). */
const expandedRows = new Set<string>();

/**
 * A review's result. `chatId` is the chat it ran in; `latest` marks the chat's last review, the one whose findings can be
 * fixed and walked. A re-report after fixes is one line of outcomes; text with no findings in it stays Markdown.
 */
export function ReviewCard({
  item,
  cwd,
  chatId,
  latest = false,
  running = false,
}: {
  item: ReviewCardSource;
  cwd: string;
  chatId?: string;
  latest?: boolean;
  running?: boolean;
}) {
  const target = item.target?.type ?? null;
  const list = useMemo(() => reviewFindingsOf(item), [item]);
  if (!list) {
    const label = reviewTargetLabel(target);
    return (
      <div className="review-result">
        <div className="plan-card-head">{label ? `Review · ${label}` : 'Review'}</div>
        <Markdown text={item.review} cwd={cwd} />
      </div>
    );
  }
  if (isReReport(list.findings))
    return (
      <div className="findings-outcomes">
        <span className="findings-outcomes-title">Code review</span>
        <span className="findings-meta">{outcomeSummary(list.findings) ?? 'Outcomes reported'}</span>
      </div>
    );
  return <FindingsCard reviewId={item.id} list={list} target={target} cwd={cwd} chatId={chatId} latest={latest} running={running} />;
}

function FindingsCard({
  reviewId,
  list,
  target,
  cwd,
  chatId,
  latest,
  running,
}: {
  reviewId: string;
  list: { intro: string; level: string | null; findings: ReviewFinding[] };
  target: string | null;
  cwd: string;
  chatId?: string;
  latest: boolean;
  running: boolean;
}) {
  const linkCwd = useLinkCwd(cwd);
  const turns = useStore((s) => (chatId ? s.runtime[chatId]?.turns : undefined));
  const marks = useStore((s) => (chatId ? s.reviewMarks[chatId]?.[reviewId] : undefined));
  // the target the chat's review was started on, when MoPilot started it
  const asked = useStore((s) => (chatId ? s.reviewTargets[chatId]?.type : undefined));
  const scope = walkScope(asked ?? target);
  const statuses = useMemo(
    () => reviewState(turns, reviewId, marks)?.statuses ?? list.findings.map((): FindingStatus => 'open'),
    [turns, reviewId, marks, list.findings],
  );
  const { findings, level } = list;
  const groups = useMemo(() => findingsByFile(findings), [findings]);
  const open = statuses.flatMap((st, i) => (st === 'open' ? [i] : []));
  const fixing = statuses.filter((st) => st === 'fixing').length;
  const state = !findings.length ? 'empty' : open.length ? 'actionable' : fixing ? 'applying' : 'terminal';
  // a list that is empty while its review still runs is not "nothing found": findings may yet arrive
  const none = state === 'empty' && !running;
  const count = none ? 'No issues found' : `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`;
  const actions = chatId && latest && findings.length > 0 ? chatId : null;
  // a finding dismissed or fixed is no longer in the diff: the walk starts at the first one still there
  const walk = (chat: string, index: number) => {
    const shown = leftToActOn(statuses[index]) ? index : statuses.findIndex(leftToActOn);
    openFindingsWalk(chat, reviewId, Math.max(0, shown), scope);
  };
  const fixAll = (chat: string) => {
    walk(chat, open[0]);
    askFixes(chat, reviewId, findings, open);
  };
  // a review that finishes while the chat is open shows its findings in the diff
  const wasRunning = useRef(running);
  useEffect(() => {
    const finished = wasRunning.current && !running;
    wasRunning.current = running;
    if (finished && actions && (state === 'actionable' || state === 'applying')) walk(actions, 0);
  });
  let status = '';
  if (fixing) status = `${fixing} ${fixing === 1 ? 'fix' : 'fixes'} in progress`;
  else if (state === 'terminal') status = 'Review complete';
  else if (none) status = 'Review complete, no issues found';
  return (
    <div className={none ? 'findings-card empty' : 'findings-card'}>
      <span role="status" className="sr-only">
        {status}
      </span>
      <div className="findings-head">
        <span className="findings-title">Code review</span>
        <span className="findings-meta">{level ? `${level} · ${count}` : count}</span>
        <span className="findings-grow" />
        {actions &&
          (state === 'terminal' ? (
            <button className="btn-pill ghost findings-action" onClick={() => rerunReview(actions, level)}>
              Re-run review
            </button>
          ) : (
            <button className="btn-pill ghost findings-action" disabled={state !== 'actionable'} onClick={() => fixAll(actions)}>
              Apply fixes
            </button>
          ))}
        {actions && (
          <button
            className="btn-pill findings-action"
            disabled={state !== 'actionable' && state !== 'applying'}
            onClick={() => walk(actions, 0)}
          >
            Walk through in diff
          </button>
        )}
      </div>
      {list.intro && <Markdown text={list.intro} cwd={cwd} />}
      {/* one grid for every file: badges in a column of their own, so the labels line up */}
      <div className="findings-list">
        {groups.map((group) => (
          <div className="findings-file" key={group.file}>
            <button className="findings-file-name" title={group.file} onClick={(e) => openMessageLink(group.file, linkCwd, e)}>
              {fileName(group.file, isWin) || group.file}
            </button>
            <ul className="findings-rows">
              {group.rows.map(({ finding, index }) => (
                <FindingRow
                  key={`${finding.file}:${finding.line ?? ''}:${index}`}
                  finding={finding}
                  status={statuses[index]}
                  rowKey={`${chatId ?? ''}:${reviewId}:${index}`}
                  cwd={cwd}
                  anchor={actions ? (marks?.unanchored?.includes(index) ? 'unanchored' : 'anchored') : 'unavailable'}
                  onViewInDiff={() => walk(actions as string, index)}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function FindingRow({
  finding,
  status,
  rowKey,
  cwd,
  anchor,
  onViewInDiff,
}: {
  finding: ReviewFinding;
  status: FindingStatus;
  rowKey: string;
  cwd: string;
  anchor: 'anchored' | 'unanchored' | 'unavailable';
  onViewInDiff: () => void;
}) {
  const linkCwd = useLinkCwd(cwd);
  const [open, setOpen] = useState(() => expandedRows.has(rowKey));
  const toggle = () => {
    if (open) expandedRows.delete(rowKey);
    else expandedRows.add(rowKey);
    setOpen(!open);
  };
  const scenario = scenarioOf(finding);
  const live = status === 'open' || status === 'fixing';
  return (
    <li className={status === 'open' ? 'finding' : 'finding settled'}>
      <button className="finding-row" aria-expanded={open} onClick={toggle}>
        <span className="finding-badge-cell">
          <StatusBadge finding={finding} status={status} />
        </span>
        <span className="finding-line">
          <span className="finding-label">
            <span className="sr-only">{`${findingLocation(finding)}. `}</span>
            {rowLabel(finding)}
          </span>
          <ChevronDown className={open ? 'finding-chevron open' : 'finding-chevron'} size={14} strokeWidth={1.7} />
        </span>
      </button>
      {open && (
        <div className="finding-detail">
          <span className="finding-summary">{finding.summary}</span>
          {scenario && <span className="finding-scenario">{scenario}</span>}
          <span className="finding-foot">
            <button
              className="finding-loc"
              title={findingLocation(finding)}
              onClick={(e) => openMessageLink(findingLocation(finding), linkCwd, e)}
            >
              {finding.file}
              {finding.line ? <span className="finding-loc-line">:{finding.line}</span> : null}
            </button>
            {live && anchor === 'anchored' && (
              <button className="btn-pill finding-view" onClick={onViewInDiff}>
                View in diff
              </button>
            )}
            {live && anchor === 'unanchored' && <span className="finding-badge">Not in the current diff</span>}
          </span>
        </div>
      )}
    </li>
  );
}
