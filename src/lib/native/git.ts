// window.native.git's types (git and gh), merged into NativeApi; the calls are declared in electron/bridge/git.cjs.
import type { LinearSource } from './linear';
import type { BranchList, GitInfo, GitStatusFile, ManagedWorktree, WorktreeCopy } from '../native';

/** A pull request to start from (electron/platform/prSource.cjs): `checkout` is the branch its worktree works on. */
export type PullRequestSource =
  | {
      ok: true;
      number: number;
      title: string;
      url: string;
      state: 'OPEN' | 'CLOSED' | 'MERGED';
      base: string;
      head: string;
      fork: boolean;
      /** an open branch of origin's, worked on as itself; else worked on as a copy, `pr/<n>` */
      own: boolean;
      checkout: string;
    }
  | { ok: false; error: string };

/** A GitHub issue to start from (electron/platform/issueSource.cjs); `context` is its text quoted for the agent, read when the chat starts. */
export type IssueSource =
  | { ok: true; kind: 'issue'; number: number; title: string; url: string; state: 'OPEN' | 'CLOSED'; context?: string }
  | { ok: false; error: string };

/** What the branch picker's search names (electron/platform/startSource.cjs): a pull request, or (`kind`) a GitHub or Linear issue. */
export type StartSource = PullRequestSource | IssueSource | LinearSource;

declare module '../native' {
  interface NativeApi {
    git: {
      sidebarRepository(cwd: string): Promise<string | null>;
      info(cwd: string): Promise<GitInfo | null>;
      status(cwd: string, fresh?: boolean): Promise<{ files: GitStatusFile[] } | null>;
      diff(cwd: string, file?: string, fresh?: boolean): Promise<string>;
      run(cwd: string, args: string[]): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>;
      gh(cwd: string, args: string[]): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>;
      /** Commit every change (`files` null) or only those files, in `root` (their paths are relative to it); the index changes only once committed. `refused`: stderr is a sentence for the user. */
      commitFiles(
        root: string,
        message: string,
        files: { path: string; oldPath?: string; isCopy?: boolean; isDeleted?: boolean }[] | null,
      ): Promise<{ ok: boolean; stdout: string; stderr: string; refused?: true; warning?: string }>;
      /** Local branches for the branch picker (origin's default first) and the checked-out one; null outside a repo. */
      branches(cwd: string): Promise<BranchList | null>;
      /** Check out a branch where a chat runs without a worktree. */
      switchBranch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }>;
      /** The pull request or issue `text` (`#12`, or either's link) names in cwd's origin repository, or why not. */
      startSource(cwd: string, text: string): Promise<StartSource>;
      /** Find pull request `number` again and fetch its head, before a chat starts on it. */
      fetchPullRequest(cwd: string, number: number): Promise<PullRequestSource>;
      /** Find issue `number` again, with its text quoted for the agent, before a chat starts from it. */
      issue(cwd: string, number: number): Promise<IssueSource>;
      /** `unsupported`: the folder can't hold a worktree (not a repository, or no commits), so a chat can start in it instead. */
      worktreeAdd(
        cwd: string,
        opts?: {
          prefix?: string;
          root?: string | null;
          branch?: string | null;
          startPoint?: 'head';
          /** an existing branch to work on (a fetched pull request's); `branch` is then its base */
          checkout?: string;
          /** a fork's pull request: its head was fetched to a ref of MoPilot's own */
          pullRequest?: number;
          /** a branch named for the chat's task (a Linear issue's suggested one): made from `branch`, or used when it exists */
          newBranch?: string;
        },
      ): Promise<{
        ok: boolean;
        path?: string;
        worktree?: string;
        branch?: string;
        repo?: string;
        error?: string;
        unsupported?: boolean;
        copy?: WorktreeCopy;
      }>;
      /** The managed worktree a path is in. */
      worktreeInfo(p: string): Promise<ManagedWorktree | null>;
      /** The worktrees of `cwd`'s repository that were adopted in place (Conductor workspaces brought over); null when git could not say. */
      worktreeAdopted(cwd: string): Promise<{ path: string; name: string; branch: string | null }[] | null>;
      /** Every worktree under root, managed or not. */
      worktreeList(root: string): Promise<{ path: string; repo: string | null; branch: string | null }[]>;
      /** Recreate a deleted managed worktree from its kept branch (cwd is where the chat ran; prefix: Settings' branch prefix); nothing to do when it exists. */
      worktreeRestore(
        cwd: string,
        root: string | null,
        repo: string | null,
        prefix?: string | null,
      ): Promise<{
        ok: boolean;
        restored?: boolean;
        branch?: string;
        worktree?: string;
        repo?: string;
        error?: string;
        copy?: WorktreeCopy;
      }>;
      /** Delete the oldest managed worktrees over `limit`, skipping ones in `keep` (chat cwds) or with changes. */
      worktreePrune(root: string, limit: number, keep: string[]): Promise<string[]>;
      /** Remove an archived chat's managed worktree and delete its branch when nothing on them is lost; `kept` says why not. */
      worktreeArchive(
        cwd: string,
      ): Promise<{ ok: true; removed: boolean; deleted?: { branch: string }; kept?: string } | { ok: false; error: string }>;
      applyPatch(cwd: string, patch: string, reverse: boolean): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>;
    };
  }
}
