// The sidebar's project groups: saved projects and the folders chats ran in, which of them it lists, their chats, and the manual chat and project orders.
import { useCallback, useMemo, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, setPrefs, get as getState } from '../../store/core';
import { projectForThread } from '../../store/projects';
import { homeTarget, type HomeTarget } from './homeTarget';
import type { SavedProject } from '../../store/state';
import { segmentNatives } from '../../store/chats';
import { basename, isAbsolutePath } from '../../lib/paths';
import { chatFolder, codexWorktreeRepo, foldClaudeWorktree, pathKey, samePath } from '../../lib/paths';
import { projectlessFolderOf, type Thread } from '../../store/types';
import { groupKey, sortProjectGroups } from '../../lib/projectGroupOrder';
import { machineFolderKey, machineFolderOf } from '../../lib/machineFolder';
import type { HostLocationKind } from '../../lib/hostLocation';
import { machineProjectPath, machineProjectKey, machineProjectChatOrder } from '../../lib/machineProject';
import { machineOfChat, useHostChats } from '../../lib/hostChats';
import { useHostMachines } from '../../lib/hostMachines';
import { useFamilyLineage } from '../../session/harness/claude/desktopLineage';
import { useProjectPaths } from '../../lib/useProjectPaths';
import { byActivity } from '../../lib/chatActivity';
import { sidebarFamilies } from '../../lib/sidebarFamilies';
import { isMomoChat, momoOwned } from '../../lib/momoChats';
import { useChatStarts, type ChatStart } from '../../lib/chatStarts';
import { useLoadingEmpty } from '../../store/sidebarSnapshot';
import { folderPrefsPatch } from './folderPrefs';
import { FOLDER_RECHECK_MS, useFolderAvailability } from './useFolderAvailability';

import type { CloudTask } from '../../lib/native';
import { cloudSidebarAccount } from '../../lib/cloudSidebarAccount';
import { folderRepository, useMachineCheckouts, useSidebarRepositories } from './sidebarRepositories';
import { groupRepositories } from './repositoryGroups';
import { labelProjects } from './projectLabels';
import type { RepositoryDestination } from '../../../shared/model/repositorySidebar';

const EMPTY_CLOUD: CloudTask[] = [];

export interface ProjectGroupData {
  repositoryKey?: string;
  repository?: string;
  machineGroups?: string[];
  /** Original folders of merged Host checkouts, retained by Remove from sidebar. */
  machineFolderAliases?: string[];
  cloudTasks?: CloudTask[];
  locations?: RepositoryDestination[];
  locationKinds?: HostLocationKind[];
  localAvailable?: boolean;
  /** Host shared by the project's sessions, independent of its new-chat destinations. */
  sessionHostId?: string;
  id: string | null;
  path: string;
  name: string;
  /** The machine name or parent folder, shown when the icon and name do not distinguish listed groups. */
  hint?: string;
  threads: Thread[];
  starting?: ChatStart[];
  saved: boolean;
  /** Saved aliases represented by this row; removal must retire all of them. */
  projectIds?: string[];
  /** Persisted pins naming this folder by any saved id or canonical local path; unpin retires all of them. */
  pinnedKeys?: string[];
  /** the machine the folder is on, for a folder group of chats that run on a machine: its path is that machine's, never looked up on this Mac */
  machine?: { id: string; name: string; scope?: string };
  /** Recorded machine folders before checkout resolution, for recognizing legacy saved entries. */
  machineFolders?: Set<string>;
}

/**
 * Sidebar groups: saved projects (projects.json), plus other folders chats ran in,
 * whichever harness ran them (Claude has no project list; Codex chats can run outside a project).
 * Chats in the projectless task folder (~/Documents/MoPilot/<date>/<slug>) and the home folder go to
 * Recents. Folder groups are remembered after their last chat is archived, but the sidebar lists (`listed`)
 * only a group with an active or starting chat, as Claude Code's sidebar drops a folder whose sessions are all
 * archived: a pinned group stays, so does the home page's target (`homeKey`, the new chat's project or folder, picked
 * or by default), and every group does while the launch has not said what the groups hold (the lists, or which machine
 * an ACP chat is on).
 * Two listed groups with the same icon and name show where they differ.
 */
