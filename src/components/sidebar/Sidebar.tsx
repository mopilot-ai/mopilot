// The thread sidebar: its header, the app rows (./sidebar/SidebarNav), Pinned, the Projects list, Recents and the account footer; the project groups, rows and lists are in ./sidebar.
import { selectLocalProject } from '../../store/localProjectDraft';
import { useShortcutHint } from '../../session/shortcutHints';
import { useEffect, useRef, useState } from 'react';
import { launchMark } from '../../lib/launchMarks';
import { machineProjectCollapsed } from '../../lib/machineProject';
import { SidebarShortcutContext, useSidebarShortcutHints } from '../../session/sidebarShortcuts';
import { Collapse } from '../ui/Presence';
import { useStore, set as setState, toast, setPrefs, get as getState } from '../../store/core';
import { navigate } from '../../store/panes';
import { moveProject, createProject } from '../../store/projects';
import { MigrationBanner } from './MigrationBanner';
import { PhoneBanner } from './PhoneBanner';
import { MoreChats } from './MoreChats';
import { native } from '../../lib/native';
import { Menu, MenuItem, MenuSeparator, Tooltip, useAnchor } from '../ui/Popover';
import { ChevronDown, Bell, SquarePen, Archive, Plus, Settings, FolderPlus } from '../ui/icons';
import {
  EMPTY_IDS,
  LIST_ORDER,
  PINNED_ORDER,
  RECENTS_ORDER,
  type ReorderChat,
  groupKey,
  movedTo,
  sortManual,
  useProjectGroups,
} from './projectGroups';
import { ProjectGroup } from './ProjectGroup';
import { EMPTY_MAP, EMPTY_SECTIONS, SectionLabel, SidebarOptions, sectionedGroups } from './SidebarSections';
import { CloudSection, OneList, PinnedSection, PrioritySection, RecentsSection, newStandaloneChat } from './ChatLists';
import { SidebarNav } from './SidebarNav';
import { MachineGroups } from './MachineGroups';
import { useSidebarOrganize } from './useSidebarOrganize';
import { SidebarFooter } from './SidebarFooter';
import { projectRows, sortProjectRows } from './projectRows';
import { focusedChat } from '../../store/split';
import { isMomoChat } from '../../lib/momoChats';
export { useProjectGroups, type ProjectGroupData } from './projectGroups';
export { ThreadRow, ThreadMenu } from './ThreadRow';

