// A project in the sidebar: its row with the hover card and menu, and its chats, folded to the first few or shown in full.
import { activeCloudTask } from '../../store/route';
import { Fragment, useState, useRef, useEffect } from 'react';
import { Collapse } from '../ui/Presence';
import { useStore, set as setState, toast, toastFailure, setPrefs, get as getState } from '../../store/core';
import { navigate } from '../../store/panes';
import { archiveThread } from '../../store/actions';
import { renameProject, setNewChatHostFolder } from '../../store/projects';
import { deleteProjectGroup } from '../../session/projectGroupActions';
import { showInFinder } from '../../session/open';
import { abbreviateHome } from '../../lib/paths';
import { Menu, MenuItem, MenuSeparator, Tooltip, useAnchor, Popover } from '../ui/Popover';
import {
  ChevronRight,
  Circle,
  Settings2,
  SquarePen,
  Folder,
  FolderOpen,
  Ellipsis,
  Archive,
  Pencil,
  FolderSearch,
  Monitor,
  Pin,
  X,
} from '../ui/icons';
import { LocationMark } from '../ui/HostMark';
import type { HostLocationKind } from '../../lib/hostLocation';
import { cancelOnEscape, isEnter, onActivate } from '../../lib/focus';
import { type ProjectGroupData, type ReorderChat, groupKey } from './projectGroups';
import { folderEntryOf } from './folderPrefs';
import { folderOnMachine, onMachineHint } from '../../lib/machineFolder';
import { DraggableChat, ThreadRow } from './ThreadRow';
import { useRowDrag } from '../../lib/rowDrag';
import { ChildRows, NestedAllItem } from './ChildRows';
import { SectionSubmenu } from './SidebarSections';
import { chatWindow } from './chatWindow';
import { useRequiredChats } from './useRequiredChats';
import { WindowFoot } from './WindowFoot';
import { StartingChatRows } from './StartingChatRows';
import { CloudTaskRow, cloudRunning } from './CloudTaskRow';
import { mergeProjectRows, projectRows, sortProjectRows } from './projectRows';
import { usesMixedLocationMark } from './projectLabels';
import { selectRepositoryDestination, type DraftDestination } from '../../store/repositoryDraft';
import { selectLocalProject } from '../../store/localProjectDraft';
import { useHostMachines } from '../../lib/hostMachines';
import { useLoadingEmpty } from '../../store/sidebarSnapshot';

const VISIBLE_PER_PROJECT = 5;
const LOCATION_LABELS: Record<HostLocationKind, string> = {
  background: 'Background Host',
  cloud: 'Cloud',
  remote: 'Remote machine',
  ssh: 'SSH',
};

