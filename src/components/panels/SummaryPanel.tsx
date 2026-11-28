// The workspace, repository, context and activity of the chat in the session rail.
import { Fragment, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { set as setState, useStore } from '../../store/core';
import { showPanel } from '../../store/shellPanels';
import { openPlanPane } from '../../store/plans/pane';
import { openSessionPane } from '../../store/outputs/pane';
import { currentNativeId } from '../../harness/ownership';
import { openPath, showInFinder } from '../../session/open';
import { openAppLabel } from '../../lib/openApps';
import { pluralize } from '../../lib/format';
import { abbreviateHome, basename, codexWorktreeRepo, dirname, foldClaudeWorktree } from '../../lib/paths';
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
import { SummaryBackgroundTasks } from './SummaryBackgroundTasks';
import { SummaryGoal } from './SummaryGoal';
import { SummaryOutputs } from './SummaryOutputs';
import { SummaryServers } from './SummaryServers';
import { SummaryBranchChanges } from './SummaryChanges';
import { SummaryBranchSync } from './SummaryBranchSync';
import { SummaryConnectors } from './SummaryConnectors';
import { SummaryContext } from './SummaryContext';
import { SummaryMachine, SummaryRemoteControl } from './SummaryEnvironment';
import { SummaryPhone } from './SummaryPhone';
import { SummaryRemoteRepo } from './SummaryRemoteRepo';
import { SummarySources } from './SummarySources';
import { PullRequestRow } from './PullRequestRow';
import { RailSection } from './RailSection';
import { sectionHidden, setSectionOpenFor, useSectionOrder, type RailSectionId } from '../../store/railSections';
import { useLocalSummaryRepo } from './useLocalSummaryRepo';

const SummaryPullRequests = lazy(() => import('./SummaryPullRequests').then((m) => ({ default: m.SummaryPullRequests })));

export function SummaryPanel({ threadId }: { threadId: string }) {
  return <ChatSummary key={threadId} threadId={threadId} />;
}

function ChatSummary({ threadId }: { threadId: string }) {
  const chatCwd = useStore((s) => s.threads[threadId]?.cwd ?? '');
  const worktreeOf = useStore((s) => s.worktreeOf?.[threadId]);
  const location = useLocalFolder(threadId, chatCwd, true);
  const { cwd, machine, pending, ownerUnavailable } = location;
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
  const [prCount, setPrCount] = useState(0);
  // the branch's own pull request counts when the list does not track it
  const shownPrs = prCount || (local.pr && typeof local.pr === 'object' ? 1 : 0);
  const menu = useAnchor();
  const changesHidden = useStore((s) => sectionHidden(s.prefs, 'changes'));
  const order = useSectionOrder();

  const hostRepo = remote.repo?.state === 'ready' ? remote.repo : null;
  const branch = machine ? hostRepo?.branch : local.git?.branch;
  const checkout = local.git?.root || chatCwd;
  const folded = foldClaudeWorktree(checkout);
  const managedProject = codexWorktreeRepo(checkout);
  const projectPath = cwd && worktreeOf ? worktreeOf : folded;
  const project = machine
    ? basename(repoOfRemote(hostRepo?.remote) ?? chatCwd)
    : ((cwd && worktreeOf ? null : managedProject) ?? basename(projectPath));
  const isWorktree = !!(worktreeOf || managedProject || folded !== checkout);
  const parent = chatCwd && abbreviateHome(dirname(projectPath));

  // each section by its id, drawn in the order the user left them (store/railSections.ts)
  const sections: Record<RailSectionId, ReactNode> = {
    environment: (
      <RailSection
        chatId={threadId}
        id="environment"
        className="summary-environment"
        summary={project || 'No folder'}
        // the session's actions stay reachable while Environment is folded
        trailing={
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
        }
      >
        <div className="summary-environment-row">
          <SummaryMachine machine={machine} pending={pending} unavailable={ownerUnavailable} />
        </div>
        <div className="summary-environment-row" title={chatCwd}>
          <Folder size={15} className="summary-folder" aria-hidden="true" />
          <span className={chatCwd ? 'summary-project' : 'summary-project none'} title={chatCwd}>
            {project || 'No folder'}
          </span>
          {parent && <span className="summary-path">· {parent}</span>}
        </div>
        {branch && (
          <span className="summary-branch" title={branch}>
            <GitBranch size={15} aria-hidden="true" />
            <span className="summary-label">{branch}</span>
            {isWorktree && <span className="summary-hint">Worktree</span>}
          </span>
        )}
        {!machine && !pending && <SummaryRemoteControl key={nativeId} threadId={threadId} />}
      </RailSection>
    ),
    goal: <SummaryGoal threadId={threadId} />,
    context: <SummaryContext threadId={threadId} />,
    connectors: (
      <SummaryConnectors
        chatId={threadId}
        cwd={chatCwd}
        location={ownerUnavailable ? 'workspaceUnavailable' : pending ? 'pending' : machine ? 'remote' : 'local'}
      />
    ),
    // a chat on this Mac waits for git, so a file in its repository never flashes into Outputs; a machine's has no root here
    outputs: (
      <SummaryOutputs
        threadId={threadId}
        // a machine's chat: its folder there is the checkout once the machine says it is a repository
        checkout={
          machine
            ? remote.repo?.state === 'ready'
              ? chatCwd
              : remote.repo?.state === 'loading' || !remote.repo
                ? undefined
                : null
            : local.read
              ? (local.git?.root ?? null)
              : undefined
        }
      />
    ),
    changes: (
      <RailSection
        chatId={threadId}
        id="changes"
        className="summary-changes"
        // as Claude Desktop's: what the collapsed section says is how many pull requests it holds
        summary={shownPrs ? pluralize(shownPrs, 'pull request') : undefined}
      >
        <div className="summary-change-items">
          {machine && chatCwd && <SummaryRemoteRepo machine={machine} repo={remote.repo} />}
          {!machine && !pending && (
            <>
              <PullRequestRow
                chatId={threadId}
                checkoutVersion={local.checkoutVersion}
                hasRemote={!!local.git?.remote}
                branchPr={local.pr}
                entering={tracking}
                setEntering={setTracking}
                retryLookup={() => void local.refresh()}
              />
              {local.git && <SummaryBranchSync cwd={cwd} version={`${local.checkoutVersion}:${turnCount}:${lastStatus}`} />}
              {(local.git || local.failed) && <SummaryBranchChanges totals={local.totals} failed={local.failed} />}
            </>
          )}
        </div>
        <Suspense fallback={null}>
          <SummaryPullRequests threadId={threadId} onCount={setPrCount} />
        </Suspense>
      </RailSection>
    ),
    // dev servers run on this Mac; a chat on another machine has its own there
    servers: !machine && !pending && <SummaryServers threadId={threadId} />,
    backgroundTasks: <SummaryBackgroundTasks threadId={threadId} />,
    activity: <SummaryActivity threadId={threadId} />,
    sources: <SummarySources threadId={threadId} />,
  };

  return (
    <section className="summary-panel" aria-label="Session details">
      {order.map((id) => (
        <Fragment key={id}>{sections[id]}</Fragment>
      ))}
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
        {!machine && !pending && !changesHidden && (
          <MenuItem
            icon={<GitPullRequest size={15} />}
            onSelect={() => {
              // the form is in Changes: open it for this chat so the form is seen and takes focus
              setSectionOpenFor(threadId, 'changes', true);
              setTracking(true);
            }}
          >
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
