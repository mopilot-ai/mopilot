// A chat's pull request badge in the sidebar, refreshed while the chat is visible: the latest PR's state icon and, when
// the chat has several, their count, as Claude Code shows a session's (#1581); hovering shows a card listing them all.

import { useRef, useState, type RefObject } from 'react';
import { useEffectOn } from '../../lib/effects';
import { noteBadgeRead } from '../../session/perf';
import { visiblePoll } from '../../lib/visiblePoll';
import { windowIsReady, windowReady } from '../../lib/windowReady';
import { useOnScreen } from '../../lib/onScreen';
import { readPullRequest } from '../../session/pullRequestReader';
import { historyVersion, type ThreadPullRequest } from '../../lib/threadPullRequest';
import { pullRequestPresentation } from '../../lib/pullRequestIndicator';
import { useStore } from '../../store/core';
import { nativeOf } from '../../store/chats';
import { openLink } from '../../session/open';
import { Tooltip } from '../ui/Popover';
import { PullRequestIcon } from '../markdown/PullRequestIcon';
import { PullRequestList, pullRequestLabel } from '../markdown/PullRequestList';

/**
 * A row that mounts again (the list re-rendered, a project unfolded) reuses its chat's answer when that settled this recently
 * for the same folder and history: every row of a list reading again at once was hundreds of git and GitHub spawns in one
 * second, the click's own read among the waiters (#2963). The shared minute poll and any changed input still read.
 */
export const POLL_MS = 60_000;
export const REMOUNT_REUSE_MS = POLL_MS;

/**
 * `row`: the sidebar row the badge sits in. The badge reads (the chat's whole history in main, attachments, git and gh)
 * and polls only while that row is on screen: a long sidebar read every chat's history at launch, which made main's
 * heap reach gigabytes. Without one it reads at once.
 */
export function ThreadPullRequestBadge({
  threadId,
  updatedAt,
  cwd = '',
  row = null,
}: {
  threadId: string;
  updatedAt: number;
  cwd?: string;
  row?: RefObject<Element | null> | null;
}) {
  const onScreen = useOnScreen(row);
  const conn = useStore((s) => s.conn);
  const nativeId = useStore(() => nativeOf(threadId));
  // the latest completed turn's id: a streamed delta of the running turn replaces `turns` but not this
  const completed = useStore((s) => s.runtime?.[threadId]?.turns.findLast((turn) => turn.status === 'completed')?.id);
  const [result, setResult] = useState<{ id: string; cwd: string; nativeId: string; pr: ThreadPullRequest | null } | null>(null);
  // the inputs of the last read, to name what changed for the performance probe
  const last = useRef<Record<string, unknown> | null>(null);
  // read again when the chat changes or is updated, when Codex (re)connects, and when the row comes on screen
  useEffectOn([threadId, cwd, nativeId, updatedAt, conn, completed, onScreen], () => {
    // off screen: no read and no poll; the row reads when it is scrolled to or unfolded
    if (!onScreen) return;
    const inputs = { threadId, cwd, nativeId, updatedAt, conn, completed };
    const changed = last.current
      ? Object.keys(inputs).filter((k) => !Object.is(inputs[k as keyof typeof inputs], last.current![k]))
      : ['mount'];
    // nothing but the row's visibility changed: it came back on screen, and reads as a mounted row does
    if (!changed.length) changed.push('shown');
    last.current = inputs;
    let live = true;
    let busy = false;
    let again = false;
    const refresh = async (trigger = changed.join('+')) => {
      if (!live) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      noteBadgeRead(trigger);
      try {
        const pr = await readPullRequest(threadId, cwd, true, historyVersion(updatedAt, nativeId));
        if (live && !again) setResult({ id: threadId, cwd, nativeId, pr });
      } finally {
        busy = false;
        if (live && again) {
          again = false;
          void refresh('again');
        }
      }
    };
    const reuse =
      changed.length === 1 &&
      (changed[0] === 'mount' || changed[0] === 'shown') &&
      readPullRequest.known(threadId, cwd, historyVersion(updatedAt, nativeId), REMOUNT_REUSE_MS) !== undefined;
    if (!reuse) void refresh();
    // a read before the window was ready went without the chat's PR monitor binding: read again once it is
    if (!windowIsReady()) void windowReady().then(() => refresh('ready'));
    // one shared minute timer for every row, parked while hidden, staggered on focus
    const stop = visiblePoll('thread-pr-badge', POLL_MS, () => void refresh('poll'));
    return () => {
      live = false;
      stop();
    };
  });
  // a remounted row (a scroll, a switched project) shows the chat's last settled PR while its own read runs
  const pr =
    result?.id === threadId && result.cwd === cwd && result.nativeId === nativeId
      ? result.pr
      : (readPullRequest.known(threadId, cwd, historyVersion(updatedAt, nativeId)) ?? null);
  if (!pr) return null;
  const { indicator, dot } = pullRequestPresentation(pr);
  const count = pr.entries && pr.entries.length > 1 ? pr.entries.length : 0;
  const label = count ? `${count} pull requests · latest ${pullRequestLabel(pr)}` : pullRequestLabel(pr);
  return (
    <Tooltip label={<PullRequestList entries={count ? pr.entries! : [pr]} />} placement="right-start" interactive className="rich">
      <button
        className={`thread-pr-badge ${pr.state}`}
        data-indicator={indicator}
        aria-label={label}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          openLink(pr.url);
        }}
      >
        <span className="thread-pr-icon" aria-hidden="true">
          <PullRequestIcon state={pr.state} />
          {dot && <span className={`thread-pr-dot ${dot}`} />}
        </span>
        {count > 0 && <span className="thread-pr-count">{count}</span>}
      </button>
    </Tooltip>
  );
}