export function Sidebar({ leaving = false, width }: { leaving?: boolean; width: number }) {
  const sidebarRef = useRef<HTMLElement>(null);
  const hints = useSidebarShortcutHints(sidebarRef);
  const shortcut = useShortcutHint();
  // `groups` keeps the unlisted ones in their places, so a drag moves a project past them without moving them;
  // `homeKey` is the home page's row, the one marked current there
  const { groups, listed, recents, homeKey, cloud, machineKeyOf } = useProjectGroups(true);
  // the launch timeline: the sidebar's first frame, and the first frame with a chat in a project
  useEffect(() => {
    launchMark('sidebar:firstFrame', listed.length, true);
    if (listed.some((g) => g.threads.length)) launchMark('sidebar:firstChats', listed.filter((g) => g.threads.length).length, true);
  }, [listed]);
  const manualPrefs = () => {
    const prefs = getState().prefs;
    if (prefs.chatSort === 'manual') return { chatOrder: prefs.chatOrder };
    return {
      chatOrder: {
        ...prefs.chatOrder,
        ...Object.fromEntries(
          groups.map((g) => [groupKey(g), sortProjectRows(projectRows(g.threads, g.cloudTasks)).map((row) => row.key)]),
        ),
        [RECENTS_ORDER]: recents.map((t) => t.id),
        [PINNED_ORDER]: pinnedThreads.map((t) => t.id),
        [LIST_ORDER]: sortProjectRows(groups.flatMap((g) => projectRows(g.threads, g.cloudTasks))).map((row) => row.key),
      },
    };
  };
  const reorderChat: ReorderChat = (key, ids, from, target, after) => {
    const next = movedTo(ids, from, target, after);
    if (!next) return;
    const snapshot = manualPrefs();
    setPrefs({
      ...snapshot,
      chatSort: 'manual',
      chatOrder: { ...snapshot.chatOrder, [key]: next },
    });
  };
  const reorderProject = (from: string, target: string, after: boolean) => {
    const next = movedTo(groups.map(groupKey), from, target, after);
    if (!next) return;
    const prefs = getState().prefs;
    setPrefs({
      projectSort: 'custom',
      sidebarProjectOrder: [...next, ...(prefs.sidebarProjectOrder ?? []).filter((key) => !next.includes(key))],
    });
    if (prefs.projectSort !== 'custom') toast('Project order set to Custom');
    const source = groups.find((g) => groupKey(g) === from);
    if (source?.id) {
      const savedOrder = next.filter((key) => groups.some((g) => g.id === key));
      void moveProject(source.id, savedOrder[savedOrder.indexOf(source.id) + 1] ?? null);
    }
  };
  const collapsed = useStore((s) => s.collapsedProjects);
  const organize = useSidebarOrganize();
  const sections = useStore((s) => s.prefs.sidebarSections ?? EMPTY_SECTIONS);
  const projectSection = useStore((s) => s.prefs.projectSection ?? EMPTY_MAP);
  const revealed = useStore((s) => s.revealedChats);
  const pinned = useStore((s) => s.pinned);
  const threads = useStore((s) => s.threads);
  const momoChats = useStore((s) => s.momoChats);
  const manual = useStore((s) => s.prefs.chatSort === 'manual');
  const pinnedOrder = useStore((s) => s.prefs.chatOrder[PINNED_ORDER] ?? EMPTY_IDS);
  const header = useAnchor();
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const activityView = useStore((s) => s.activityView);

  // the focused pane's chat is the selected row
  const activeThread = useStore(focusedChat);
  const pinnedThreads = Object.keys(pinned)
    .filter((id) => pinned[id] && threads[id] && !isMomoChat(momoChats, id))
    .map((id) => threads[id]);
  if (manual) sortManual(pinnedThreads, pinnedOrder, (t) => t.id);

  const addFolder = async () => {
    const p = await native.dialog.openFolder();
    if (p) {
      const id = await createProject(p);
      if (id) selectLocalProject(id);
      navigate({ name: 'home', cwd: p });
    }
  };

  const sidebar = (
    <aside ref={sidebarRef} className={`sidebar thread-sidebar ${leaving ? 'leaving' : ''} ${width === 0 ? 'drag-hidden' : ''}`}>
      <div className="sidebar-header">
        <button ref={header.ref} className="sidebar-title" onClick={header.toggle}>
          <span>MoPilot</span>
          <ChevronDown size={14} strokeWidth={2} />
        </button>
        <div className="sidebar-header-actions">
          <Tooltip label={activityView ? 'Turn off activity view' : 'Turn on activity view'} shortcut={shortcut('toggle-activity')}>
            <button
              className={`icon-btn ${activityView ? 'on-tile' : ''}`}
              onClick={() => setState({ activityView: !activityView })}
              aria-label="View activity"
            >
              <Bell size={16} strokeWidth={1.7} />
              <ActivityDot />
            </button>
          </Tooltip>
        </div>
      </div>

      <MigrationBanner />
      <PhoneBanner />
      <div className="sidebar-scroll">
        {/* the one-list and activity views draw no project rows: there New chat is the home page's current entry */}
        <SidebarNav homeRow={homeKey !== null && organize === 'project' && !activityView} />

        {activityView && <PrioritySection />}
        {!activityView && pinnedThreads.length > 0 && (
          <PinnedSection activeThread={activeThread} list={pinnedThreads} reorderChat={reorderChat} />
        )}

        {!activityView && (
          <>
            <div className="sidebar-section">
              <div className="side-label-row">
                <button className="side-label with-chevron" onClick={() => setProjectsCollapsed((c) => !c)}>
                  {organize === 'machine' ? 'Machines' : 'Projects'}
                  <ChevronDown size={12} strokeWidth={2} className={projectsCollapsed ? 'rot-90' : ''} />
                </button>
                <div className="side-label-actions">
                  <SidebarOptions />
                  <Tooltip label="Add new project">
                    <button className="icon-btn sm" onClick={addFolder} aria-label="Add new project">
                      <FolderPlus size={14} strokeWidth={1.7} />
                    </button>
                  </Tooltip>
                </div>
              </div>
              <Collapse open={!projectsCollapsed} className="side-collapse">
                {organize === 'list' && <OneList groups={listed} activeThread={activeThread} reorderChat={reorderChat} />}
                {organize === 'machine' && <MachineGroups activeThread={activeThread} />}
                {organize === 'project' &&
                  sectionedGroups(listed, sections, projectSection).map(({ section, items }) => (
                    <div key={section?.id ?? '_'}>
                      {section && <SectionLabel section={section} sections={sections} />}
                      {items.map((g) => (
                        <ProjectGroup
                          key={groupKey(g)}
                          group={g}
                          reorderChat={reorderChat}
                          reorderProject={reorderProject}
                          collapsed={
                            collapsed[groupKey(g)] ??
                            (g.repository ? collapsed[`repo:${g.repository}`] : undefined) ??
                            (g.machine
                              ? machineProjectCollapsed(collapsed, groupKey(g), machineKeyOf)
                              : !!g.machineGroups?.some((key) => machineProjectCollapsed(collapsed, key, machineKeyOf)))
                          }
                          revealed={revealed[groupKey(g)] ?? 0}
                          activeThread={activeThread}
                          activeHome={homeKey === groupKey(g)}
                        />
                      ))}
                    </div>
                  ))}
                {/* nothing saved yet: with a saved project, the home page lists its own (homeKey) */}
                {organize !== 'machine' && listed.length === 0 && !groups.some((g) => g.saved) && (
                  <button className="side-row muted" onClick={addFolder}>
                    <span className="side-row-icon">
                      <Plus size={16} strokeWidth={1.7} />
                    </span>
                    <span className="side-row-label">Add a project folder</span>
                  </button>
                )}
              </Collapse>
            </div>
            {organize !== 'machine' && (
              <RecentsSection activeThread={activeThread} list={recents} groups={listed} reorderChat={reorderChat} />
            )}
            <CloudSection tasks={cloud} />
            <MoreChats />
          </>
        )}
      </div>
      <SidebarFooter />

      <Menu anchor={header.anchor} open={header.open} onClose={header.close} placement="bottom-start" width={240}>
        <MenuItem icon={<SquarePen size={15} />} shortcut={shortcut('new-chat')} onSelect={newStandaloneChat}>
          New chat
        </MenuItem>
        <MenuItem icon={<FolderPlus size={15} />} shortcut={shortcut('open-folder')} onSelect={addFolder}>
          Open folder…
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Archive size={15} />} onSelect={() => navigate({ name: 'settings', section: 'archived' })}>
          Archived chats
        </MenuItem>
        <MenuItem icon={<Settings size={15} />} shortcut={shortcut('settings')} onSelect={() => navigate({ name: 'settings' })}>
          Settings
        </MenuItem>
      </Menu>
    </aside>
  );
  return <SidebarShortcutContext.Provider value={hints}>{sidebar}</SidebarShortcutContext.Provider>;
}

function ActivityDot() {
  // MoMo's chats have their own dot on MoMo's row
  const pending = useStore((s) => s.pending.some((p) => !isMomoChat(s.momoChats, p.threadId)));
  const unread = useStore((s) => Object.keys(s.unread).some((id) => s.unread[id] && !isMomoChat(s.momoChats, id)));
  return pending || unread ? <span className="bell-dot" /> : null;
}