export const EMPTY_IDS: string[] = [];
export { groupKey };
export const RECENTS_ORDER = '@recents';
export const LIST_ORDER = '@list';
export const PINNED_ORDER = '@pinned';
export type ReorderChat = (key: string, ids: string[], from: string, target: string, after: boolean) => void;
export function sortManual<T>(items: T[], order: string[], key: (item: T) => string) {
  const rank = new Map(order.map((id, i) => [id, i]));
  // New chats stay at the top; existing rows retain their order.
  return items.sort((a, b) => (rank.get(key(a)) ?? -1) - (rank.get(key(b)) ?? -1));
}
export function movedTo(ids: string[], from: string, target: string, after: boolean) {
  if (from === target || !ids.includes(from) || !ids.includes(target)) return null;
  const next = ids.filter((id) => id !== from);
  next.splice(next.indexOf(target) + Number(after), 0, from);
  return next;
}
const EMPTY_NAMES: Record<string, string> = {};
const EMPTY_ORDER: Record<string, string[]> = {};
export function useProjectGroups(withRepositories = false) {
  const starting = useChatStarts();
  const threads = useStore((s) => s.threads);
  const order = useStore((s) => s.threadOrder);
  const savedProjects = useStore((s) => s.savedProjects);
  const worktreeOf = useStore((s) => s.worktreeOf);
  const pinnedP = useStore((s) => s.prefs.pinnedProjects ?? EMPTY_IDS);
  const projectSort = useStore((s) => s.prefs.projectSort ?? 'updated');
  const sidebarFolders = useStore((s) => s.prefs.sidebarFolders ?? EMPTY_IDS);
  const chatSort = useStore((s) => s.prefs.chatSort ?? 'updated');
  const chatOrder = useStore((s) => s.prefs.chatOrder ?? EMPTY_ORDER);
  const projectOrder = useStore((s) => s.prefs.sidebarProjectOrder ?? EMPTY_IDS);
  const segments = useStore((s) => s.segments);
  const momoChats = useStore((s) => s.momoChats);
  const home = useStore((s) => s.home);
  const hiddenFolders = useStore((s) => s.prefs.hiddenFolders ?? EMPTY_IDS);
  const folderNames = useStore((s) => s.prefs.folderNames ?? EMPTY_NAMES);
  const collapsed = useStore((s) => s.collapsedProjects);
  const projectless = useStore((s) => projectlessFolderOf(s.prefs, s.home));
  const loading = useLoadingEmpty();
  // the row the home page is: where the new chat being written goes, picked or by default (./homeTarget)
  const target = useStore(useShallow(homeTarget));
  // a folder picked for it is resolved on every page, so arriving on the home page never waits for its canonical path
  const pickedProject = useStore((s) => s.newChatProjectId);
  const pickedCwd = useStore((s) => s.newChatCwd);
  const linked = useFamilyLineage();
  const { owners, status, answered } = useHostChats();
  const { machines } = useHostMachines();
  const cloudState = useStore((s) => (s.cloudSidebar?.account === cloudSidebarAccount(s) ? s.cloudSidebar : undefined));
  const cloudTasks = useStore((s) =>
    !s.cloudSidebar || s.cloudSidebar.account === cloudSidebarAccount(s) ? (s.cloudTasks ?? EMPTY_CLOUD) : EMPTY_CLOUD,
  );
  const draftRepository = useStore((s) => (s.route.name === 'home' ? s.newChatRepositoryGroup?.key : undefined));
  const cloudDraft = useStore((s) => (s.route.name === 'home' ? s.newChatCloudEnv?.id : undefined));
  // the machine a chat runs on: '' for this Mac, null until main has said (only a chat drawn as an ACP chat can be on one)
  const ownerOf = useCallback(
    (id: string) => (id.startsWith('acp:') ? machineOfChat({ owners, status, answered }, id) : ''),
    [owners, status, answered],
  );
  // a folder on a machine is that machine's path: this Mac neither resolves nor looks it up, nor does it while it is not known yet where the chat runs
  const thisMac = (id: string) => ownerOf(id) === '';
  // Private MoMo chats and their switched native sessions never supply local folders or worktree origins.
  const localPaths = [
    ...Object.values(threads)
      .filter((t) => thisMac(t.id) && !momoOwned(momoChats, segments, t.id))
      .map((t) => t.cwd || ''),
    ...Object.entries(worktreeOf)
      .filter(([id]) => thisMac(id) && !momoOwned(momoChats, segments, id))
      .map(([, p]) => p),
  ];
  // Legacy prefs may remember a machine folder as a bare path. Every remote/unknown owner, including a private
  // chat, keeps it ambiguous until independent local evidence permits a read; explicit machine keys stay remote.
  const ambiguous = new Set(
    Object.values(threads)
      .filter((t) => !thisMac(t.id))
      .map((t) => t.cwd),
  );
  const local = new Set([
    ...savedProjects.flatMap((p) => p.roots.map((r) => r.path)),
    ...localPaths,
    ...starting.filter((s) => !s.hostId).map((s) => s.cwd),
  ]);
  const localFolder = (p: string) => !machineFolderOf(p) && (!ambiguous.has(p) || local.has(p));
  const { resolve, ready } = useProjectPaths(
    [
      home,
      projectless,
      ...savedProjects.flatMap((p) => p.roots.map((r) => r.path)),
      ...pinnedP.filter((p) => localFolder(p) && isAbsolutePath(p)),
      ...(pickedCwd && !pickedProject ? [pickedCwd] : []),
      ...sidebarFolders.filter(localFolder),
      ...hiddenFolders.filter(localFolder),
      ...starting.filter((s) => !s.hostId).map((s) => s.cwd),
      ...localPaths.flatMap((p) => [p, foldClaudeWorktree(p)]),
    ],
    FOLDER_RECHECK_MS,
  );
  const families = useMemo(() => {
    const hidden = segmentNatives(segments);
    const shown = order
      .map((id) => threads[id])
      .filter((t): t is Thread => !!t && !t.parentThreadId && !t.ephemeral && !hidden.has(t.id) && !isMomoChat(momoChats, t.id));
    // Recency places a whole family where its newest listed member would appear, with the head first.
    return sidebarFamilies(
      linked,
      shown.sort(byActivity).map((t) => t.id),
    );
  }, [threads, order, segments, momoChats, linked]);
  const machinePathOf = useMachineCheckouts(
    [
      ...sidebarFolders,
      ...projectOrder,
      ...pinnedP,
      ...Object.keys(folderNames),
      ...Object.keys(chatOrder),
      ...Object.keys(collapsed),
      ...(target?.kind === 'machine' ? [machineFolderKey(target.id, target.path)] : []),
      ...starting.flatMap((entry) => (entry.hostId ? [machineFolderKey(entry.hostId, entry.cwd)] : [])),
      ...families.roots.flatMap((id) => {
        const machine = ownerOf(id);
        const cwd = threads[id].cwd;
        return machine && cwd ? [machineFolderKey(machine, cwd)] : [];
      }),
    ],
    machines,
  );
  const machineKeyOf = useCallback((key: string) => machineProjectKey(key, machinePathOf), [machinePathOf]);
  const result = useMemo(() => {
    const folderKey = (p: string) => pathKey(resolve(p));
    const sameFolder = (a: string, b: string) => samePath(resolve(a), resolve(b));
    const list = families.roots.map((id) => threads[id]);
    const groups: ProjectGroupData[] = [];
    const identityRank = new Map(projectOrder.map((id, index) => [id, index]));
    const byId = new Map<string, ProjectGroupData>();
    const savedFolders = new Map<string, ProjectGroupData>();
    for (const p of savedProjects) {
      const path = p.roots[0]?.path ?? '';
      let group = path ? savedFolders.get(folderKey(path)) : undefined;
      if (group) {
        group.projectIds = [...(group.projectIds ?? [group.id!]), p.id];
        // Visible keys lead the saved order after a drag; hidden alias keys are appended after them.
        // Keep that identity when main refreshes its independently reordered project list, and on restart.
        if ((identityRank.get(p.id) ?? Infinity) < (identityRank.get(group.id!) ?? Infinity))
          Object.assign(group, { id: p.id, path, name: p.name });
      }
      if (!group) {
        group = { id: p.id, path, name: p.name, threads: [], saved: true };
        groups.push(group);
        if (path) savedFolders.set(folderKey(path), group);
      }
      // Retain every saved id as an assignment to the representative; no persisted ids are removed.
      byId.set(p.id, group);
    }
    const recents: Thread[] = [];
    const folders = new Map<string, ProjectGroupData>();
    const onMachines = new Set<string>();
    // a hidden folder hides each spelling of it (/private/tmp/x and /tmp/x on macOS)
    const folderHidden = (path: string) => hiddenFolders.some((h) => sameFolder(h, path));
    const machineById = new Map(machines.map((machine) => [machine.id, machine]));
    const machineNames = new Map(Object.entries(folderNames).map(([key, name]) => [machineKeyOf(key), name]));
    /** A folder group on a machine, kept under the machine's key: its path is never read as a path of this Mac. */
    const machineGroup = (id: string, folder: string): ProjectGroupData | null => {
      const path = machinePathOf(id, folder);
      const key = machineFolderKey(id, path);
      if (hiddenFolders.includes(key) || hiddenFolders.includes(machineFolderKey(id, folder))) return null;
      onMachines.add(folder);
      if (path === machineProjectPath(folder)) onMachines.add(path);
      let g = folders.get(key);
      const machine = machineById.get(id);
      if (!g)
        folders.set(
          key,
          (g = {
            id: null,
            path,
            name: folderNames[key] ?? machineNames.get(key) ?? basename(path),
            machine: { id, name: machine?.name ?? id, ...(machine?.repositoryScope && { scope: machine.repositoryScope }) },
            machineFolders: new Set(),
            threads: [],
            saved: false,
          }),
        );
      g.machineFolders!.add(folder);
      return g;
    };
    for (const entry of sidebarFolders) {
      const there = machineFolderOf(entry);
      if (there) {
        machineGroup(there.machineId, there.path);
        continue;
      }
      const path = entry;
      if (!folderHidden(path) && !savedProjects.some((p) => p.roots.some((r) => sameFolder(r.path, path))) && !folders.has(folderKey(path)))
        folders.set(folderKey(path), { id: null, path, name: folderNames[path] ?? basename(path), threads: [], saved: false });
    }
    const place = (t: Pick<Thread, 'id' | 'projectId' | 'cwd'>, localProject?: string | null, machineId = ''): ProjectGroupData | null => {
      // a chat on a machine goes by that machine's folder, never by this Mac's projects or folders
      if (machineId) return t.cwd ? machineGroup(machineId, t.cwd) : null;
      // A removed captured local id must not be reinterpreted as another project's native id.
      const target = localProject === undefined ? t : { ...t, projectId: null };
      let proj =
        (localProject ? savedProjects.find((p) => p.id === localProject) : null) ?? projectForThread(target, savedProjects, resolve);
      if (!proj && worktreeOf[t.id]) proj = savedProjects.find((p) => p.roots.some((r) => sameFolder(r.path, worktreeOf[t.id]))) ?? null;
      if (!proj) {
        const wt = inferWorktreeProject(t.cwd, savedProjects);
        if (wt) proj = wt;
      }
      if (proj) return byId.get(proj.id)!;
      else {
        const original = foldClaudeWorktree(worktreeOf[t.id] ?? t.cwd ?? '');
        const path = chatFolder(resolve(original), resolve(home), resolve(projectless)) ? original : null;
        if (!path || folderHidden(path)) {
          return null;
        }
        // Deleted worktrees may only resolve after folding; reuse the saved folder's identity then too.
        let g = savedFolders.get(folderKey(path)) ?? folders.get(folderKey(path));
        if (!g)
          folders.set(folderKey(path), (g = { id: null, path, name: folderNames[path] ?? basename(path), threads: [], saved: false }));
        return g;
      }
    };
    for (const t of list) {
      const owner = ownerOf(t.id);
      // not known yet which machine it is on (or whether it is on one): it is placed once main says, not by a path that may be a machine's
      const g = owner === null ? null : place(t, undefined, owner);
      if (g) g.threads.push(t);
      else recents.push(t);
    }
    for (const entry of starting) {
      const g = place(entry, entry.projectId, entry.hostId);
      if (g) (g.starting ??= []).push(entry);
    }
    // a folder an older version remembered by the bare path of a machine's folder stays a group of that machine, not a second, empty group of this Mac (see the effect below)
    for (const [key, g] of folders)
      if (
        !g.machine &&
        !g.threads.length &&
        !g.starting?.length &&
        !pinnedP.some((pin) => !machineFolderOf(pin) && sameFolder(pin, g.path)) &&
        (onMachines.has(g.path) || onMachines.has(machineProjectPath(g.path)))
      )
        folders.delete(key);
    groups.push(...folders.values());
    // A pin can predate a saved project or the merging of two aliases: grouping and pin controls share that identity.
    const pins = new Set(pinnedP);
    const folderPins = new Map<string, string[]>();
    for (const pin of pinnedP) {
      if (machineFolderOf(pin) || !isAbsolutePath(pin)) continue;
      const key = folderKey(pin);
      folderPins.set(key, [...(folderPins.get(key) ?? []), pin]);
    }
    for (const g of groups) {
      const keys = [groupKey(g), ...(g.projectIds ?? []), ...(!g.machine ? (folderPins.get(folderKey(g.path)) ?? []) : [])];
      g.pinnedKeys = g.machine
        ? pinnedP.filter((key) => !hiddenFolders.includes(key) && machineKeyOf(key) === groupKey(g))
        : [...new Set(keys)].filter((key) => pins.has(key));
    }
    const pinnedGroups = groups.filter((g) => g.pinnedKeys!.length > 0).map(groupKey);
    // until main says which machine each ACP chat is on, those chats wait in Recents: their groups are not known to be empty
    const placing = list.some((t) => ownerOf(t.id) === null);
    const hiddenTarget = target?.kind === 'machine' && hiddenFolders.includes(machineFolderKey(target.id, target.path));
    const homeGroup = target && !hiddenTarget ? groups.find((g) => isHomeTarget(g, target, sameFolder, machinePathOf)) : undefined;
    const isListed = (g: ProjectGroupData) =>
      loading || placing || g.threads.length > 0 || !!g.starting?.length || g.pinnedKeys!.length > 0 || g === homeGroup;
    // Manual chat ordering is independent of project placement; new chats go first.
    if (chatSort === 'manual')
      for (const g of groups)
        sortManual(
          g.threads,
          g.machine ? machineProjectChatOrder(chatOrder, groupKey(g), machineKeyOf) : (chatOrder[groupKey(g)] ?? []),
          (t) => t.id,
        );
    // Project sorting never changes chat sorting. Pinning partitions either project order.
    sortProjectGroups(groups, [...new Set(projectOrder.map(machineKeyOf))], pinnedGroups, projectSort);
    const rank = new Map(families.roots.map((id, i) => [id, i]));
    const recentChats = [...recents, ...groups.flatMap((g) => g.threads)].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    if (chatSort === 'manual') sortManual(recentChats, chatOrder[RECENTS_ORDER] ?? [], (t) => t.id);
    return {
      groups,
      listed: groups.filter(isListed),
      recents: recentChats,
      homeKey: homeGroup ? groupKey(homeGroup) : null,
      descendants: families.descendants,
    };
  }, [
    threads,
    starting,
    families,
    savedProjects,
    worktreeOf,
    pinnedP,
    projectSort,
    projectOrder,
    sidebarFolders,
    chatSort,
    chatOrder,
    home,
    hiddenFolders,
    folderNames,
    projectless,
    loading,
    target,
    resolve,
    ownerOf,
    machines,
    machineKeyOf,
    machinePathOf,
  ]);
  useEffect(() => {
    if (!ready) return;
    // Remember inferred folders before an archive empties a group; discovery preserves existing placement.
    const patch = folderPrefsPatch(result.groups, getState().prefs, resolve, machineKeyOf);
    if (patch) setPrefs(patch);
  }, [result.groups, ready, resolve, machineKeyOf]);
  // Keep every group as a revalidation candidate, with its identity/order and chats intact, even while unavailable.
  const availability = useFolderAvailability(result.groups.filter((g) => !g.machine && localFolder(g.path)).map((g) => g.path));
  const facts = useSidebarRepositories(
    result.groups.filter((g) => g.machine || localFolder(g.path)),
    machines,
    withRepositories && (result.groups.some((group) => group.machine) || !!cloudState?.environments.length),
  );
  return useMemo(() => {
    const listedKeys = new Set(result.listed.map(groupKey));
    const projection = withRepositories
      ? groupRepositories(
          result.groups,
          listedKeys,
          (group) => folderRepository(facts, group, machines),
          cloudTasks,
          cloudState?.environments ?? [],
          hiddenFolders,
          result.homeKey,
          pinnedP,
          cloudState?.unplacedTasks,
        )
      : { ...result, groups: result.groups.map((group) => ({ ...group })), cloud: EMPTY_CLOUD };
    const { groups } = projection;
    const ranks = new Map(result.recents.map((thread, index) => [thread.id, index]));
    for (const group of groups) {
      if (!group.machine && group.path) group.localAvailable = availability[group.path] !== false;
      if (group.repositoryKey) group.name = folderNames[group.repositoryKey] ?? group.name;
      if (group.locations?.length && group.pinnedKeys?.length) group.pinnedKeys = [...new Set(group.pinnedKeys)];
      if (!group.locations?.some((location) => location.kind === 'machine')) continue;
      if (chatSort === 'manual') group.threads = sortManual([...group.threads], chatOrder[groupKey(group)] ?? [], (thread) => thread.id);
      else group.threads = [...group.threads].sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0));
    }
    const pins = groups.filter((group) => group.pinnedKeys?.length).map(groupKey);
    sortProjectGroups(groups, [...new Set(projectOrder.map(machineKeyOf))], pins, projectSort);
    const projectedKeys = new Set(projection.listed.map(groupKey));
    const listed = groups.filter(
      (g) => (projectedKeys.has(groupKey(g)) || g.pinnedKeys?.length) && (g.localAvailable !== false || g.locations?.length),
    );
    const homeKey = cloudDraft || !projection.homeKey ? (draftRepository ?? projection.homeKey) : projection.homeKey;
    // Only visible names need disambiguation; a restored folder gets its old identity and position back.
    labelProjects(listed, machines, ownerOf, result.descendants);
    return {
      cloud: projection.cloud,
      machineKeyOf,
      recents: result.recents,
      groups,
      listed,
      homeKey: listed.some((g) => groupKey(g) === homeKey) ? homeKey : null,
    };
  }, [
    result,
    availability,
    facts,
    cloudTasks,
    cloudState,
    hiddenFolders,
    pinnedP,
    chatSort,
    chatOrder,
    projectOrder,
    projectSort,
    draftRepository,
    cloudDraft,
    machines,
    withRepositories,
    folderNames,
    ownerOf,
    machineKeyOf,
  ]);
}

/**
 * Whether this group is the home page's target (homeTarget): a project by any of its saved ids, a folder of this Mac by its
 * canonical path, or a folder on a machine by the machine and its path there.
 */
function isHomeTarget(
  g: ProjectGroupData,
  target: HomeTarget,
  sameFolder: (a: string, b: string) => boolean,
  machinePathOf: (id: string, path: string) => string,
) {
  if (target.kind === 'project') return g.id === target.id || !!g.projectIds?.includes(target.id);
  if (target.kind === 'folder') return !g.machine && sameFolder(g.path, target.path);
  return g.machine?.id === target.id && g.path === machinePathOf(target.id, target.path);
}

/** Threads in ~/.mopilot/worktrees or the official app's ~/.codex/worktrees (<id>/<repo>) belong to the repo's project. */
function inferWorktreeProject(cwd: string, projects: SavedProject[]) {
  const repo = codexWorktreeRepo(cwd || '');
  if (!repo) return null;
  return projects.find((p) => p.roots.some((r) => basename(r.path) === repo)) ?? null;
}
