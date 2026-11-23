// DEV ONLY: the fake Mac's chats.recent rows: newest first, a page of them, each as the Mac names a chat (its project by id, the logins it names, the chat that started it).
import { projectHints } from '../../shared/paths.mjs';

/**
 * @param {Iterable<any>} all every chat the fake app holds
 * @param {{ limit: number, archived: boolean, offset: number }} page
 */
export function recentRows(all, { limit, archived, offset }) {
  const chats = [...all];
  // two projects of one name are told apart by their folders, as the Mac's list does it (shared/paths.mjs)
  const hints = projectHints([
    ...new Map(
      chats
        .filter((c) => c.project)
        .map((c) => [c.projectId ?? c.project, { id: c.projectId ?? c.project, name: c.project, path: c.projectPath }]),
    ).values(),
  ]);
  return (
    chats
      // the archive is its own list, as the Mac's is
      .filter((c) => !c.hidden && !c.unlisted && !!c.archived === archived)
      .sort((a, b) => b.at - a.at)
      .slice(offset, offset + limit)
      .map(({ id, title, harness, at, project, projectId, account, accountDefault, pinned, parentId, ended }) => ({
        id,
        title,
        harness,
        at,
        project,
        projectId: projectId ?? project,
        ...(hints.get(projectId ?? project) && { projectHint: hints.get(projectId ?? project) }),
        account,
        // whether that login is the computer's default (the Mac says so only for a chat on its active login)
        ...(account && accountDefault && { accountDefault: true }),
        pinned,
        // a linked session names the chat that started it and how its last turn ended, as the Mac's list does
        ...(parentId && { parentId, ended }),
      }))
  );
}
