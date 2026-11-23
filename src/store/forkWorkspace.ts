// Fork entrypoints carry the source workspace's repository to each new chat so deleted worktrees remain restorable.
import { recordValue } from '../../shared/recordProperties.mjs';
import { get, set } from './core';

/** Independent forks keep the repository they started from, even if the parent changes while the harness forks. */
export async function forkWithWorkspace(
  chatId: string,
  fork: () => string | undefined | Promise<string | undefined>,
): Promise<string | undefined> {
  const repo = recordValue(get().worktreeOf, chatId);
  const id = await fork();
  if (id && repo) set((s) => (recordValue(s.worktreeOf, id) ? {} : { worktreeOf: { ...s.worktreeOf, [id]: repo } }));
  return id;
}
