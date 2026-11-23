// The home's chats by state or by project (the person's choice, #4819), Needs input first in both and every other chat after it in one list, in the order the computer listed them (its recency); none is folded away. Each chat with its sub-sessions is placed by the most urgent of them, so a family is never split. While the list is the last one read no state is claimed and the chats stay one list.
import { chatChips, nestedState, type ChatStateChip } from './chatChips';
import { groupChats, NO_PROJECT } from './chatGroups';

type StateChat = Parameters<typeof chatChips>[0] & {
  id: string;
  title?: string;
  project?: string | null;
  projectId?: string | null;
  parentId?: string;
};

export type StateSections<T extends StateChat> = {
  /** Waiting for the person, or a linked session that failed: what Claude calls Needs input. */
  needs: T[];
  /** Every other chat (running, idle, finished): one list under no header, in the order the computer listed them. */
  rest: T[];
  /** The last list read while the computer is away: no state is claimed, so the chats are one list. */
  all: T[] | null;
  /** The sub-sessions shown under each listed chat (chatGroups). */
  nested: Map<string, T[]>;
  /** The name a chat's project goes by (told apart from another of its name), for the row that names it. */
  labelOf: (chat: T) => string;
};

const NEEDS: ChatStateChip[] = ['needsYou', 'failed'];

/** Most urgent first: a family raises its chat to the most urgent state any member has (offline never reaches here). */
const RANK: ChatStateChip[] = ['needsYou', 'failed', 'running', 'quiet', 'done', 'idle'];

/** The state a chat is placed by: its own, or its family's when that is more urgent. */
export function placedState(own: ChatStateChip, family: ChatStateChip | null): ChatStateChip {
  return family && RANK.indexOf(family) < RANK.indexOf(own) ? family : own;
}

/** Chats that match the search, by state, in the order the computer listed them; each chat once, its sub-sessions under it. */
export function sectionByState<T extends StateChat>(chats: T[], search: string, now: number, offline: boolean): StateSections<T> {
  const { projects, nested, labelOf } = groupChats(chats, search);
  // the computer's own order (by recency), not grouped by project as the old sections were
  const listed = new Set(projects.flatMap((p) => p.chats));
  const roots = chats.filter((chat) => listed.has(chat));
  if (offline) return { needs: [], rest: [], all: roots, nested, labelOf };
  const out: StateSections<T> = { needs: [], rest: [], all: null, nested, labelOf };
  for (const chat of roots) {
    const family = nested.get(chat.id);
    const state = placedState(chatChips(chat, now).state, family ? nestedState(family, now) : null);
    (NEEDS.includes(state) ? out.needs : out.rest).push(chat);
  }
  return out;
}

/** The project a row names on its grey line now that rows are not listed under their project; none for a chat in no project. */
export const rowProject = (project: string | null | undefined) => (project && project !== NO_PROJECT ? project : undefined);

/** One project's section of the home: its chats, in the order the computer listed them. */
export type ProjectSection<T> = { key: string; name: string; chats: T[] };
export type ProjectSections<T extends StateChat> = {
  /** Needs input, from every project, pinned on top as in the state layout. */
  needs: T[];
  /** One section per project, in the order the computer listed them; the chats that need input are not repeated here. */
  projects: ProjectSection<T>[];
  /** The sub-sessions shown under each listed chat (chatGroups). */
  nested: Map<string, T[]>;
  labelOf: (chat: T) => string;
};

/**
 * Chats that match the search, Needs input on top, then one section per project, the one with the newest chat first and "No project" last (the computer's project id
 * tells two of one name apart, the second numbered; an older computer sends none, so the name does), none folded. A family is placed by its most urgent member and
 * lives in its root's project, never split. While the list is the last one read no state is claimed: every chat sits in its project.
 */
export function sectionByProject<T extends StateChat>(chats: T[], search: string, now: number, offline: boolean): ProjectSections<T> {
  const { projects, nested, labelOf } = groupChats(chats, search);
  const sections = new Map<T, ProjectSection<T>>();
  const out: ProjectSections<T> = { needs: [], projects: [], nested, labelOf };
  for (const group of projects) {
    const section: ProjectSection<T> = { key: group.key, name: group.name, chats: [] };
    out.projects.push(section);
    for (const chat of group.chats) sections.set(chat, section);
  }
  // the computer's own order (by recency) within Needs input and within a project
  for (const chat of chats) {
    const section = sections.get(chat);
    if (!section) continue;
    const family = nested.get(chat.id);
    const state = offline ? 'offline' : placedState(chatChips(chat, now).state, family ? nestedState(family, now) : null);
    (NEEDS.includes(state) ? out.needs : section.chats).push(chat);
  }
  // as the Mac's sidebar sorts its projects by default ("updated"): the project of the newest chat first, whatever that chat's state (a chat that needs input
  // still counts for its project, an idle one counts as much as a running one), equal times in the order the computer listed them; chats of no project
  // come last, as the sidebar lists them apart under Recents
  const newest = new Map(projects.map((g) => [g.key, Math.max(0, ...g.chats.map((c) => c.at ?? 0))]));
  const none = `name:${NO_PROJECT}`;
  const rank = (p: ProjectSection<T>) => (p.key === none ? Number.NEGATIVE_INFINITY : (newest.get(p.key) as number));
  const shown = out.projects.filter((p) => p.chats.length);
  out.projects = shown
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(b.p) - rank(a.p) || a.i - b.i)
    .map(({ p }) => p);
  return out;
}
