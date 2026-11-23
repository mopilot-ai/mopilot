// The Changes pane: the turn's, uncommitted or branch diff, with file actions and language badges.

import { fileName } from '../../lib/paths';
import { isWin } from '../../lib/platform';
import { openAppLabel } from '../../lib/openApps';
import { copyText } from '../../session/clipboard';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEffectOn } from '../../lib/effects';
import { visiblePoll } from '../../lib/visiblePoll';
import { gitPoll } from '../../lib/gitPoll';
import { useStore, toast, setPrefs, set as setState } from '../../store/core';
import { localChangesSource, type ChangesSource } from '../../lib/changesSource';
import { NOT_A_REPOSITORY, snapshotOf, type ChangesSnapshot } from '../../lib/changesSnapshot';
import { diffFileText, diffTotals } from '../../lib/diff';
import { changesScope, lastTurnDiffFiles, turnIdsOf, type ChangesScope } from '../../lib/turnDiff';
import { InlineDiff, SplitDiff, type DiffFile } from '../diff/DiffView';
import { useFindingNotes } from './useFindingNotes';
import { ChangesFileHead } from './ChangesFileHead';
import { diffFingerprint, whitespaceOnly, withoutWhitespaceChanges } from '../../lib/diffReview';
import { setViewed, useViewedVersion, viewedState } from '../../lib/diffViewed';
import { FindingsWalkBar } from './FindingsWalkBar';
import { CommitBox, CommitPick, useCommitDraft } from './ChangesCommit';
import { useDiffComments } from './useDiffComments';
import { useReviewThreads } from './useReviewThreads';
import { Menu, MenuItem, Tooltip, useAnchor } from '../ui/Popover';
import { Segmented } from '../pages/settings/Controls';
import { MachineNotice } from './MachineFolderNote';
import {
  ChevronDown,
  Search,
  RefreshCw,
  WrapText,
  ChevronsUpDown,
  Ellipsis,
  Spinner,
  FileText,
  FileSearch,
  Files,
  PythonLogo,
} from '../ui/icons';
import { langFromPath } from '../../lib/highlight';
import { relPath } from '../../lib/paths';
import { errorText } from '../../lib/ignored';
import { LANG_BADGES } from '../../lib/brandColors';

type Scope = ChangesScope;
const NONE: readonly string[] = [];
const SCOPE_LABEL: Record<Scope, string> = { turn: 'Last Turn', uncommitted: 'Uncommitted', branch: 'Branch' };

/** The two ways a diff is read, as the segmented control's segments. */
const DIFF_MODES = [
  { value: 'unified' as const, label: 'Unified' },
  { value: 'split' as const, label: 'Split' },
];

/** The scope a pane opens with; for a source with no Last Turn it is Uncommitted where Last Turn would be. */
function openingScope(
  panel: Parameters<typeof changesScope>[0],
  prefs: Parameters<typeof changesScope>[1],
  inThread: boolean,
  hasLastTurn: boolean,
): Scope {
  const next = changesScope(panel, prefs, inThread && hasLastTurn);
  return next === 'turn' && !hasLastTurn ? 'uncommitted' : next;
}

/** Memoized: its props are two strings and a source (stable while its folder is), so a resize of the window, the sidebar
 *  or the pane does not render the whole diff again (#2049). `source` is where the folder's changes come from and its
 *  commit and discard go (default: `cwd` on this Mac); what it cannot offer, its `capabilities` say. */
