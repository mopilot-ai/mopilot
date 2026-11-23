// The worktree tools a chat uses to look after the disk and its branch, as Claude Desktop's ccd_host ones
// (get_storage_usage, clean_up_worktrees, discard_kept_worktree, sync_with_base_branch), the same on Codex, Claude Code and
// admitted ACP harnesses, with or without a window open. Nothing is deleted without the user's card naming it, a worktree
// a chat works in is never touched, and the checks are made again after the card, when its answer comes.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { ToolError } = require('../contract/registry.cjs');
const { toolAdder, askUser, plural, sizeText } = require('./hostToolKit.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** storage -> the removal under way on it (one queue per storage, whichever registration asks) */
const REMOVING = new WeakMap();
const DAY_MS = 86_400_000;
const LIST_MAX = 50;
const FETCH_TIMEOUT_MS = 120_000;

const USAGE =
  'Report how much disk the worktrees this app made take, how many are held by sessions, how many hold uncommitted changes, which are idle and clean, and how much space the disk has left. Read-only. Use it before clean_up_worktrees, or when the user asks where their disk space went. `refresh` measures again (a measurement under a minute old is reused otherwise).';
const CLEANUP =
  'Remove old worktrees this app made, to free disk space. Only worktrees older than `older_than_days` (default 7) that no session works in are considered, and those with uncommitted changes only with `include_uncommitted`. The user sees what would go on a card and approves it first. Branches are kept: a removed worktree comes back from its branch when its session is opened again. Run get_storage_usage first to see what there is.';
const DISCARD =
  'Delete one worktree this app made, with any uncommitted changes in it, and keep its branch. Use it for a worktree that get_storage_usage lists as holding uncommitted changes, after the user said to discard it. The user approves it on a card that names it. A worktree a session works in is refused.';
const SYNC =
  "Bring this session's worktree up to date with its base branch: fetch the base from origin and merge it into the branch (never a rebase, never a force-push). Use it for merge conflicts or when you need the base's latest commits instead of running git merge or git pull yourself. If the merge stops on conflicts, the result lists the files: resolve them, then commit and push; or call again with `abort: true` to put the branch back. It refuses a worktree with uncommitted changes, a detached HEAD or a git operation in progress. In any other checkout it does nothing: merge the base branch yourself there.";

/** Days between `createdAt` and `now`, rounded down. */
const ageDays = (/** @type {number} */ createdAt, /** @type {number} */ now) => Math.max(0, Math.floor((now - createdAt) / DAY_MS));

/**
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat a call came from
 * @param {ReturnType<typeof import('../../platform/worktreeStorage.cjs').createWorktreeStorage>} o.storage
 * @param {{ resolve(chatId: string, p: unknown): Promise<{ path: string, isDirectory: boolean }> }} o.sessionFolders
 * @param {(chatId: string, signal: AbortSignal | null, card: object) => Promise<any>} o.ask puts a card to the user
 * @param {(args: string[], cwd: string, timeout?: number) => Promise<{ ok: boolean, stdout: string, stderr: string }>} o.git
 * @param {(p: string) => { path: string, repo: string, branch: string | null, sourceBranch?: string } | null} o.worktreeInfo the managed worktree a path is in
 * @param {() => number} [o.now]
 * @returns {() => void} removes the tools
 */
function registerWorktreeTools(registry, { owner, storage, sessionFolders, ask, git, worktreeInfo, now = Date.now }) {
  const add = toolAdder(registry, owner);

  /** The removal under way for this storage: another chat's clean-up or discard waits for it, so no worktree is removed twice at once. */
  const serially = (/** @type {() => Promise<any>} */ run) => {
    const next = (REMOVING.get(storage) ?? Promise.resolve()).then(run);
    REMOVING.set(
      storage,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };

  /** Removes each of `chosen` that is still safe, one at a time; the counts, and whether a stop cut it short. */
  const removeAll = (
    /** @type {any[]} */ chosen,
    /** @type {{ includeUncommitted: boolean }} */ opts,
    /** @type {AbortSignal | null} */ signal,
  ) =>
    serially(async () => {
      const tally = { removed: 0, bytes: 0, skipped: 0, failed: 0, stopped: false };
      // stopped while waiting for its turn: nothing starts
      if (signal?.aborted) return { ...tally, stopped: true };
      // read when this run's turn comes: a chat may have started in one while another run, or the card, waited
      const holders = await storage.holders(chosen);
      for (const [i, wt] of chosen.entries()) {
        if (signal?.aborted) {
          tally.stopped = true;
          break;
        }
        // one that was clean when the user saw it is not removed if it has changes now
        const includeUncommitted = opts.includeUncommitted && wt.uncommitted;
        let outcome;
        try {
          outcome = await storage.removeIfSafe(wt, { includeUncommitted, usedBy: holders[i] });
        } catch (error) {
          // one worktree failing does not hide what the others did
          noteIgnored('remove a worktree', error);
          outcome = 'failed';
        }
        if (outcome === 'removed') tally.removed++, (tally.bytes += wt.bytes);
        else if (outcome === 'failed') tally.failed++;
        else if (outcome !== 'gone') tally.skipped++;
      }
      return tally;
    });

  const disposers = [
    add(
      'get_storage_usage',
      USAGE,
      { refresh: { type: 'boolean', description: 'Measure again instead of reusing a measurement under a minute old.' } },
      [],
      async (args) => {
        const { worktrees, free } = await storage.usage(args.refresh === true);
        const idle = worktrees.filter((w) => !w.usedBy.length && !w.uncommitted);
        const total = worktrees.reduce((n, w) => n + w.bytes, 0);
        const t = now();
        const said = worktrees.length
          ? `${plural(worktrees.length, 'worktree')} the app made use ${sizeText(total)}: ${worktrees.filter((w) => w.usedBy.length).length} held by sessions, ${worktrees.filter((w) => w.uncommitted).length} with uncommitted changes and ${idle.length} idle and clean (${sizeText(idle.reduce((n, w) => n + w.bytes, 0))}, removable with clean_up_worktrees).`
          : 'The app has made no worktrees.';
        return {
          said,
          ...(free === undefined ? {} : { free_bytes: free }),
          worktrees: {
            count: worktrees.length,
            bytes: total,
            in_use_count: worktrees.filter((w) => w.usedBy.length).length,
            uncommitted_count: worktrees.filter((w) => w.uncommitted).length,
            idle_clean_count: idle.length,
            idle_clean_bytes: idle.reduce((n, w) => n + w.bytes, 0),
          },
          list: worktrees.slice(0, LIST_MAX).map((w) => ({
            path: w.path,
            branch: w.branch,
            age_days: ageDays(w.createdAt, t),
            bytes: w.bytes,
            ...(w.truncated ? { size_is_lower_bound: true } : {}),
            in_use: w.usedBy.length > 0,
            uncommitted: w.uncommitted,
          })),
          ...(worktrees.length > LIST_MAX ? { list_truncated: worktrees.length - LIST_MAX } : {}),
        };
      },
    ),
    add(
      'clean_up_worktrees',
      CLEANUP,
      {
        older_than_days: { type: 'number', description: 'Only worktrees at least this many days old (default 7).' },
        include_uncommitted: {
          type: 'boolean',
          description: 'Also remove worktrees with uncommitted changes, which are lost for good (default false).',
        },
      },
      [],
      async (args, caller, ctx) => {
        const days = args.older_than_days === undefined ? 7 : args.older_than_days;
        if (typeof days !== 'number' || !Number.isFinite(days) || days < 0)
          throw new ToolError('`older_than_days` must be a number of days, 0 or more.', 'invalid_args');
        const includeUncommitted = args.include_uncommitted === true;
        const t = now();
        const all = await storage.scan();
        const old = all.filter((w) => t - w.createdAt >= days * DAY_MS);
        const chosen = old.filter((w) => !w.usedBy.length && (includeUncommitted || !w.uncommitted));
        if (!chosen.length) {
          const held = old.filter((w) => w.usedBy.length).length;
          const dirty = old.filter((w) => !w.usedBy.length && w.uncommitted).length;
          return `Nothing to remove: ${plural(old.length, 'worktree is', 'worktrees are')} older than ${plural(days, 'day')}${held ? `, ${held} held by sessions` : ''}${dirty ? `, ${dirty} with uncommitted changes (pass include_uncommitted to remove those too, after the user agrees)` : ''}.`;
        }
        const bytes = chosen.reduce((n, w) => n + w.bytes, 0);
        const lost = chosen.filter((w) => w.uncommitted).length;
        const { allowed } = await askUser(ask, caller, ctx, {
          title: 'Remove worktrees',
          message: `Remove ${plural(chosen.length, 'worktree')} (about ${sizeText(bytes)})?`,
          details: [
            ...chosen.slice(0, 5).map((w) => `${w.path}${w.uncommitted ? ' (uncommitted changes)' : ''}`),
            ...(chosen.length > 5 ? [`and ${chosen.length - 5} more`] : []),
            ...(lost ? [`${plural(lost, 'has', 'have')} uncommitted changes that will be lost.`] : []),
          ],
          choices: [{ id: 'allow', label: 'Remove' }],
          destructive: true,
        });
        if (!allowed) throw new ToolError('The user declined, so no worktree was removed.', 'denied');
        const r = await removeAll(chosen, { includeUncommitted }, ctx.signal);
        const parts = [
          r.removed ? `Removed ${plural(r.removed, 'worktree')} (about ${sizeText(r.bytes)} freed).` : 'Removed no worktrees.',
          ...(r.skipped
            ? [`${plural(r.skipped, 'was', 'were')} skipped (a session started working in it, or it changed since the card).`]
            : []),
          ...(r.failed ? [`${plural(r.failed, 'could', 'could')} not be removed (a folder would not delete).`] : []),
          ...(r.stopped ? ['Stopped early because the call was stopped; the rest were left alone.'] : []),
          'get_storage_usage with refresh=true shows the new figures.',
        ];
        const text = parts.join(' ');
        if (!r.removed) throw new ToolError(text, 'nothing_removed');
        return text;
      },
    ),
    add(
      'discard_kept_worktree',
      DISCARD,
      { path: { type: 'string', description: 'The worktree to delete: its path as get_storage_usage lists it.' } },
      ['path'],
      async (args, caller, ctx) => {
        if (typeof args.path !== 'string' || !path.isAbsolute(args.path))
          throw new ToolError('`path` must be the absolute path of a worktree get_storage_usage lists.', 'invalid_args');
        const found = storage.find(args.path);
        if (!found)
          throw new ToolError(
            'That is not a worktree this app made, so it is not deleted here. Check the path with get_storage_usage.',
            'not_found',
          );
        const [held] = await storage.holders([found]);
        if (held.length)
          throw new ToolError(
            `Nothing was removed: ${found.path} is in use (another session works inside it). Try again once it is free.`,
            'busy',
          );
        const dirty = await storage.uncommitted(found);
        const { allowed } = await askUser(ask, caller, ctx, {
          title: 'Delete worktree',
          message: dirty ? 'Delete this worktree and its uncommitted changes?' : 'Delete this worktree?',
          details: [found.path, ...(found.branch ? [`Branch ${found.branch} is kept.`] : [])],
          choices: [{ id: 'allow', label: 'Delete' }],
          destructive: true,
        });
        if (!allowed) throw new ToolError('The user declined, so the worktree was not deleted.', 'denied');
        // read again, at this removal's turn: a session may have started in it while the card or another run waited. Only
        // the uncommitted changes the user was shown are deleted with it.
        const outcome = await serially(async () => {
          const [heldNow] = await storage.holders([found]);
          return storage.removeIfSafe(found, { includeUncommitted: dirty, usedBy: heldNow });
        });
        if (outcome === 'removed')
          return `Deleted the worktree ${found.path}${dirty ? ' and its uncommitted changes' : ''}. Its branch is kept. get_storage_usage with refresh=true shows the new figures.`;
        if (outcome === 'in_use')
          throw new ToolError(
            `Nothing was removed: ${found.path} is in use (a session started working inside it). Try again once it is free.`,
            'busy',
          );
        if (outcome === 'gone') throw new ToolError(`${found.path} is already gone.`, 'not_found');
        if (outcome === 'uncommitted')
          throw new ToolError(
            `Nothing was removed: ${found.path} has uncommitted changes that were not there when the user was asked. Call again to ask about them.`,
            'changed',
          );
        throw new ToolError(`The worktree ${found.path} could not be deleted (a file in it may be open). Try again later.`, 'failed');
      },
    ),
    add(
      'sync_with_base_branch',
      SYNC,
      {
        abort: { type: 'boolean', description: 'Abort the merge this tool left stopped on conflicts instead of starting one.' },
        folder: {
          type: 'string',
          description: "One of the session's folders, when it has several worktrees; default the working directory.",
        },
      },
      [],
      async (args, caller) => {
        const target = await sessionFolders.resolve(caller, args.folder === undefined ? '.' : args.folder);
        const info = worktreeInfo(target.path);
        if (!info)
          throw new ToolError(
            "This folder is not a worktree the app made, so the app doesn't merge for you here. Merge the base branch yourself (git fetch, then git merge).",
            'not_managed',
          );
        const run = (/** @type {string[]} */ a, timeout = 0) => git(a, info.path, timeout);
        if (args.abort === true) {
          const r = await run(['merge', '--abort']);
          if (!r.ok) throw new ToolError(`There was no merge to abort here (${r.stderr.trim() || 'git refused'}).`, 'nothing_to_abort');
          return `Aborted the merge; ${info.branch ?? 'the branch'} is as it was before.`;
        }
        const refuse = (/** @type {string} */ why) => new ToolError(`Not merging: ${why}. Deal with that, then call again.`, 'refused');
        const status = await run(['status', '--porcelain']);
        if (!status.ok) throw refuse('git could not read the worktree');
        if (status.stdout.trim()) throw refuse('the worktree has uncommitted changes');
        const head = await run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
        if (!head.ok) throw refuse('the worktree is on a detached HEAD');
        if (info.branch && head.stdout.trim() !== info.branch) throw refuse(`the worktree does not have ${info.branch} checked out`);
        for (const [what, ref] of [
          ['a merge', 'MERGE_HEAD'],
          ['a cherry-pick', 'CHERRY_PICK_HEAD'],
          ['a revert', 'REVERT_HEAD'],
        ])
          if ((await run(['rev-parse', '-q', '--verify', ref])).ok)
            throw refuse(`${what} is already in progress (finish it, or call again with abort: true)`);
        for (const dir of ['rebase-merge', 'rebase-apply']) {
          const where = await run(['rev-parse', '--git-path', dir]);
          if (where.ok && fs.existsSync(path.resolve(info.path, where.stdout.trim()))) throw refuse('a rebase is in progress');
        }
        const base =
          info.sourceBranch ||
          (await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim().replace(/^origin\//, '');
        if (!base || base.startsWith('-')) throw refuse("the app doesn't know this branch's base branch");
        const fetched = await run(['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], FETCH_TIMEOUT_MS);
        if (!fetched.ok)
          throw new ToolError(
            `Could not fetch origin/${base} (${fetched.stderr.trim() || 'git failed'}). Check the network and the remote, or merge it yourself.`,
            'fetch_failed',
          );
        const merged = await run(['merge', '--no-edit', `origin/${base}`]);
        if (merged.ok)
          return /Already up to date/i.test(merged.stdout)
            ? `${info.branch ?? 'The branch'} already has everything from origin/${base}.`
            : `Merged origin/${base} into ${info.branch ?? 'the branch'}. Push when you are ready.`;
        const conflicts = (await run(['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
        if (!conflicts.length)
          throw new ToolError(
            `The merge of origin/${base} failed: ${(merged.stderr || merged.stdout).trim().slice(0, 500)}`,
            'merge_failed',
          );
        throw new ToolError(
          `Merging origin/${base} stopped on conflicts in ${conflicts.slice(0, 20).join(', ')}${conflicts.length > 20 ? ` and ${conflicts.length - 20} more` : ''}. Resolve them, then git add, commit and push; or call sync_with_base_branch with abort: true to put the branch back.`,
          'conflicts',
        );
      },
    ),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

module.exports = { registerWorktreeTools };
