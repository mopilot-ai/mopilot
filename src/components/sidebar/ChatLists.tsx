// The sidebar's chat lists beside the projects: Pinned, Recents, the activity view's Priority, Codex Cloud tasks, and every project chat in one list.
import { activeCloudTask } from '../../store/route';
import { Fragment, memo, useCallback, useMemo, useRef, useState } from 'react';
import { Collapse } from '../ui/Presence';
import { useStore, threadTitle, set as setState } from '../../store/core';
import { navigate } from '../../store/panes';
import { projectForThread } from '../../store/projects';
import { clearNewChatProject } from '../../store/chats';
import { stripInjectedContext } from '../../lib/format';
import { stripDirectives } from '../../lib/codexDirectives';
import { heartbeatMessage } from '../../../shared/heartbeatMessage.mjs';
import { Tooltip } from '../ui/Popover';
import { SquarePen, Check } from '../ui/icons';
import { type Thread, type ThreadItem } from '../../store/types';
import {
  EMPTY_IDS,
  LIST_ORDER,
  PINNED_ORDER,
  type ProjectGroupData,
  RECENTS_ORDER,
  type ReorderChat,
  groupKey,
  sortManual,
} from './projectGroups';
import { DraggableChat, ThreadRow } from './ThreadRow';
import { CloudTaskRow, cloudRunning } from './CloudTaskRow';
import { mergeProjectRows, projectRows, sortProjectRows } from './projectRows';
import type { CloudTask } from '../../lib/native';
import { ChildRows } from './ChildRows';
import { SidebarChatShortcut } from '../../session/sidebarShortcuts';
import { useFoldedList } from './WindowFoot';
import { useRequiredChats } from './useRequiredChats';
import { focusedChat } from '../../store/split';
import { isMomoChat } from '../../lib/momoChats';
import { familiesOf } from '../../lib/sidebarFamilyIndex';
import { useFamilyLineage } from '../../session/harness/claude/desktopLineage';
import { useChatStarts } from '../../lib/chatStarts';
import { StartingChatRows } from './StartingChatRows';
import { useLoadingEmpty } from '../../store/sidebarSnapshot';
import { useChatMachine } from '../../lib/chatMachine';
import { HostMark } from '../ui/HostMark';

/** The top New chat uses the last Run on choice and starts outside any local project. */
export const newStandaloneChat = () => {
  clearNewChatProject(true);
  navigate({ name: 'home' });
};

/** Codex Cloud tasks, shown once the account has any. */
export function CloudSection({ tasks }: { tasks: CloudTask[] }) {
  const selected = useStore(activeCloudTask);
  const { visible, foot } = useFoldedList(tasks, 8, (task) => task.id === selected || cloudRunning(task), 'Cloud');
  if (!tasks.length) return null;
  return (
    <div className="sidebar-section">
      <div className="side-label-row">
        <span className="side-label">Cloud</span>
      </div>
      {visible.map((task) => (
        <CloudTaskRow key={task.id} task={task} />
      ))}
      {foot}
    </div>
  );
}

const noneOpen = () => false;

/** Pinned chats: the first 20, then Show more. A pinned chat also shows in its project or Recents, which reach the open one. */
export function PinnedSection({
  activeThread,
  list,
  reorderChat,
}: {
  activeThread: string | null;
  list: Thread[];
  reorderChat: ReorderChat;
}) {
  const { visible, foot } = useFoldedList(list, 20, noneOpen, 'Pinned');
  return (
    <div className="sidebar-section">
      <div className="side-label">Pinned</div>
      {visible.map((t) => (
        <DraggableChat key={t.id} id={t.id} orderKey={PINNED_ORDER} ids={list.map((t) => t.id)} reorder={reorderChat}>
          <ThreadRow thread={t} active={t.id === activeThread} />
        </DraggableChat>
      ))}
      {foot}
    </div>
  );
}

