// The workspace, repository, context and activity of the chat in the session rail.
import { lazy, Suspense, useMemo, useState } from 'react';
import { set as setState, useStore } from '../../store/core';
import { showPanel } from '../../store/shellPanels';
import { openPlanPane } from '../../store/plans/pane';
import { openSessionPane } from '../../store/outputs/pane';
import { currentNativeId } from '../../harness/ownership';
import { openPath, showInFinder } from '../../session/open';
import { openAppLabel } from '../../lib/openApps';
import { basename, codexWorktreeRepo, foldClaudeWorktree } from '../../lib/paths';
import { repoOfRemote } from '../../lib/machinePullRequest';
import { sshTargetOf } from '../../lib/machineShell';
import { useLocalFolder } from '../../lib/chatMachine';
import { useRemoteRepo } from '../../lib/hostRepo';
import { AppIcon } from '../titleBar/OpenInApps';
import { Menu, MenuItem, useAnchor } from '../ui/Popover';
import {
  ChartColumn,
  Ellipsis,
  Files,
  Folder,
  FolderSearch,
  GitBranch,
  GitPullRequest,
  ListChecks,
  RefreshCw,
  Terminal,
} from '../ui/icons';
import { SummaryActivity } from './SummaryActivity';
import { SummaryBranchChanges } from './SummaryChanges';
import { SummaryContext } from './SummaryContext';
import { SummaryMachine, SummaryRemoteControl } from './SummaryEnvironment';
import { SummaryPhone } from './SummaryPhone';
import { SummaryRemoteRepo } from './SummaryRemoteRepo';
import { SummarySources } from './SummarySources';
import { PullRequestRow } from './PullRequestRow';
import { useLocalSummaryRepo } from './useLocalSummaryRepo';

const SummaryPullRequests = lazy(() => import('./SummaryPullRequests').then((m) => ({ default: m.SummaryPullRequests })));

export function SummaryPanel({ threadId }: { threadId: string }) {
  return <ChatSummary key={threadId} threadId={threadId} />;
}

function ChatSummary({ threadId }: { threadId: string }) {
  const chatCwd = useStore((s) => s.threads[threadId]?.cwd ?? '');
  const worktreeOf = useStore((s) => s.worktreeOf?.[threadId]);
  const location = useLocalFolder(threadId, chatCwd);
  const { cwd, machine, pending } = location;
  // Streamed item deltas leave these repository refresh triggers alone.
  const turnCount = useStore((s) => s.runtime[threadId]?.turns.length ?? 0);
  const lastDiff = useStore((s) => s.runtime[threadId]?.turns.at(-1)?.diff);
  const lastStatus = useStore((s) => s.runtime[threadId]?.turns.at(-1)?.status);
  const running = useStore((s) => !!s.runtime[threadId]?.activeTurnId);
  const turn = useMemo(() => ({ turnCount, lastDiff, lastStatus, running }), [turnCount, lastDiff, lastStatus, running]);
  const local = useLocalSummaryRepo(location, turn, running);
  const remote = useRemoteRepo(machine, chatCwd, turn);
  const nativeId = useStore((s) => currentNativeId(s.segments?.[threadId], threadId));
  const openDestination = useStore((s) => s.prefs.openDestination);
  const [tracking, setTracking] = useState(false);
  const menu = useAnchor();

  const hostRepo = remote.repo?.state === 'ready' ? remote.repo : null;
  const branch = machine ? hostRepo?.branch : local.git?.branch;
  const checkout = local.git?.root || chatCwd;
  const project = machine
    ? basename(repoOfRemote(hostRepo?.remote) ?? chatCwd)
    : worktreeOf && cwd
      ? basename(worktreeOf)
      : (codexWorktreeRepo(checkout) ?? basename(foldClaudeWorktree(checkout)));

  return (
    <section className="summary-panel" aria-label="Session details">
      <header className="summary-header" aria-label="Environment">
        <div className="summary-identity">
          <Folder size={16} className="summary-folder" aria-hidden="true" />
          <span className={chatCwd ? 'summary-project' : 'summary-project none'} title={chatCwd}>
            {project || 'No folder'}
          </span>
          <button
            type="button"
            ref={menu.ref}
            className="icon-btn xs"
            title="More"
            aria-label="Session actions"
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={menu.toggle}
          >
            <Ellipsis size={16} />
          </button>
        </div>
        <SummaryMachine machine={machine} pending={pending} />
        {branch && (
          <span className="summary-branch" title={branch}>
            <GitBranch size={13} aria-hidden="true" />
            <span className="summary-label">{branch}</span>
          </span>
        )}
        {!machine && !pending && <SummaryRemoteControl key={nativeId} threadId={threadId} />}
      </header>
      <section className="summary-group summary-changes" aria-label="Changes">
        {machine && chatCwd && <SummaryRemoteRepo machine={machine} repo={remote.repo} />}
        {!machine && !pending && (
          <>
            {(local.git || local.failed) && <SummaryBranchChanges totals={local.totals} failed={local.failed} />}
            <PullRequestRow
              chatId={threadId}
              checkoutVersion={local.checkoutVersion}
              hasRemote={!!local.git?.remote}
              branchPr={local.pr}
              entering={tracking}
              setEntering={setTracking}
              retryLookup={() => void local.refresh()}
            />
          </>
        )}
      </section>
      <Suspense fallback={null}>
        <SummaryPullRequests threadId={threadId} />
      </Suspense>
      <SummaryActivity threadId={threadId} />
      <SummaryContext threadId={threadId} />
      <SummarySources threadId={threadId} />
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={220}>
        {cwd && (
          <MenuItem icon={<FolderSearch size={15} />} onSelect={() => showInFinder(cwd)}>
            Open in Finder
          </MenuItem>
        )}
        {cwd && openDestination !== 'finder' && (
          <MenuItem icon={<AppIcon id={openDestination} />} onSelect={() => openPath(cwd)}>
            Open in {openAppLabel(openDestination)}
          </MenuItem>
        )}
        {!pending && (!machine || sshTargetOf(machine.id)) && (
          <MenuItem icon={<Terminal size={15} />} onSelect={() => setState({ bottomPanelOpen: true })}>
            Open terminal
          </MenuItem>
        )}
        <MenuItem icon={<ListChecks size={15} />} onSelect={() => openPlanPane(threadId)}>
          View plan
        </MenuItem>
        <MenuItem icon={<Files size={15} />} onSelect={() => openSessionPane(threadId, 'outputs')}>
          Outputs
        </MenuItem>
        <MenuItem icon={<ChartColumn size={15} />} onSelect={() => openSessionPane(threadId, 'usage')}>
          Usage
        </MenuItem>
        <SummaryPhone />
        {!machine && !pending && (
          <MenuItem icon={<GitPullRequest size={15} />} onSelect={() => setTracking(true)}>
            Track pull request…
          </MenuItem>
        )}
        {chatCwd && !pending && !machine?.away && (
          <MenuItem icon={<RefreshCw size={15} />} onSelect={() => (machine ? remote.refresh() : void local.refresh())}>
            Refresh
          </MenuItem>
        )}
        <MenuItem onSelect={() => showPanel('summary', false)}>Hide summary</MenuItem>
      </Menu>
    </section>
  );
}
