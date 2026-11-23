// The writes of a chat's folder on the Host (#5050): commit and discard, the Changes pane's two git actions, run by the same code as this Mac's (electron/platform/commitCore.cjs, shared/gitDiscard.mjs) over the Host's hardened git (hostGit.mjs: no hooks, no fsmonitor, no `ext:`). The folder must lie inside the Host's roots by its real path and inside a work tree; every write is audited before it runs, as metadata only (what it is: never a message, a path or a file), and refused with `audit_unavailable` when the record is required and cannot be written. One write at a time per folder, so two clients cannot race on one index.
import { createRequire } from 'node:module';
import { discardGitChanges, discardGitFile } from '../../shared/gitDiscard.mjs';
import { switchBranch } from '../../shared/gitBranchOps.mjs';
import { HostRefusal } from './hostFs.mjs';
import { runGit } from './hostGit.mjs';

const require = createRequire(import.meta.url);
const { commitWith } = require('../../electron/platform/commitCore.cjs');

/** One git run on a write; a hung disk, a signing prompt nobody can answer or a huge tree answers with a coded refusal instead of holding the panel. */
const RUN_MS = 60_000;
/** The whole of one write, from its arrival: under the 6 minutes the app waits (electron/host/folders.cjs), so the Host has finished or given up before the app does. */
const TOTAL_MS = 5 * 60_000;
/** The most of git's own words a refusal carries back. */
const MAX_WORDS = 4000;
const TOO_LONG = ['write_timed_out', 'The machine took too long to change that folder.'];
/** The last write queued for each repository, whichever writer made it: a commit, a discard and a branch switch share one index, so they take turns. @type {Map<string, Promise<unknown>>} */
const tails = new Map();

/**
 * @param {{ hostFs: ReturnType<typeof import('./hostFs.mjs').createHostFs>, audit?: { governed: (e: any) => boolean }, run?: typeof runGit, totalMs?: number, now?: () => number }} o
 */
export function createHostWrite({ hostFs, audit, run = runGit, totalMs = TOTAL_MS, now = Date.now }) {
  /** Runs `work` after every write already queued for `key`. @template T @param {string} key @param {() => Promise<T>} work @returns {Promise<T>} */
  function serial(key, work) {
    const next = (tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => tails.get(key) === tail && tails.delete(key));
    return next;
  }

  /**
   * The runner of one write: each run stops after RUN_MS or when the write's own time is used up, whichever is first, and a run that is stopped, or asked for after that, is a coded refusal. Every other outcome is the caller's to read.
   * @param {number} deadline when the write must be over (ms since the epoch)
   */
  const gitUntil =
    (deadline) =>
    /** @param {string[]} args @param {string} cwd @param {number} [timeout] @param {NodeJS.ProcessEnv} [env] */
    async (args, cwd, timeout, env) => {
      const left = deadline - now();
      if (left <= 0) throw new HostRefusal(TOO_LONG[0], TOO_LONG[1]);
      const r = /** @type {any} */ (
        await run(args, {
          cwd,
          timeout: Math.min(timeout || RUN_MS, RUN_MS, left),
          env: /** @type {Record<string, string> | undefined} */ (env),
        })
      );
      if (r.signal) throw new HostRefusal(TOO_LONG[0], TOO_LONG[1]);
      return r;
    };

  /**
   * The audited, serialized frame of one write: the folder checked against the roots and as a work tree, one write at a time per repository (a folder and its repository's root share one index), the audit line written first. A stale `index.lock` is never removed: it may be another process's.
   * @param {'commit' | 'discard' | 'switch'} what @param {string} kind the client's kind @param {string} folder
   * @param {(dir: string, prefix: string, git: ReturnType<typeof gitUntil>) => Promise<{ ok: boolean, stdout: string, stderr: string, refused?: true, warning?: string }>} work `prefix`: the folder's place inside its repository, '' at its root
   */
  async function write(what, kind, folder, work) {
    const git = gitUntil(now() + totalMs);
    const dir = await hostFs.requireDirectory(folder);
    const place = await git(['rev-parse', '--show-toplevel', '--show-prefix'], dir);
    if (!place.ok) throw new HostRefusal('not_a_repository', 'This folder is not a git repository.');
    const [top, prefix = ''] = place.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
    return serial(top, async () => {
      audit?.governed({ kind: 'git.write', by: { kind }, what: { kind: what } });
      const result = await work(dir, prefix, git);
      return {
        ok: result.ok === true,
        // the failure of a commit ("nothing to commit") is on standard output: a failure carries both, as this Mac's pane reads both
        stderr: (result.ok ? result.stderr : `${result.stderr}\n${result.stdout}`.trim()).slice(0, MAX_WORDS),
        ...(result.refused ? { refused: /** @type {const} */ (true) } : {}),
        ...(typeof result.warning === 'string' ? { warning: result.warning } : {}),
      };
    });
  }

  return {
    /**
     * Commit every change in the folder (`files` null), or only the named files (paths relative to the folder), as this Mac's Changes pane does.
     * @param {{ path: string, message: string, files: { path: string, oldPath?: string, isCopy?: boolean, isDeleted?: boolean }[] | null }} q @param {string} kind
     */
    commit: (q, kind) =>
      write('commit', kind, q.path, (dir, prefix, git) =>
        // a folder inside its repository commits that folder's own paths: what is staged outside it stays staged
        commitWith(dir, q.message, q.files, { git, baseEnv: () => ({}), folderOnly: prefix !== '' }),
      ),

    /**
     * Discard the changes of one file (a path relative to the folder), or of everything in the folder (`file` null), as this Mac's Changes pane does.
     * @param {{ path: string, file: string | null }} q @param {string} kind
     */
    discard: (q, kind) =>
      write('discard', kind, q.path, (dir, prefix, git) => {
        const runner = { run: (/** @type {string} */ cwd, /** @type {string[]} */ args) => git(args, cwd) };
        return q.file === null ? discardGitChanges(runner, dir, prefix || '.') : discardGitFile(runner, dir, `${prefix}${q.file}`);
      }),

    /**
     * Check out `branch` in the folder where a new chat runs without a worktree, as this Mac does (shared/gitBranchOps.mjs): nothing to do when it is checked out, and a change the branch would collide with is refused in a sentence (`refused`).
     * @param {{ path: string, branch: string }} q @param {string} kind
     */
    switchBranch: (q, kind) =>
      write('switch', kind, q.path, async (dir, _prefix, git) => {
        const r = await switchBranch((args, cwd) => git(args, cwd), dir, q.branch);
        return r.ok
          ? { ok: true, stdout: '', stderr: '' }
          : { ok: false, stdout: '', stderr: r.error, refused: /** @type {const} */ (true) };
      }),
  };
}