export function RecentsSection({
  activeThread,
  list,
  groups,
  reorderChat,
}: {
  activeThread: string | null;
  list: Thread[];
  groups: ProjectGroupData[];
  reorderChat: ReorderChat;
}) {
  const starting = useChatStarts();
  const [collapsed, setCollapsed] = useState(false);
  const loading = useLoadingEmpty();
  // A project's list reaches its required chats; Recents owns only families with no listed project.
  const grouped = new Set(groups.flatMap((g) => g.threads.map((t) => t.id)));
  const required = useRequiredChats(
    list.filter((t) => !grouped.has(t.id)),
    activeThread,
  );
  const { visible, foot } = useFoldedList(list, 5, (t) => required.has(t.id), 'Recents');
  // one callback for every row, so a memoized row re-renders only when its own chat or `active` does
  const groupsNow = useRef(groups);
  groupsNow.current = groups;
  const openChat = useCallback((id: string) => {
    const g = groupsNow.current.find((g) => g.threads.some((chat) => chat.id === id));
    // unfold the project: its list stretches to show the open chat, without showing every chat
    if (g) setState((s) => ({ collapsedProjects: { ...s.collapsedProjects, [groupKey(g)]: false } }));
  }, []);
  return (
    <div className="sidebar-section" data-shortcut-recents>
      <div className="side-label-row">
        <button className="side-label" onClick={() => setCollapsed((c) => !c)}>
          Recents
        </button>
        <div className="side-label-actions">
          <Tooltip label="New chat">
            <button className="icon-btn sm" onClick={newStandaloneChat} aria-label="New chat">
              <SquarePen size={14} strokeWidth={1.7} />
            </button>
          </Tooltip>
        </div>
      </div>
      <Collapse open={!collapsed} className="side-collapse">
        <StartingChatRows entries={starting} />
        {list.length === 0 && starting.length === 0 && (
          <div className="side-row empty-note recents">{loading ? 'Loading…' : 'No chats'}</div>
        )}
        {visible.map((t) => (
          <Fragment key={t.id}>
            <DraggableChat id={t.id} orderKey={RECENTS_ORDER} ids={list.map((t) => t.id)} reorder={reorderChat}>
              <ThreadRow thread={t} active={t.id === activeThread} onOpen={openChat} nestedView="recents" />
            </DraggableChat>
            <ChildRows parentId={t.id} activeThread={activeThread} view="recents" />
          </Fragment>
        ))}
        {foot}
      </Collapse>
    </div>
  );
}

export function PrioritySection() {
  const starting = useChatStarts();
  const threads = useStore((s) => s.threads);
  const unread = useStore((s) => s.unread);
  const pending = useStore((s) => s.pending);
  const momoChats = useStore((s) => s.momoChats);
  const ids = [...new Set([...pending.map((p) => p.threadId).filter(Boolean), ...Object.keys(unread).filter((k) => unread[k])])].filter(
    (id): id is string => !!id && !!threads[id] && !isMomoChat(momoChats, id),
  );
  return (
    <div className="sidebar-section">
      <div className="side-label-row">
        <span className="side-label">Priority</span>
        <div className="side-label-actions">
          <Tooltip label="Mark all as read">
            <button className="icon-btn sm" onClick={() => setState({ unread: {} })} aria-label="Mark all as read">
              <Check size={14} />
            </button>
          </Tooltip>
        </div>
      </div>
      <StartingChatRows entries={starting} />
      {ids.length === 0 && starting.length === 0 && <div className="side-row empty-note recents">Nothing needs attention</div>}
      {ids.map((id) => (
        <PriorityCard key={id} id={id} />
      ))}
    </div>
  );
}

/** How much of a reply the Priority snippet reads: it shows 160 characters, so a longer reply's deltas change nothing here. */
export const SNIPPET_SOURCE_CHARS = 4000;

/** The start of a chat's latest agent reply, or '' when it has none: a string, so a delta in another chat or past the start changes nothing here. */
export function lastAgentText(turns: readonly { items: readonly ThreadItem[]; status?: string }[] | undefined): string {
  for (let t = (turns?.length ?? 0) - 1; t >= 0; t--) {
    const items = turns![t].items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'agentMessage' && item.text)
        return heartbeatMessage(item.text, turns![t].status === 'inProgress').slice(0, SNIPPET_SOURCE_CHARS);
    }
  }
  return '';
}

