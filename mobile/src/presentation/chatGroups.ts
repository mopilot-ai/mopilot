// How the chat list is laid out: one section per project, each sub-session under the chat that started it; a search narrows all.
import { chatFamilies } from '../../../shared/chatFamilies.mjs';

type GroupChat = {
  id: string;
  title?: string;
  state?: string;
  pinned?: boolean;
  project?: string | null;
  projectId?: string | null;
  /** What tells this chat's project from another of its name (the Mac sends it only for a shared name; an older Mac sends none). */
  projectHint?: string;
  parentId?: string;
};
/** `key` is what a group is told apart by (and folds by); `name` is what it shows, numbered when two projects share one. */
export type ChatGroup<T extends GroupChat> = { key: string; name: string; chats: T[] };
/** `nested` holds, by the id of a listed chat, the sub-sessions it started (theirs too, depth first), which are listed nowhere else. */
export type ChatSections<T extends GroupChat> = {
  projects: ChatGroup<T>[];
  nested: Map<string, T[]>;
  /** The name a chat's project goes by here: its own name, told apart from another of the name by the Mac's hint, else numbered. */
  labelOf: (chat: T) => string;
};

export const NO_PROJECT = 'No project';

/** The name a chat's project shows under, as the computer names it; a chat in none is "No project". */
export const projectName = (project: string | null | undefined) => project || NO_PROJECT;

/** Chats that match the search (by title or project name), one section per project in the order the computer listed them, as Claude's Code list groups them; each chat is listed once. */
export function groupChats<T extends GroupChat>(chats: T[], search: string): ChatSections<T> {
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? chats.filter((chat) => `${chat.title ?? 'Untitled chat'}\n${projectName(chat.project)}`.toLowerCase().includes(needle))
    : chats;
  // a sub-session is nested under the chat that started it while that chat is listed too, as the Mac's sidebar nests it
  const byId = new Map(shown.map((chat) => [chat.id, chat]));
  const families = chatFamilies(
    shown.map((chat) => chat.id),
    (id) => byId.get(id)?.parentId,
  );
  const nested = new Map<string, T[]>();
  for (const [id, rows] of families.descendants)
    if (rows.length)
      nested.set(
        id,
        rows.map((row) => byId.get(row) as T),
      );
  const projects: ChatGroup<T>[] = [];
  const keyOf = (chat: T) => (chat.projectId ? `id:${chat.projectId}` : `name:${projectName(chat.project)}`);
  /** the hint the Mac gave each group */
  const hintOf = new Map<string, string>();
  for (const chat of families.roots.map((id) => byId.get(id) as T)) {
    // two projects can share a name: the computer's project id tells them apart (an older computer sends none, so the name does)
    const key = keyOf(chat);
    const group = projects.find((g) => g.key === key);
    if (group) group.chats.push(chat);
    else {
      projects.push({ key, name: projectName(chat.project), chats: [chat] });
      if (chat.projectHint) hintOf.set(key, chat.projectHint);
    }
  }
  // a name two projects share is told apart as the Mac's sidebar does where the Mac says how (the last parent folders), else the second is numbered
  const sameName = new Map<string, ChatGroup<T>[]>();
  for (const g of projects) sameName.set(g.name, [...(sameName.get(g.name) ?? []), g]);
  for (const same of sameName.values()) {
    if (same.length < 2) continue;
    let plain = 0;
    for (const g of same) {
      const hint = hintOf.get(g.key);
      if (hint) g.name = `${g.name} · ${hint}`;
      else if (++plain > 1) g.name = `${g.name} (${plain})`;
    }
  }
  const labels = new Map(projects.map((g) => [g.key, g.name]));
  return { projects, nested, labelOf: (chat) => labels.get(keyOf(chat)) ?? projectName(chat.project) };
}
