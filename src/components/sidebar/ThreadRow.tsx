// A chat's row in the sidebar (status, pin, archive, inline rename), its chat menu, and the drag handle that reorders chats.
import { memo, useState, useRef, useEffect, useId, type CSSProperties, type ReactNode } from 'react';
import { useStore, threadTitle, toast } from '../../store/core';
import { renameThread } from '../../store/actions';
import { ThreadHarnessBadge } from '../harnessPicker/HarnessPicker';
import { ThreadPullRequestBadge } from './ThreadPullRequestBadge';
import { SidebarInboxCount } from './SidebarInboxCount';
import { GoalMark } from '../thread/GoalBar';
import { Tooltip, useAnchor } from '../ui/Popover';
import { ThreadMenu } from './ThreadMenu';
export { ThreadMenu } from './ThreadMenu';
import { ChevronRight, Ellipsis } from '../ui/icons';
import { openChat, openChatWhere } from '../../session/openChat';
import { ThreadActivityIndicator, ThreadForkIndicator, ThreadVoiceIndicator } from './ThreadIndicators';
import { type Thread } from '../../store/types';
import { cancelOnEscape, isEnter, onActivate } from '../../lib/focus';
import { type ReorderChat } from './projectGroups';
import { errorText } from '../../lib/ignored';
import { useRowDrag } from '../../lib/rowDrag';
import { useOrchestration } from '../../lib/sideSessions';
import { useSidebarLineage } from '../../session/harness/claude/desktopLineage';
import { setNestedHidden, useNestedHidden, type NestedView } from '../../lib/nestedHidden';
import { titleIfClipped } from '../../lib/clippedTitle';
import { useChatRowState } from '../../session/useChatRowState';
import { MorphText } from '../ui/MorphText';
import { ShimmerSpan } from '../ui/ShimmerBand';
import type { SideSessionChild } from '../../../shared/orchestration';
import { SidebarChatShortcut } from '../../session/sidebarShortcuts';
import { usePullRequestFolder } from '../../lib/chatMachine';
import { familiesOf } from '../../lib/sidebarFamilyIndex';
import { ThreadMachineLine, useRowMachineLine } from './ThreadMachineLine';
import { HostMark } from '../ui/HostMark';
import { onMachineHint } from '../../lib/machineFolder';

