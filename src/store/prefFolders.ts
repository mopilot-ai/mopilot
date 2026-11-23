// Where the folder prefs put things: managed worktrees, projectless chats, and the Codex app's worktree folders main refuses.
import type { Prefs } from './types';

/** `rel` under the home folder, with Windows separators when home is a Windows path (lib/paths joinPath, inlined for unit tests). */
const homeJoin = (home: string, rel: string) =>
  /^[A-Za-z]:|^\\\\/.test(home) ? `${home.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}` : `${home}/${rel}`;
/** Where managed worktrees go: the setting, else ~/.mopilot/worktrees. */
export const worktreeRootOf = (prefs: Pick<Prefs, 'worktreeRoot'>, home: string) =>
  prefs.worktreeRoot || homeJoin(home, '.mopilot/worktrees');
/** Where projectless chats get their folders: the setting, else ~/Documents/MoPilot. */
export const projectlessFolderOf = (prefs: Pick<Prefs, 'projectlessFolder'>, home: string) =>
  prefs.projectlessFolder || homeJoin(home, 'Documents/MoPilot');

/** `p` with forward slashes, no trailing one and in one case (macOS and Windows disks ignore it), for comparing folders. */
const slashed = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Whether a worktree root as typed in Settings (`~` is home) is a Codex app worktree folder or inside one:
 * ~/.codex/worktrees or `codexHome`'s. Main refuses to make worktrees there (electron/platform/git.cjs
 * inCodexWorktrees): the app's cleanup deletes them.
 */
export function inCodexWorktrees(root: unknown, home: string, codexHome: string): boolean {
  if (typeof root !== 'string' || !root.trim()) return false;
  const r = slashed(root.trim().replace(/^~(?=$|[\\/])/, home));
  return [`${home}/.codex`, codexHome].some((c) => {
    const codex = slashed(`${c}/worktrees`);
    return r === codex || r.startsWith(`${codex}/`);
  });
}
