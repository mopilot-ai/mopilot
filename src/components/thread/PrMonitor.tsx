// The tracked PR's rows in the summary panel's Changes card, as Claude Desktop shows them on its session rail: one row
// per open PR in its stack, merged and closed ones folded under "earlier pull requests", each with CI and a menu that
// holds Auto-fix and Merge (the user's click only, enabled when the shared merge gate passes).
import { type MouseEvent, type ReactNode, useState } from 'react';
import type { NativeApi } from '../../lib/native';
import type { PrMonitorState, PrParent } from '../../lib/native/prMonitor';
import { copyText } from '../../session/clipboard';
import { toast } from '../../store/core';
import { errorText } from '../../lib/ignored';
import { mergeBlock } from '../../../shared/prMergeGate.mjs';
import { Menu, MenuItem, MenuLabel, MenuSeparator, useAnchor } from '../ui/Popover';
import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Copy,
  Ellipsis,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Layers,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Spinner,
  Wrench,
} from '../ui/icons';
import { prNumber, type usePrMonitor } from './usePrMonitor';
import { PrStackPicker } from './PrStackPicker';
import styles from './prMonitor.module.css';

/** What a row's CI icon says (its tooltip and label), and its tone. */
export function prChecks(pr: Pick<PrParent, 'state' | 'failed' | 'pending'> | undefined): {
  text: string;
  tone: 'ok' | 'pending' | 'failed' | 'muted';
} {
  if (!pr) return { text: 'Checking…', tone: 'muted' };
  if (pr.state === 'MERGED') return { text: 'Merged', tone: 'muted' };
  if (pr.state === 'CLOSED') return { text: 'Closed', tone: 'muted' };
  if (pr.failed) return { text: `${pr.failed} ${pr.failed === 1 ? 'check' : 'checks'} failing`, tone: 'failed' };
  if (pr.pending) return { text: 'Checks in progress', tone: 'pending' };
  // the monitor counts failing and pending checks only, so this can't claim that any check passed
  return { text: 'No failing checks', tone: 'ok' };
}

/** The monitor's own word on what it is doing, when that is news: waiting on the chat, or auto-fix just sent. */
function monitorNote(state: PrMonitorState) {
  if (state.uncertain)
    return state.continuation
      ? 'Continuation may not have reached the chat. Check it before retrying.'
      : 'Auto-fix may not have reached the chat. Check it before retrying.';
  const m = state.message;
  return m && m !== 'Monitoring' && m !== 'Needs attention' && !m.startsWith('PR ') ? m : '';
}

/** One row: the tracked PR (with `pr` absent before its first read) or a PR it is stacked on. */
export interface PrRow {
  url: string;
  title: string;
  pr?: Pick<PrParent, 'state' | 'failed' | 'pending' | 'headRefName' | 'baseRefName'>;
  tracked: boolean;
}

const ended = (state: string | undefined) => state === 'MERGED' || state === 'CLOSED';

/**
 * The rows Claude Code's bar would show: the tracked PR first (whatever its state, it is this chat's), then the open
 * PRs it is stacked on, nearest first; merged and closed ones are the earlier pull requests. A PR the stack read
 * names twice (a base chain that loops back) is one row.
 */
export function prRows(state: PrMonitorState): { rows: PrRow[]; earlier: PrRow[] } {
  const tracked: PrRow = { url: state.url, title: state.pr?.title ?? '', pr: state.pr, tracked: true };
  const seen = new Set([state.url]);
  const parents = (state.pr?.parents ?? [])
    .filter((p) => !seen.has(p.url) && !!seen.add(p.url))
    .map((p): PrRow => ({ url: p.url, title: p.title, pr: p, tracked: false }));
  return { rows: [tracked, ...parents.filter((p) => !ended(p.pr!.state))], earlier: parents.filter((p) => ended(p.pr!.state)) };
}

/** As in Claude Code's PR bar, five rows show; the rest fold behind "Show N more". */
export const VISIBLE_ROWS = 5;

const StateIcon = ({ state }: { state?: string }) =>
  state === 'MERGED' ? (
    <GitMerge size={15} className={styles.prRowState} data-state="merged" aria-label="Merged" role="img" />
  ) : state === 'CLOSED' ? (
    <GitPullRequestClosed size={15} className={styles.prRowState} data-state="closed" aria-label="Closed" role="img" />
  ) : (
    <GitPullRequest size={15} className={styles.prRowState} data-state="open" aria-label="Open" role="img" />
  );

/** CI as one icon: its words are the tooltip and the label. A merged or closed PR's state icon already says it all. */
function CiMark({ row }: { row: PrRow }) {
  if (ended(row.pr?.state)) return null;
  const checks = prChecks(row.pr);
  const icon =
    checks.tone === 'failed' ? (
      <CircleX size={14} />
    ) : checks.tone === 'ok' ? (
      <CircleCheck size={14} />
    ) : checks.tone === 'pending' ? (
      <Spinner size={13} />
    ) : (
      <CircleDashed size={14} />
    );
  return (
    <span className={styles.prRowCi} data-tone={checks.tone} role="img" aria-label={`CI: ${checks.text}`} title={checks.text}>
      {icon}
    </span>
  );
}