/** Memoized: opening a chat re-renders the two rows whose `active` changed, not every row of the sidebar. */
export const ThreadRow = memo(function ThreadRow({
  thread,
  active,
  depth = 0,
  nestedView,
  projectHostId,
  startedBy,
  onOpen,
}: {
  thread: Thread;
  active: boolean;
  /** how far below the chat that started it the row is nested (sidebar/ChildRows.tsx); 0 for a top-level row */
  depth?: number;
  /** the sidebar list the row is in: a chat that started listed chats gets its Show/Hide nested sessions there */
  nestedView?: NestedView;
  /** Host location shown on the containing project row. */
  projectHostId?: string;
  /** a nested row: the title of the chat that started it, read to screen readers */
  startedBy?: string;
  /** called with the row's chat, so one callback can serve every row */
  onOpen?: (threadId: string) => void;
}) {
  const pinned = useStore((s) => !!s.pinned[thread.id]);
  const showHarness = useStore((s) => s.prefs.showChatHarness ?? false);
  const [editing, setEditing] = useState(false);
  const more = useAnchor();
  const [contextAnchor, setContextAnchor] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // Machine-qualified folders let the shared PR reader ask the Host for its branch without reading that path on this Mac.
  const folder = usePullRequestFolder(thread.id, thread.cwd);
  const title = useStore((s) => threadTitle(thread, s.chatInitialTitles));
  // Legacy or retryable input waits behind this receiving session, never an app-wide concurrency cap.
  const orchestration = useOrchestration();
  const queued = orchestration.queue.indexOf(thread.id) + 1;
  const lineage = useSidebarLineage();
  // its started chats nest under it in this list: one toggle hides or shows them
  const nests = useStore(
    (s) => !!nestedView && !!familiesOf(lineage, s.threadOrder, s.threads, s.momoChats, false).descendants.get(thread.id)?.length,
  );
  const nestedHidden = useNestedHidden(nestedView ?? 'project', thread.id);
  const nestedLabel = nestedHidden ? 'Show nested sessions' : 'Hide nested sessions';
  const toggleNested = () => setNestedHidden(nestedView!, [thread.id], !nestedHidden);
  const describedBy = useId();
  const machineLine = useRowMachineLine(thread.id);
  const word = !editing && machineLine?.word;
  const description = [
    startedBy === undefined ? null : `Started by the agent from ${startedBy}`,
    machineLine && onMachineHint(machineLine.name),
    word,
  ]
    .filter(Boolean)
    .join('. ');

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  // a name that changes under the pointer (renamed, or titled by its harness) doesn't keep the old one's tooltip
  useEffect(() => {
    const label = labelRef.current;
    if (label?.hasAttribute('title') && label.title !== title) titleIfClipped(label, undefined, title);
  }, [title]);

  const commitRename = async (v: string) => {
    setEditing(false);
    const name = v.trim();
    if (name && name !== title) {
      try {
        await renameThread(thread.id, name);
      } catch (e) {
        toast(`Rename failed: ${errorText(e)}`, 'error');
      }
    }
  };

  // a plain click (or Enter) opens it here, ⌥-click in split view, ⌘-click in a new window (src/session/openChat.ts)
  const open = (e?: { altKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (editing) return;
    onOpen?.(thread.id);
    openChat(thread.id, e ? openChatWhere(e) : 'here');
  };
  return (
    // a row, not a <button>: it holds buttons of its own (its menu, nested-family caret and tasks)
    <div
      ref={rowRef}
      data-sidebar-chat={thread.id}
      className={['side-row thread-row', depth && 'linked-child', active && 'selected', word && 'has-sub', more.open && 'menu-open']
        .filter(Boolean)
        .join(' ')}
      style={depth ? ({ '--depth': depth } as CSSProperties) : undefined}
      role="button"
      aria-label={title}
      aria-describedby={description ? describedBy : undefined}
      tabIndex={0}
      aria-current={active ? 'page' : undefined}
      onClick={open}
      onKeyDown={onActivate(() => open())}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextAnchor({ x: e.clientX, y: e.clientY });
        more.setOpen(true);
      }}
    >
      <span className="thread-row-content">
        {editing ? (
          <input
            ref={inputRef}
            className="rename-input"
            defaultValue={title}
            onBlur={(e) => commitRename(e.currentTarget.value)}
            onKeyDown={(e) => {
              // cannot reject: commitRename says why a rename failed
              if (isEnter(e)) void commitRename(e.currentTarget.value);
              cancelOnEscape(e, () => setEditing(false));
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            {showHarness && <ThreadHarnessBadge threadId={thread.id} />}
            {/* a name the sidebar's width cuts short reads whole on hover; on the label, not the row, so the row's own
              buttons (menu, nested-family caret) show only their tooltips */}
            <span className="side-row-name">
              <span ref={labelRef} className="side-row-label" onPointerEnter={(e) => titleIfClipped(e.currentTarget, undefined, title)}>
                {/* a new name (the generated title replacing the first words, or a rename elsewhere) crossfades in */}
                <RowName thread={thread} title={title} linked={orchestration.children[thread.id]} />
              </span>
              {/* Where it runs follows the name, as on a project heading; the trailing columns stay PR and status. */}
              {machineLine && machineLine.id !== projectHostId && (
                <HostMark id={machineLine.id} name={machineLine.name} cloud={machineLine.cloud} />
              )}
              {nests && (
                <Tooltip label={nestedLabel}>
                  <button
                    type="button"
                    className="nested-caret"
                    aria-label={nestedLabel}
                    aria-expanded={!nestedHidden}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleNested();
                    }}
                  >
                    <ChevronRight size={14} data-expanded={!nestedHidden} />
                  </button>
                </Tooltip>
              )}
            </span>
          </>
        )}
        {description && (
          <span id={describedBy} className="sr-only">
            {description}
          </span>
        )}
        {word && <ThreadMachineLine word={word} />}
        <GoalMark threadId={thread.id} />
        <ThreadForkIndicator thread={thread} />
        {queued > 0 && (
          <span className="side-row-queued" title="Queued for this session">
            Queued
          </span>
        )}
        <ThreadVoiceIndicator threadId={thread.id} />
      </span>
      <SidebarChatShortcut row={rowRef} />
      <SidebarInboxCount threadId={thread.id} row={rowRef} />
      <ThreadPullRequestBadge threadId={thread.id} cwd={folder} updatedAt={thread.updatedAt} row={rowRef} />
      <ThreadActivityIndicator thread={thread} linked={orchestration.children[thread.id]} />
      {/* The menu takes the status dot's place on hover (sidebar.css). */}
      <span className="row-actions">
        <Tooltip label="More options">
          <button
            ref={more.ref}
            className="icon-btn xs"
            aria-label="More options"
            onClick={(e) => {
              e.stopPropagation();
              setContextAnchor(null);
              more.toggle();
            }}
          >
            <Ellipsis size={16} />
          </button>
        </Tooltip>
      </span>
      <span className="row-menu" role="presentation" onClick={(e) => e.stopPropagation()}>
        {more.open && (
          <ThreadMenu
            thread={thread}
            anchor={contextAnchor ?? more.anchor}
            open={more.open}
            onClose={more.close}
            onRename={() => setEditing(true)}
            pinned={pinned}
          />
        )}
      </span>
    </div>
  );
});

/**
 * A row's name: a new one (the generated title replacing the first words, or a rename elsewhere) crossfades in, and a
 * working chat's name shimmers, as Claude Desktop's session rows do. Its own component, so the row's state it reads
 * renders the name alone.
 */
function RowName({ thread, title, linked }: { thread: Thread; title: string; linked?: SideSessionChild }) {
  const state = useChatRowState(thread.id, linked, thread)?.state;
  const working = state === 'working' || state === 'elsewhereRunning';
  return (
    <MorphText morphKey={title}>
      <ShimmerSpan on={working}>{title}</ShimmerSpan>
    </MorphText>
  );
}

/** Keep native HTML drag events on the whole chat row, including folder and Recents rows. */
export function DraggableChat({
  id,
  orderKey,
  ids,
  reorder,
  children,
}: {
  id: string;
  orderKey: string;
  ids: string[];
  reorder: ReorderChat;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const [after, setAfter] = useState(false);
  const drag = useRowDrag();
  return (
    <div
      className={`sidebar-chat-drag ${over ? 'drag-over' : ''} ${over && after ? 'drag-after' : ''}`}
      {...drag}
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-codex-thread', id);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/x-codex-thread')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
        const bounds = e.currentTarget.getBoundingClientRect();
        setAfter(e.clientY > bounds.top + bounds.height / 2);
      }}
      onDragLeave={() => setOver(false)}
      onDragEnd={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const bounds = e.currentTarget.getBoundingClientRect();
        reorder(orderKey, ids, e.dataTransfer.getData('text/x-codex-thread'), id, e.clientY > bounds.top + bounds.height / 2);
      }}
    >
      {children}
    </div>
  );
}