/** One chat in Priority. It reads only its own chat, so another chat's stream re-renders no other card. */
const PriorityCard = memo(function PriorityCard({ id }: { id: string }) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const t = useStore((s) => s.threads[id]);
  const title = useStore((s) => threadTitle(s.threads[id], s.chatInitialTitles));
  const projects = useStore((s) => s.savedProjects);
  const selected = useStore((s) => focusedChat(s) === id);
  const needs = useStore((s) => s.pending.some((p) => p.threadId === id));
  const { machine } = useChatMachine(id);
  const last = useStore((s) => lastAgentText(s.runtime[id]?.turns));
  const snippet = useMemo(
    () => (last ? stripDirectives(last, true) : stripInjectedContext(t.preview ?? '')).replace(/[`*#]/g, '').slice(0, 160),
    [last, t.preview],
  );
  return (
    <button
      ref={rowRef}
      data-sidebar-chat={id}
      className={`priority-card ${selected ? 'selected' : ''}`}
      onClick={() => navigate({ name: 'thread', id })}
    >
      <span className="priority-heading">
        <span className="priority-title">
          {title} <span className="priority-project">{projectForThread(t, projects)?.name ?? ''}</span>
        </span>
        {machine && <HostMark id={machine.id} name={machine.name} cloud={machine.row?.cloud} />}
      </span>
      <span className="priority-snippet">{needs ? 'Needs your approval' : snippet}</span>
      <SidebarChatShortcut row={rowRef} />
    </button>
  );
});

/** "In one list": project chats in date or manual order. */
export function OneList({
  groups,
  activeThread,
  reorderChat,
}: {
  groups: ProjectGroupData[];
  activeThread: string | null;
  reorderChat: ReorderChat;
}) {
  const v = useFamilyLineage();
  const threads = useStore((s) => s.threads);
  const listed = useStore((s) => s.threadOrder);
  const momoChats = useStore((s) => s.momoChats);
  const roots = familiesOf(v, listed, threads, momoChats, true).roots;
  const rank = new Map(roots.map((id, i) => [id, i]));
  const all = groups.flatMap((g) => g.threads.map((t) => ({ t, project: g.name }))).sort((a, b) => rank.get(a.t.id)! - rank.get(b.t.id)!);
  const manual = useStore((s) => s.prefs.chatSort === 'manual');
  const order = useStore((s) => s.prefs.chatOrder[LIST_ORDER] ?? EMPTY_IDS);
  if (manual) sortManual(all, order, (x) => x.t.id);
  const required = useRequiredChats(
    all.map((x) => x.t),
    activeThread,
  );
  const tasks = groups.flatMap((g) => g.cloudTasks ?? []);
  const rows = projectRows(
    all.map((entry) => entry.t),
    tasks,
  );
  const mixed = manual ? sortProjectRows(rows, order) : mergeProjectRows(rows);
  const selected = useStore(activeCloudTask);
  const { visible: shown, foot } = useFoldedList(
    mixed,
    20,
    (row) => (row.kind === 'chat' ? required.has(row.key) : row.task.id === selected || cloudRunning(row.task)),
    'Projects',
  );
  return (
    <>
      <StartingChatRows entries={groups.flatMap((g) => g.starting ?? [])} />
      {shown.map((row) =>
        row.kind === 'cloud' ? (
          <DraggableChat key={row.key} id={row.key} orderKey={LIST_ORDER} ids={mixed.map((entry) => entry.key)} reorder={reorderChat}>
            <CloudTaskRow task={row.task} />
          </DraggableChat>
        ) : (
          <Fragment key={row.key}>
            <DraggableChat id={row.key} orderKey={LIST_ORDER} ids={mixed.map((entry) => entry.key)} reorder={reorderChat}>
              <ThreadRow thread={row.thread} active={row.key === activeThread} nestedView="list" />
            </DraggableChat>
            <ChildRows parentId={row.key} activeThread={activeThread} view="list" />
          </Fragment>
        ),
      )}
      {foot}
    </>
  );
}