export function ProjectGroup({
  group,
  collapsed,
  revealed,
  activeThread,
  activeHome,
  reorderChat,
  reorderProject,
}: {
  group: ProjectGroupData;
  collapsed: boolean;
  /** chats shown beyond the first five, by Show more */
  revealed: number;
  activeThread: string | null;
  activeHome: boolean;
  reorderChat: ReorderChat;
  reorderProject: (from: string, target: string, after: boolean) => void;
}) {
  const menu = useAnchor();
  const key = groupKey(group);
  const expanded = !collapsed;
  const required = useRequiredChats(group.threads, activeThread);
  const cloudActive = useStore(activeCloudTask);
  const manual = useStore((s) => s.prefs.chatSort === 'manual');
  const order = useStore((s) => s.prefs.chatOrder?.[key]);
  const { machines } = useHostMachines();
  const sharedHost = group.sessionHostId;
  const sharedHostName = sharedHost && (machines.find((machine) => machine.id === sharedHost)?.name ?? sharedHost);
  const entries = projectRows(group.threads, group.cloudTasks);
  const rows = manual ? sortProjectRows(entries, order ?? group.threads.map((thread) => thread.id)) : mergeProjectRows(entries);
  const { visible, foot, more } = chatWindow(rows, VISIBLE_PER_PROJECT, revealed, (row) =>
    row.kind === 'chat' ? required.has(row.thread.id) : row.task.id === cloudActive || cloudRunning(row.task),
  );
  const reveal = (n: number) => setState((s) => ({ revealedChats: { ...s.revealedChats, [key]: n } }));
  const [renaming, setRenaming] = useState(false);
  const drag = useRowDrag();
  const [dragOver, setDragOver] = useState(false);
  const [dragAfter, setDragAfter] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  // before the first lists answer, a project the saved chats say nothing of is not known to be empty
  const loading = useLoadingEmpty();
  const [hover, setHover] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinnedProjects = useStore((s) => s.prefs.pinnedProjects ?? []);
  const isPinned = !!group.pinnedKeys?.length || pinnedProjects.includes(key);
  const togglePin = () =>
    setPrefs({
      pinnedProjects: isPinned ? pinnedProjects.filter((x) => x !== key && !group.pinnedKeys?.includes(x)) : [key, ...pinnedProjects],
    });
  const enter = () => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(true), hover ? 0 : 600);
  };
  const leave = () => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(false), 150);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const toggle = () => setState((s) => ({ collapsedProjects: { ...s.collapsedProjects, [key]: !collapsed } }));
  const empty = rows.length === 0 && !group.starting?.length;
  const location = group.machine && onMachineHint(group.machine.name);
  const headingLocation = sharedHostName ? onMachineHint(sharedHostName) : empty ? location : undefined;
  const kinds = group.locationKinds ?? [];
  const marks = kinds.map((kind) => ({ kind, label: kinds.length === 1 && headingLocation ? headingLocation : LOCATION_LABELS[kind] }));
  const compact = marks.length > 0;
  const rowName = compact && group.hint ? `${group.name} · ${group.hint}` : group.name;
  const description = compact ? marks.map(({ label }) => label).join('. ') : group.hint;
  const headingMarks = usesMixedLocationMark(kinds) ? [{ kind: 'mixed' as const, label: description }] : marks;
  const label = (
    <span className="side-row-label" title={compact ? rowName : undefined}>
      {group.name}
      {group.hint && <span className="project-hint"> · {group.hint}</span>}
    </span>
  );
  const newChatHere = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (group.repository && group.locations?.length) {
      const local: DraftDestination | undefined =
        !group.machine && group.path && group.localAvailable !== false
          ? { kind: 'local', path: group.path, projectId: group.id }
          : undefined;
      const destinations = local ? [local, ...group.locations] : group.locations;
      const available = destinations.filter((d) => d.kind !== 'machine' || machines.some((m) => m.id === d.id && m.status === 'online'));
      selectRepositoryDestination(
        { key, name: group.name, repository: group.repository, destinations, needsLocation: false },
        local ?? (available.length === 1 ? available[0] : undefined),
      );
      return navigate({ name: 'home' });
    }
    // a folder on a machine starts the chat on that machine, never in its path on this Mac
    if (group.machine) {
      setNewChatHostFolder(group.machine, group.path);
      return navigate({ name: 'home' });
    }
    selectLocalProject(group.id, group.id ? null : group.path);
    navigate({ name: 'home', cwd: group.path });
  };

  return (
    <div className={`project-group${compact ? ' with-location' : ''}`}>
      <div
        ref={rowRef}
        className={`side-row project-row ${activeHome ? 'selected' : ''} ${menu.open ? 'menu-open' : ''} ${dragOver ? 'drag-over' : ''} ${dragOver && dragAfter ? 'drag-after' : ''}`}
        role="button"
        aria-label={rowName}
        aria-description={description}
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={onActivate(toggle)}
        onMouseEnter={enter}
        onMouseLeave={leave}
        {...drag}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/x-codex-project', groupKey(group));
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('text/x-codex-project')) {
            e.preventDefault();
            setDragOver(true);
            const bounds = e.currentTarget.getBoundingClientRect();
            setDragAfter(e.clientY > bounds.top + bounds.height / 2);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          const id = e.dataTransfer.getData('text/x-codex-project');
          e.preventDefault();
          const bounds = e.currentTarget.getBoundingClientRect();
          reorderProject(id, groupKey(group), e.clientY > bounds.top + bounds.height / 2);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          menu.setOpen(true);
        }}
      >
        {!compact && (
          <span className="side-row-icon">
            {expanded ? <FolderOpen size={16} strokeWidth={1.7} /> : <Folder size={16} strokeWidth={1.7} />}
          </span>
        )}
        {renaming ? (
          <input
            className="rename-input"
            autoFocus
            defaultValue={group.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(false);
              const v = e.currentTarget.value.trim();
              if (!v || v === group.name) return;
              // a folder group isn't a saved project: its name lives in prefs
              if (group.id) renameProject(group.id, v).catch(toastFailure("Couldn't rename the project"));
              else setPrefs({ folderNames: { ...(getState().prefs.folderNames ?? {}), [folderEntryOf(group)]: v } });
            }}
            onKeyDown={(e) => {
              if (isEnter(e)) e.currentTarget.blur();
              cancelOnEscape(e, () => setRenaming(false));
            }}
          />
        ) : compact ? (
          <span className="side-row-name project-row-name">
            {label}
            {headingMarks.map(({ kind, label }) => (
              <LocationMark key={kind} kind={kind} label={label} size={16} />
            ))}
            <ChevronRight className="project-disclosure" size={14} aria-hidden="true" />
          </span>
        ) : (
          label
        )}
        <span className="row-actions">
          <Tooltip label="Project actions">
            <button
              ref={menu.ref}
              className="icon-btn xs"
              onClick={(e) => {
                e.stopPropagation();
                menu.toggle();
              }}
            >
              <Ellipsis size={15} />
            </button>
          </Tooltip>
          <Tooltip label={`New chat in ${group.name}`}>
            <button className="icon-btn xs" onClick={newChatHere} aria-label={`New chat in ${group.name}`}>
              <SquarePen size={14} />
            </button>
          </Tooltip>
        </span>
      </div>
      <Popover
        anchor={rowRef.current}
        open={hover && !menu.open && !renaming}
        onClose={() => setHover(false)}
        placement="right-start"
        offset={8}
      >
        <div className="project-card" onMouseEnter={enter} onMouseLeave={leave}>
          <div className="project-card-head">
            {compact ? headingMarks.map(({ kind }) => <LocationMark key={kind} kind={kind} />) : <Folder size={14} strokeWidth={1.7} />}
            <span className="project-card-name" title={compact ? rowName : undefined}>
              {rowName}
            </span>
            <Tooltip label={isPinned ? 'Unpin project' : 'Pin project'}>
              <button className={`menu-pin ${isPinned ? 'on' : ''}`} onClick={togglePin}>
                <Pin size={13} fill={isPinned ? 'currentColor' : 'none'} />
              </button>
            </Tooltip>
          </div>
          <div className="project-card-row">
            <Circle size={13} strokeWidth={1.7} />
            {rows.length} {rows.length === 1 ? 'task' : 'tasks'}
          </div>
          {group.machine ? (
            <div className="project-card-row" title={`${location}\n${group.path}`}>
              <Monitor size={13} strokeWidth={1.7} />
              <span className="project-card-detail">{location}</span>
            </div>
          ) : group.path && group.localAvailable !== false ? (
            <button className="project-card-row link" onClick={() => showInFinder(group.path)}>
              <Folder size={13} strokeWidth={1.7} />
              <span className="project-card-detail">{abbreviateHome(group.path)}</span>
            </button>
          ) : null}
          {group.id && (
            <>
              <div className="menu-sep" />
              <button
                className="project-card-row link"
                onClick={() => {
                  setHover(false);
                  setRenaming(true);
                }}
              >
                <Settings2 size={13} strokeWidth={1.7} />
                Edit project
              </button>
            </>
          )}
        </div>
      </Popover>
      <Collapse open={expanded} className="side-collapse">
        <StartingChatRows entries={group.starting ?? []} indent={!compact} projectHostId={sharedHost} />
        {empty && (
          <div>
            <div className="side-row empty-note">{loading ? 'Loading…' : 'No active chats'}</div>
            <button className="side-row show-more" onClick={newChatHere}>
              <span className="side-row-label">New chat</span>
            </button>
            <button className="side-row show-more" onClick={() => navigate({ name: 'settings', section: 'archived' })}>
              <span className="side-row-label">View archived chats</span>
            </button>
          </div>
        )}
        {visible.map((row) => (
          <Fragment key={row.key}>
            <DraggableChat id={row.key} orderKey={key} ids={rows.map((entry) => entry.key)} reorder={reorderChat}>
              {row.kind === 'cloud' ? (
                <CloudTaskRow task={row.task} />
              ) : (
                <ThreadRow
                  thread={row.thread}
                  active={row.key === activeThread}
                  indent={!compact}
                  nestedView="project"
                  projectHostId={sharedHost}
                />
              )}
            </DraggableChat>
            {row.kind === 'chat' && (
              <ChildRows parentId={row.key} activeThread={activeThread} indent={!compact} view="project" projectHostId={sharedHost} />
            )}
          </Fragment>
        ))}
        <WindowFoot foot={foot} label={group.name} onMore={() => reveal(more)} onLess={() => reveal(0)} />
      </Collapse>
      <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-start" width={236}>
        <MenuItem icon={<Pin size={15} />} onSelect={togglePin}>
          {isPinned ? 'Unpin' : 'Pin'}
        </MenuItem>
        <MenuItem icon={<Pencil size={15} />} onSelect={() => setRenaming(true)}>
          Edit
        </MenuItem>
        {group.id && <SectionSubmenu projectId={group.id} />}
        <NestedAllItem parents={group.threads.map((t) => t.id)} view="project" />
        <MenuItem
          icon={<FolderSearch size={15} />}
          disabled={!!group.machine || !group.path || group.localAvailable === false}
          hint={group.machine && onMachineHint(group.machine.name)}
          title={group.machine ? folderOnMachine(group.machine.name) : undefined}
          onSelect={() => showInFinder(group.path)}
        >
          Reveal in Finder
        </MenuItem>
        <MenuItem
          icon={<Archive size={15} />}
          onSelect={async () => {
            if (!group.threads.length || !confirm(`Archive all ${group.threads.length} chats in ${group.name}?`)) return;
            for (const t of group.threads) await archiveThread(t.id);
            toast(`Archived ${group.threads.length} chats`);
          }}
        >
          Archive chats
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          danger
          icon={<X size={15} />}
          onSelect={() => {
            const question = group.id
              ? `Remove ${group.name} from the sidebar? Chats stay in your history.`
              : `Remove ${group.name} from Projects? Its chats move to Recents and stay in your history.`;
            if (!confirm(question)) return;
            const hidden = new Set([...(getState().prefs.hiddenFolders ?? []), folderEntryOf(group)]);
            if (group.repository && group.locations?.length) hidden.add(`repo:${group.repository}`);
            setPrefs({ hiddenFolders: [...hidden] });
            if (group.id) deleteProjectGroup(group.id, group.projectIds).catch(toastFailure("Couldn't remove the project"));
          }}
        >
          Remove from sidebar
        </MenuItem>
      </Menu>
    </div>
  );
}