type MenuAnchor = HTMLElement | { x: number; y: number };

function Row({
  row,
  open,
  onMenu,
  menuOpen,
  children,
}: {
  row: PrRow;
  open: (url: string) => void;
  onMenu: (row: PrRow, anchor: MenuAnchor) => void;
  menuOpen: boolean;
  children?: ReactNode;
}) {
  const num = prNumber(row.url);
  const branches = row.pr ? `\n${row.pr.headRefName} → ${row.pr.baseRefName}` : '';
  const context = (e: MouseEvent) => {
    e.preventDefault();
    onMenu(row, { x: e.clientX, y: e.clientY });
  };
  return (
    <li
      className={styles.prRow}
      data-tracked={row.tracked || undefined}
      data-ended={ended(row.pr?.state) || undefined}
      data-menu-open={menuOpen || undefined}
      onContextMenu={context}
    >
      <StateIcon state={row.pr?.state} />
      <button
        className={styles.prRowLink}
        title={row.title ? `${row.title}${branches}\n${row.url}` : row.url}
        aria-label={`Open pull request #${num} on GitHub`}
        onClick={() => open(row.url)}
      >
        <span className={styles.prRowNum}>#{num}</span>
        {row.title && <span className={styles.prRowTitle}>{row.title}</span>}
      </button>
      <CiMark row={row} />
      {children ?? (
        <button
          className={`icon-btn xs ${styles.prRowMore} ${menuOpen ? 'on' : ''}`}
          aria-label="Pull request options"
          aria-haspopup="menu"
          onClick={(e) => onMenu(row, e.currentTarget)}
        >
          <Ellipsis size={15} />
        </button>
      )}
    </li>
  );
}