export const DiffPanel = memo(function DiffPanel({
  cwd,
  threadId,
  source: given,
}: {
  cwd: string;
  threadId: string | null;
  source?: ChangesSource;
}) {
  const local = useMemo(() => localChangesSource(cwd), [cwd]);
  const source = given ?? local;
  const { lastTurn, comments: commentsCap, poll } = source.capabilities;
  const panel = useStore((s) => s.diffPanel);
  const turnCount = useStore((s) => (threadId ? (s.runtime[threadId]?.turns.length ?? 0) : 0));
  const lastDiff = useStore((s) => (threadId ? s.runtime[threadId]?.turns.at(-1)?.diff : undefined));
  const lastStatus = useStore((s) => (threadId ? s.runtime[threadId]?.turns.at(-1)?.status : undefined));
  const running = useStore((s) => !!(threadId && s.runtime[threadId]?.activeTurnId));
  // "last turn only" is this Mac's Git-off preference: a source with no Last Turn has nothing to be limited to
  const lastTurnOnly = useStore((s) => s.prefs.changesLastTurnOnly) && lastTurn.on;
  // a file opens in the app Settings → General names; with Finder chosen, in the file's own default app
  const openDestination = useStore((s) => s.prefs.openDestination);
  const openLabel = openDestination === 'finder' ? 'Open in default app' : `Open in ${openAppLabel(openDestination)}`;
  const [scope, setScopeState] = useState<Scope>(() => openingScope(panel, useStore.getState().prefs, !!threadId, lastTurn.on));
  // a scope the user picks is remembered as the default for the next Changes pane, and a findings walk keeps it
  const setScope = (next: Scope) => {
    setScopeState(next);
    const current = useStore.getState().diffPanel;
    setState({ diffPanel: { ...current, scope: next, ...(current.walk && { walk: { ...current.walk, settled: true } }) } });
    setPrefs({ changesScope: next });
  };
  // the last turn's files are the chat's own turns' unless the source reads them itself (a machine's Host does)
  const ownTurn = scope === 'turn' && !source.readTurn;
  const context = useMemo(() => ({ cwd, scope, source }), [cwd, scope, source]);
  const gitContext = useRef(context);
  gitContext.current = context;
  const mounted = useRef(true);
  const [gitSnapshot, setGitSnapshot] = useState<ChangesSnapshot | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [filter, setFilter] = useState('');
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Map<string, boolean>());
  const [showFiles, setShowFiles] = useState(true);
  const optMenu = useAnchor();
  const jumpMenu = useAnchor();
  // the Changes options' Show whitespace (off: whitespace-only edits read as unchanged lines)
  const showWhitespace = useStore((s) => s.prefs.changesWhitespace ?? true);
  useViewedVersion();
  const rawDiff = () => (files ?? []).map(diffFileText).join('');
  const scopeMenu = useAnchor();
  const listRef = useRef<HTMLDivElement>(null);
  const gitRequest = useRef(0);

  useEffect(() => {
    // the remembered scope is read, not subscribed: a pick must not snap the pane back to the caller's scope;
    // "last turn only" is subscribed, so turning it on or off picks the scope again
    const remembered = useStore.getState().prefs.changesScope;
    setScopeState(openingScope(panel, { changesScope: remembered, changesLastTurnOnly: lastTurnOnly }, !!threadId, lastTurn.on));
  }, [panel, threadId, lastTurnOnly, lastTurn.on]);

  const loadGit = useCallback(
    async (fresh = false) => {
      if (!mounted.current || gitContext.current !== context) return;
      const request = ++gitRequest.current;
      try {
        const wanted = () => request === gitRequest.current && mounted.current && gitContext.current === context;
        const read =
          scope === 'turn'
            ? await source.readTurn?.(turnIdsOf(useStore.getState().runtime[threadId ?? '']?.turns, panel.turnId), wanted)
            : await source.read(scope === 'branch' ? 'branch' : 'uncommitted', fresh, wanted);
        if (!read || !wanted()) return;
        // a poll that read the same diff keeps the snapshot, so the pane is not rendered (and colored) again
        setGitSnapshot((previous) => snapshotOf(previous, context, cwd, read));
      } catch (error) {
        if (request === gitRequest.current && mounted.current && gitContext.current === context) {
          setGitSnapshot({ context, root: cwd, files: [], error: errorText(error), conflicted: [] });
        }
      }
    },
    [context, scope, cwd, source, threadId, panel.turnId],
  );
  // polls git (less often while no turn runs, src/lib/gitPoll.ts), and reads it again at once when the chat's last turn
  // changes, a turn starts or ends, or the pane is opened again
  useEffectOn([loadGit, scope, turnCount, lastDiff, lastStatus, panel, running], () => {
    if (ownTurn) return;
    void loadGit();
    // a source that is read when asked (poll off) has no timer
    const [key, ms] = gitPoll('diff-panel-git', running);
    const stopPoll = poll.on ? visiblePoll(key, ms, () => void loadGit(), { wake: false }) : () => undefined;
    // one fresh read when the window shows or takes focus (once, though both events arrive)
    const stopWake = visiblePoll('diff-panel-git-wake', Infinity, () => void loadGit(true));
    return () => {
      gitRequest.current++;
      stopPoll();
      stopWake();
    };
  });

  // the turns are read only for the last-turn scope; other scopes render nothing for a streamed frame
  const turns = useStore((s) => (scope === 'turn' && threadId ? s.runtime[threadId]?.turns : undefined));
  const turnFiles = useMemo(() => lastTurnDiffFiles(turns ?? [], panel.turnId, cwd), [turns, panel.turnId, cwd]);

  const snapshot = gitSnapshot?.context === context ? gitSnapshot : null;
  const gitError = snapshot?.error ?? null;
  const files = ownTurn ? turnFiles : (snapshot?.files ?? null);
  const fileCwd = ownTurn ? cwd : (snapshot?.root ?? cwd);
  const commitDraft = useCommitDraft(source.keyOf(fileCwd));
  // files in conflict are not committed: they are marked, left unticked, and the commit waits for them
  const conflicted = scope === 'turn' ? NONE : (snapshot?.conflicted ?? NONE);
  const shown = (files ?? []).filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));
  const reviewKey = JSON.stringify([
    source.keyOf(fileCwd),
    scope,
    scope === 'turn' ? threadId : null,
    scope === 'turn' ? (panel.turnId ?? turns?.at(-1)?.id) : null,
  ]);
  const viewedOf = (f: DiffFile) => (f.binary && !f.binaryVersion ? null : viewedState(reviewKey, f.path, diffFingerprint(f)));
  // a file the user folded or unfolded stays so; else a file marked Viewed (and unchanged since) is folded
  const isFolded = (f: DiffFile) => collapsed.get(f.path) ?? viewedOf(f) === 'viewed';
  const anyCollapsed = shown.some(isFolded);
  const totals = diffTotals(files ?? []);

  const jump = useCallback(
    (path: string) =>
      listRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    [],
  );
  // a review's findings under their lines; the one in focus unfolds its file
  const reveal = useCallback((path: string) => setCollapsed((c) => (c.get(path) === false ? c : new Map(c).set(path, false))), []);
  // a source whose folder is not on this Mac has no review findings, comments or pull request threads to show
  const comments = commentsCap.on;
  const { notesFor } = useFindingNotes({ chatId: comments ? threadId : null, scope, files, fileCwd, listRef, reveal });
  const { commentingFor, commentNotesFor } = useDiffComments(threadId, fileCwd);
  const reviews = useReviewThreads({
    enabled: comments,
    chatId: threadId,
    cwd: fileCwd,
    scope,
    files,
    listRef,
    reveal,
    clearFilter: () => setFilter(''),
  });
  const notes = (f: DiffFile) => (comments ? [...notesFor(f), ...commentNotesFor(f), ...reviews.notesFor(f)] : []);
  const commenting = (f: DiffFile, raw: DiffFile) => (comments ? { ...commentingFor(f), onPost: reviews.onPostFor(raw) } : undefined);
  useEffect(() => {
    if (!panel.file || !files) return;
    const selected = files.find((file) => relPath(file.path, fileCwd) === relPath(panel.file as string, fileCwd));
    if (!selected) return;
    const timer = setTimeout(() => jump(selected.path), 50);
    return () => clearTimeout(timer);
  }, [panel.file, files, fileCwd, jump]);

  const discard = async (f: DiffFile) => {
    if (!confirm(`Discard all changes to ${f.path}${source.where}? This cannot be undone.`)) return;
    try {
      const result = await source.discard(fileCwd, f.path);
      if (!mounted.current || gitContext.current !== context) return;
      if (!result.ok) toast(source.discardFailure(f.path, result), 'error');
    } catch (error) {
      if (mounted.current && gitContext.current === context) toast(errorText(error), 'error');
    } finally {
      void loadGit(true);
    }
  };

  return (
    <div className="changes-pane cp-review-layout">
      <div className="cp-head">
        <button ref={scopeMenu.ref} className="cp-scope" onClick={scopeMenu.toggle}>
          <span>{SCOPE_LABEL[scope]}</span>
          <ChevronDown size={14} strokeWidth={2} />
          {files && (
            <span className="diff-stat">
              <span className="plus">+{totals.added}</span> <span className="minus">-{totals.removed}</span>
            </span>
          )}
        </button>
        <div className="cp-toolbar">
          <Tooltip label="Changes options">
            <button ref={optMenu.ref} className="cp-tool" onClick={optMenu.toggle} aria-label="Changes options">
              <Ellipsis size={16} strokeWidth={1.6} />
            </button>
          </Tooltip>
          <Tooltip label="Jump to file">
            <button ref={jumpMenu.ref} className="cp-tool" onClick={jumpMenu.toggle} aria-label="Jump to file">
              <FileSearch size={16} strokeWidth={1.6} />
            </button>
          </Tooltip>
          <Tooltip label="Refresh">
            <button
              className="cp-tool"
              onClick={() => {
                if (!ownTurn) {
                  void loadGit(true);
                  reviews.refresh();
                }
              }}
              aria-label="Refresh"
            >
              <RefreshCw size={16} strokeWidth={1.6} />
            </button>
          </Tooltip>
          <Tooltip label="Word wrap">
            <button className={`cp-tool ${wrap ? 'on' : ''}`} onClick={() => setWrap((w) => !w)} aria-label="Word wrap" aria-pressed={wrap}>
              <WrapText size={16} strokeWidth={1.6} />
            </button>
          </Tooltip>
          <Tooltip label={anyCollapsed ? 'Expand all diffs' : 'Collapse all diffs'}>
            <button
              className="cp-tool"
              aria-label={anyCollapsed ? 'Expand all diffs' : 'Collapse all diffs'}
              onClick={() => {
                setCollapsed(new Map(shown.map((f) => [f.path, !anyCollapsed])));
              }}
            >
              <ChevronsUpDown size={16} strokeWidth={1.6} />
            </button>
          </Tooltip>
          {/* the mode says its own name: an icon-only chip left the user to click to find out what it did */}
          <Segmented
            className="cp-mode"
            label="Diff mode"
            value={split ? 'split' : 'unified'}
            options={DIFF_MODES}
            onChange={(mode) => setSplit(mode === 'split')}
          />
          <Tooltip label={showFiles ? 'Hide files' : 'Show files'}>
            <button
              className={`cp-tool ${showFiles ? 'on' : ''}`}
              onClick={() => setShowFiles((x) => !x)}
              aria-label="Hide files"
              aria-pressed={showFiles}
            >
              <Files size={16} strokeWidth={1.6} />
            </button>
          </Tooltip>
        </div>
        <Menu anchor={optMenu.anchor} open={optMenu.open} onClose={optMenu.close} placement="bottom-end" width={220}>
          <MenuItem onSelect={() => copyText(rawDiff(), 'Copied diff')}>Copy diff</MenuItem>
          <MenuItem checked={showWhitespace} onSelect={() => setPrefs({ changesWhitespace: !showWhitespace })}>
            Show whitespace
          </MenuItem>
          {!lastTurnOnly && <MenuItem onSelect={() => setScope('uncommitted')}>Show uncommitted changes</MenuItem>}
          {!lastTurnOnly && <MenuItem onSelect={() => setScope('branch')}>Show branch changes</MenuItem>}
          {scope !== 'turn' && files && files.length > 0 && !gitError && (
            <MenuItem
              danger
              onSelect={async () => {
                if (!confirm(`Discard all uncommitted changes${source.where}? This cannot be undone.`)) return;
                try {
                  const result = await source.discard(fileCwd, null);
                  if (!mounted.current || gitContext.current !== context) return;
                  if (!result.ok) toast(source.discardFailure(null, result), 'error');
                } catch (error) {
                  if (mounted.current && gitContext.current === context) toast(errorText(error), 'error');
                } finally {
                  void loadGit(true);
                }
              }}
            >
              Discard all changes
            </MenuItem>
          )}
        </Menu>
        <Menu anchor={jumpMenu.anchor} open={jumpMenu.open} onClose={jumpMenu.close} placement="bottom-end" width={280}>
          {(files ?? []).map((f) => (
            <MenuItem key={f.path} icon={<LangIcon path={f.path} />} onSelect={() => jump(f.path)}>
              {relPath(f.path, fileCwd)}
            </MenuItem>
          ))}
        </Menu>
      </div>
      <FindingsWalkBar chatId={comments ? threadId : null} />
      {reviews.bar}
      <div className="cp-body">
        <div className={`cp-diffs ${wrap ? 'wrap' : ''}`} ref={listRef}>
          {reviews.extra}
          {!files && (
            <div className="center-pad">
              <Spinner size={16} />
            </div>
          )}
          {!ownTurn && snapshot?.notice && <MachineNotice text={snapshot.notice.text} hostId={snapshot.notice.hostId} />}
          {!ownTurn && gitError && (
            <div className="empty-state" role={gitError === NOT_A_REPOSITORY ? undefined : 'alert'}>
              {gitError}
            </div>
          )}
          {files && files.length === 0 && !(!ownTurn && (gitError || snapshot?.notice)) && (
            <div className="empty-state">{scope === 'turn' ? 'No changes in this turn' : 'No changes'}</div>
          )}
          {shown.map((raw) => {
            const f = showWhitespace ? raw : withoutWhitespaceChanges(raw);
            const viewed = viewedOf(raw);
            const folded = isFolded(raw);
            const toggle = () => setCollapsed((c) => new Map(c).set(f.path, !folded));
            return (
              <section key={f.path} data-path={f.path} className="cp-file">
                <ChangesFileHead
                  conflicted={conflicted.includes(raw.path)}
                  file={f}
                  cwd={fileCwd}
                  source={source}
                  chatId={threadId}
                  expanded={!folded}
                  viewed={viewed}
                  whitespaceOnly={!showWhitespace && whitespaceOnly(raw)}
                  openLabel={openLabel}
                  onToggle={toggle}
                  onViewed={(on) => {
                    setViewed(reviewKey, raw.path, on ? diffFingerprint(raw) : null);
                    // marking folds the file away; unmarking opens it again
                    setCollapsed((c) => {
                      const next = new Map(c);
                      if (on) next.delete(f.path);
                      else next.set(f.path, false);
                      return next;
                    });
                  }}
                  onDiscard={scope !== 'turn' ? () => discard(raw) : undefined}
                />
                {!folded &&
                  (split ? (
                    <SplitDiff file={f} notes={notes(f)} commenting={commenting(f, raw)} />
                  ) : (
                    <InlineDiff file={f} cwd={fileCwd} maxHeight={100000} bare notes={notes(f)} commenting={commenting(f, raw)} />
                  ))}
              </section>
            );
          })}
          {!ownTurn && snapshot?.cut && <MachineNotice text={snapshot.cut} />}
        </div>
        <aside className="cp-files" hidden={!showFiles}>
          <div className="cp-filter">
            <Search size={15} strokeWidth={1.7} />
            <input placeholder="Filter files..." value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          {shown.map((f) => (
            <div key={f.path} className="cp-file-line">
              {scope === 'uncommitted' && <CommitPick draft={commitDraft} path={f.path} conflicted={conflicted.includes(f.path)} />}
              <button className={`cp-file-row ${viewedOf(f) === 'viewed' ? 'viewed' : ''}`} onClick={() => jump(f.path)} title={f.path}>
                <LangIcon path={f.path} />
                <span className="cp-file-row-name">{fileName(f.path, isWin)}</span>
                <span className="diff-stat">
                  {f.added > 0 && <span className="plus">+{f.added}</span>} {f.removed > 0 && <span className="minus">-{f.removed}</span>}
                </span>
              </button>
            </div>
          ))}
          {scope === 'uncommitted' && files && files.length > 0 && (
            <CommitBox
              commit={(message, picked) => source.commit(fileCwd, message, picked)}
              files={files}
              draft={commitDraft}
              conflicted={conflicted}
              live={() => mounted.current && gitContext.current === context}
              done={() => void loadGit(true)}
            />
          )}
        </aside>
      </div>
      <Menu anchor={scopeMenu.anchor} open={scopeMenu.open} onClose={scopeMenu.close} placement="bottom-start" width={220}>
        {threadId &&
          (lastTurn.on ? (
            <MenuItem checked={scope === 'turn'} onSelect={() => setScope('turn')}>
              Last Turn
            </MenuItem>
          ) : (
            <MenuItem disabled description={lastTurn.reason}>
              Last Turn
            </MenuItem>
          ))}
        {!lastTurnOnly && (
          <MenuItem checked={scope === 'uncommitted'} onSelect={() => setScope('uncommitted')}>
            Uncommitted changes
          </MenuItem>
        )}
        {!lastTurnOnly && (
          <MenuItem checked={scope === 'branch'} onSelect={() => setScope('branch')}>
            Branch changes
          </MenuItem>
        )}
        {lastTurnOnly && (
          <MenuItem disabled description="Turn off Show only last turn changes in Settings → Git">
            Git-based diffs are off
          </MenuItem>
        )}
      </Menu>
    </div>
  );
});

/** Tiny colored language badge, like the official file icons. */
export function LangIcon({ path }: { path: string }) {
  const lang = langFromPath(path);
  if (lang === 'python')
    return (
      <span className="lang-icon logo">
        <PythonLogo size={16} />
      </span>
    );
  const m = LANG_BADGES[lang];
  if (!m) return <FileText size={15} strokeWidth={1.6} className="lang-icon plain" />;
  return (
    <span className="lang-icon" style={{ background: m[0] }}>
      {m[1]}
    </span>
  );
}

export { Ellipsis };