/** The rows over a monitor read the caller owns (the Changes card's, which its attach form also writes through). */
export function PrMonitorRows({
  chatId,
  api,
  open,
  monitor,
}: {
  chatId: string;
  api: NativeApi['prMonitor'];
  open: (url: string) => void;
  monitor: ReturnType<typeof usePrMonitor>;
}) {
  const { state, error, busy, mutate } = monitor;
  const menu = useAnchor();
  const [stackUrl, setStackUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(false);
  // a right-click on any row, or the ⋯ of a row the chat doesn't track
  const [context, setContext] = useState<{ row: PrRow; anchor: MenuAnchor } | null>(null);
  const [merging, setMerging] = useState(false);
  // why the last merge was refused, for the pull request it was asked of
  const [refusal, setRefusal] = useState<{ url: string; text: string } | null>(null);
  // a chat that tracks no pull request shows none: the Changes card offers to attach or create one instead
  if (!state) return null;
  const note = monitorNote(state);
  // a refusal is about one open pull request: a merge elsewhere, a close or a rebind retires it, and so does opening
  // the menu again (main refreshed the rows with the refusal, so a moved head is already what they show)
  const refused = refusal?.url === state.url && !ended(state.pr?.state) ? refusal.text : '';
  const problem = refused || error || state.error;
  // the same gate main applies again on the click, over a fresh read
  const block = mergeBlock(state.pr);
  const head = state.pr?.head;
  const merge = async () => {
    const url = state.url;
    setMerging(true);
    setRefusal(null);
    try {
      // pinned to the head this row was drawn for: commits pushed since are refused, not merged unseen
      const result = await api.merge(chatId, url, head!);
      if (result.status === 'merged') toast('Pull request merged');
      // queued, not merged: said as it is, and the row keeps showing the pull request open until GitHub lands it
      else if (result.status === 'accepted') toast(result.text);
      else setRefusal({ url, text: result.text });
    } catch (e) {
      setRefusal({ url, text: errorText(e) });
    } finally {
      setMerging(false);
    }
  };
  const done = ended(state.pr?.state);
  const { rows, earlier } = prRows(state);
  const hidden = rows.length - VISIBLE_ROWS;
  const shown = expanded || hidden <= 0 ? rows : rows.slice(0, VISIBLE_ROWS);
  // a stack that no longer folds forgets it was expanded, so a longer one later starts folded
  if (expanded && hidden <= 0) setExpanded(false);
  // the same for the earlier pull requests: a list that went away and comes back starts folded
  if (earlierOpen && earlier.length === 0) setEarlierOpen(false);
  const merged = earlier.filter((r) => r.pr?.state === 'MERGED').length;
  const stackError = state.pr?.stackError;
  const onMenu = (row: PrRow, anchor: MenuAnchor) => {
    menu.close();
    setRefusal(null);
    setContext({ row, anchor });
  };
  const closeContext = () => setContext(null);
  // the chat's own PR: everything its ⋯ offers, from the ⋯ or a right-click
  const trackedItems = (close: () => void) => (
    <>
      <MenuItem icon={<ExternalLink size={15} />} onSelect={() => open(state.url)}>
        Open on GitHub
      </MenuItem>
      <MenuItem icon={<Copy size={15} />} onSelect={() => copyText(state.url, 'Copied link')}>
        Copy link
      </MenuItem>
      {!done && (
        <MenuItem
          icon={<GitMerge size={15} />}
          disabled={busy || merging || !!block || !head}
          description={merging ? 'Merging…' : block?.message}
          onSelect={() => void merge()}
        >
          Merge pull request
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        icon={<Wrench size={15} />}
        checked={state.autoFix}
        // a merged or closed pull request has nothing left to fix
        disabled={busy || done}
        title="Wakes this chat to fix failing checks and merge conflicts, with its current harness and permissions. Runs while MoPilot is open."
        onSelect={() => void mutate({ autoFix: !state.autoFix })}
      >
        Auto-fix
      </MenuItem>
      <MenuItem
        icon={<MessageSquare size={15} />}
        checked={state.addressComments}
        disabled={busy}
        onSelect={() => void mutate({ addressComments: !state.addressComments })}
      >
        Address review comments
      </MenuItem>
      <MenuItem icon={<RefreshCw size={15} />} disabled={busy} onSelect={() => void mutate()}>
        Refresh status
      </MenuItem>
      <MenuItem
        icon={<Layers size={15} />}
        disabled={busy || done}
        onSelect={() => {
          close();
          setStackUrl(state.url);
        }}
      >
        Stack on another PR…
      </MenuItem>
      {state.continuation && (
        <MenuItem icon={<RotateCcw size={15} />} disabled={busy} onSelect={() => void mutate({ continuation: null })}>
          Cancel continuation
        </MenuItem>
      )}
      {(state.uncertain || state.limited) && (
        <MenuItem icon={<RotateCcw size={15} />} disabled={busy} onSelect={() => void mutate({ retry: true })}>
          {state.continuation ? 'Retry continuation' : 'Retry auto-fix'}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuLabel>Requires GitHub CLI sign-in</MenuLabel>
    </>
  );
  const renderRow = (row: PrRow) =>
    row.tracked ? (
      <Row key={row.url} row={row} open={open} onMenu={onMenu} menuOpen={menu.open || context?.row.url === row.url}>
        <button
          ref={menu.ref}
          className={`icon-btn xs ${styles.prRowMore} ${menu.open ? 'on' : ''}`}
          aria-label="More PR options"
          aria-haspopup="menu"
          onClick={() => {
            closeContext();
            setRefusal(null);
            menu.toggle();
          }}
        >
          <Ellipsis size={15} />
        </button>
      </Row>
    ) : (
      <Row key={row.url} row={row} open={open} onMenu={onMenu} menuOpen={context?.row.url === row.url} />
    );
  return (
    <div className={styles.prPanel} role="group" aria-label="Pull request controls">
      <div className={styles.prPanelBody}>
        <ul className={styles.prRows} aria-label="Pull requests">
          {shown.map(renderRow)}
        </ul>
        {hidden > 0 && (
          <button className={styles.prRowsMore} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : `Show ${hidden} more`}
          </button>
        )}
        {earlier.length > 0 && (
          <>
            <button className={styles.prEarlier} aria-expanded={earlierOpen} onClick={() => setEarlierOpen(!earlierOpen)}>
              <ChevronRight size={12} className={styles.prEarlierCaret} aria-hidden />
              <span className={styles.prEarlierLabel}>
                {earlier.length} earlier pull {earlier.length === 1 ? 'request' : 'requests'}
              </span>
              {merged > 0 && <span className={styles.prEarlierMerged}>{merged} merged</span>}
            </button>
            {earlierOpen && (
              <ul className={styles.prRows} aria-label="Earlier pull requests">
                {earlier.map(renderRow)}
              </ul>
            )}
          </>
        )}
        {problem ? (
          <div className={styles.prBarNote} role="alert">
            {problem}
          </div>
        ) : note ? (
          <div className={styles.prBarNote} role="status">
            {note}
          </div>
        ) : (
          stackError && (
            <div className={styles.prBarNote} role="status">
              Couldn’t read the PRs this one is stacked on: {stackError}
            </div>
          )
        )}
      </div>
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={260}>
        {trackedItems(menu.close)}
      </Menu>
      {context && (
        <Menu anchor={context.anchor} open onClose={closeContext} placement="bottom-end" width={260}>
          {context.row.tracked ? (
            trackedItems(closeContext)
          ) : (
            <>
              <MenuItem icon={<ExternalLink size={15} />} onSelect={() => open(context.row.url)}>
                Open on GitHub
              </MenuItem>
              <MenuItem icon={<Copy size={15} />} onSelect={() => copyText(context.row.url, 'Copied link')}>
                Copy link
              </MenuItem>
            </>
          )}
        </Menu>
      )}
      {stackUrl === state.url && (
        <PrStackPicker key={state.url} chatId={chatId} url={state.url} api={api} anchor={menu.anchor} onClose={() => setStackUrl(null)} />
      )}
    </div>
  );
}
