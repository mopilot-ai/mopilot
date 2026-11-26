// Read-only views of a chat's folder on the Host (#4103…): the branch and changes of its repository, for the app's panels. The folder and the repository in it are not trusted: git runs hardened (hostGit.mjs: no hooks, no fsmonitor, no ext:), diffs without external drivers or text filters, `--` before every path, each run with a timeout and a bound on what it may print, and the folder must lie inside the Host's roots by its real path.
import fs from 'node:fs';
import path from 'node:path';
import { publicRemote } from '../../shared/host/codeTransfer.mjs';
import { branchListAt } from '../../shared/gitBranchOps.mjs';
import { BRANCH_COMPARISON_GIT_ENV, branchComparisonBase } from '../../shared/gitComparisonBase.mjs';
import { HostRefusal } from './hostFs.mjs';
import { runGit } from './hostGit.mjs';
import { UNMERGED_ARGS, unmergedPaths } from '../../shared/gitUnmerged.mjs';

/** One git run; a hung disk or a huge repository answers with a coded refusal instead of holding the panel. */
const RUN_MS = 10_000;
/** The most a read prints (bytes) and the most files one answer lists. */
const MAX_BYTES = 4_000_000;
export const MAX_STATUS_FILES = 2000;
/** The most branches one answer lists (the picker shows 200 and searches the rest). */
export const MAX_BRANCHES = 5000;
/** The untracked files a patch includes as new files. */
export const MAX_UNTRACKED_PATCHES = 20;
/** The largest untracked file a patch includes (bytes). */
export const MAX_UNTRACKED_BYTES = 262_144;
/** The header-only patch of a new file left out for its size: git's header and one line with its size, which the pane reads as a row with no lines. A path with a quote, a backslash or a control character is quoted as git quotes it. */
function largeFilePatch(/** @type {string} */ name, /** @type {{ size: number, mode: number }} */ st) {
  const plain = !/[\x00-\x1f\x7f"\\]/.test(name);
  const header = (/** @type {string} */ side) =>
    plain
      ? `${side}/${name}`
      : `"${side}/${name.replace(/[\x00-\x1f\x7f"\\]/g, (c) => (c === '"' || c === '\\' ? `\\${c}` : `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`))}"`;
  const mode = st.mode & 0o111 ? '100755' : '100644';
  return `diff --git ${header('a')} ${header('b')}\nnew file mode ${mode}\nLarge file, not shown: ${st.size} bytes\n`;
}

/** The flags every diff-like command gets: no external diff driver and no text conversion filter a repository's config could name. */
const SAFE_DIFF = ['--no-ext-diff', '--no-textconv', '--no-renames'];
const SHA = /^[0-9a-f]{40,64}$/;

/**
 * The settings that stop a repository's own filters and diff programs from running: `--no-ext-diff` and `--no-textconv` do not cover `filter.<name>.clean`/`process`, which git runs when it compares the work tree with a tree or adds it to an index. Every such setting the configuration names (the repository's, an included file's, the user's) is emptied, and its filter made optional. They go in the environment (GIT_CONFIG_COUNT, which survives where `-c` would not reach a spawned helper).
 * Git's exit code 1 is "no setting matches": none to neutralize. Any other failure (a timeout, an unreadable configuration) says nothing of the filters, so it throws: no read or snapshot goes on with a filter that may run.
 * @param {(args: string[]) => Promise<{ ok: boolean, stdout: string, code?: unknown }>} git one git run in the folder @returns {Promise<Record<string, string>>} the environment of the next command
 */
export async function neutralizeFilters(git) {
  const r = await git(['config', '--null', '--get-regexp', '^(filter|diff)\\..+\\.(clean|smudge|process|textconv|command)$']);
  if (!r.ok) {
    if (r.code === 1) return {};
    // git could not read its configuration (an unreadable ~/.gitconfig answers 128): said as it is, never as a read that went on without it
    throw new HostRefusal(
      'unavailable',
      'Git on this machine could not read its configuration. Check its ~/.gitconfig and the repository’s .git/config.',
    );
  }
  /** @type {[string, string][]} */
  const settings = [];
  for (const row of r.stdout.split('\0')) {
    const key = row.split('\n')[0];
    const m = /^(filter|diff)\.(.+)\.(clean|smudge|process|textconv|command)$/i.exec(key);
    if (!m) continue;
    settings.push([key, '']);
    if (m[1].toLowerCase() === 'filter') settings.push([`filter.${m[2]}.required`, 'false']);
  }
  /** @type {Record<string, string>} */
  const env = { GIT_CONFIG_COUNT: String(settings.length) };
  settings.forEach(([k, v], n) => {
    env[`GIT_CONFIG_KEY_${n}`] = k;
    env[`GIT_CONFIG_VALUE_${n}`] = v;
  });
  return env;
}

/**
 * @param {{ hostFs: ReturnType<typeof import('./hostFs.mjs').createHostFs>, run?: typeof runGit, fsp?: typeof fs.promises }} o
 */
export function createHostRead({ hostFs, run = runGit, fsp = fs.promises }) {
  /** One bounded git run in `dir`: a coded refusal for a timeout, any other failure is the caller's to read. */
  async function git(/** @type {string} */ dir, /** @type {string[]} */ args, /** @type {Record<string, string>} */ env = {}) {
    const r = /** @type {any} */ (await run(['--no-optional-locks', ...args], { cwd: dir, timeout: RUN_MS, maxBytes: MAX_BYTES, env }));
    if (r.signal) throw new HostRefusal('read_timed_out', 'The machine took too long to read that folder.');
    return r;
  }

  /** The environment that keeps this folder's filters from running (neutralizeFilters). */
  const neutralize = (/** @type {string} */ dir) => neutralizeFilters((args) => git(dir, args));

  /** Counts the lines of the first untracked files as new files, as the patch shows them (a big or binary file stays uncounted: its row says "not counted"). */
  async function countUntracked(
    /** @type {string} */ dir,
    /** @type {{ path: string, added: number, untracked?: boolean, counted?: boolean }[]} */ files,
  ) {
    const untracked = files.filter((f) => f.untracked).slice(0, MAX_UNTRACKED_PATCHES);
    if (!untracked.length) return;
    const filters = await neutralize(dir);
    for (const file of untracked) {
      const size = await fsp.lstat(path.join(dir, file.path)).then(
        (st) => st.size,
        () => Infinity,
      );
      if (size > MAX_UNTRACKED_BYTES) continue;
      const r = await git(dir, ['diff', '--no-index', '--numstat', ...SAFE_DIFF, '--', '/dev/null', file.path], filters);
      const m = /^(\d+)\t(\d+)\t/.exec(r.stdout);
      if (m) Object.assign(file, { added: Number(m[1]), counted: true });
    }
  }

  /**
   * The branch of the repository in `path` and what changed on it inside that folder, paths relative to it: files with their added and removed lines against the base branch (committed, staged and edited), plus the untracked ones, listed; the lines of the first 20 (up to 256 KB each, text) are counted as this Mac's totals count them (`counted`), the rest are not.
   * Refuses a folder outside the roots; answers `{ isRepo: false }` for a folder that is no repository.
   * @param {{ path: string }} q
   */
  async function status({ path: p }) {
    const dir = await hostFs.requireDirectory(p);
    const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok || inside.stdout.trim() !== 'true') return { isRepo: false };
    const [branch, head, remote] = await Promise.all([
      git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']),
      git(dir, ['rev-parse', '--verify', '-q', 'HEAD']),
      git(dir, ['remote', 'get-url', 'origin']),
    ]);
    const sha = head.ok ? head.stdout.trim() : '';
    const name = branch.ok ? branch.stdout.trim() : '';
    const upstream = name ? await upstreamOf(dir, name) : null;
    /** @type {{ path: string, added: number, removed: number, binary?: boolean, untracked?: boolean, counted?: boolean }[]} */
    const files = [];
    let truncated = false;
    if (SHA.test(sha)) {
      const base = await branchComparisonBase((args) => git(dir, args, BRANCH_COMPARISON_GIT_ENV));
      // only this folder's own files: a repository that reaches above it (a dotfiles repository over the home folder) says nothing of what lies outside
      const diff =
        base &&
        (await git(dir, ['diff', '--numstat', '-z', '--relative', ...SAFE_DIFF, base, '--', '.'], {
          ...(await neutralize(dir)),
          ...BRANCH_COMPARISON_GIT_ENV,
        }));
      if (diff?.cut) truncated = true;
      // an unreadable diff lists nothing rather than guessing: the answer says so with `unreadable`
      if (!diff?.ok && !diff?.cut)
        return {
          isRepo: true,
          branch: branch.ok ? branch.stdout.trim() || null : null,
          head: sha,
          remote: remote.ok ? publicRemote(remote.stdout) : null,
          upstream,
          files,
          truncated,
          unreadable: true,
        };
      for (const row of diff.stdout.split('\0')) {
        const m = /^(\d+|-)\t(\d+|-)\t([^\0]+)$/.exec(row);
        if (!m) continue;
        if (files.length >= MAX_STATUS_FILES) {
          truncated = true;
          break;
        }
        files.push(
          m[1] === '-' ? { path: m[3], added: 0, removed: 0, binary: true } : { path: m[3], added: Number(m[1]), removed: Number(m[2]) },
        );
      }
    }
    const others = await git(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
    if (others.cut) truncated = true;
    for (const name of others.ok || others.cut ? others.stdout.split('\0') : []) {
      if (!name) continue;
      if (files.length >= MAX_STATUS_FILES) {
        truncated = true;
        break;
      }
      files.push({ path: name, added: 0, removed: 0, untracked: true });
    }
    await countUntracked(dir, files);
    return {
      isRepo: true,
      branch: branch.ok ? branch.stdout.trim() || null : null,
      head: SHA.test(sha) ? sha : null,
      remote: remote.ok ? publicRemote(remote.stdout) : null,
      upstream,
      files,
      truncated,
    };
  }

  /**
   * Where the checkout's branch `name` is pushed, as `branch.<name>.remote` and `.merge` say: that remote's address without credentials and the branch there. A PR of the branch lives in that repository, which need not be `origin`'s (a renamed or deleted `origin`, a second remote). Null for a branch that tracks nothing, a local branch, or a remote with no address git can give.
   * @param {string} dir @param {string} name
   */
  async function upstreamOf(dir, name) {
    const r = await git(dir, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${name}`]);
    const [remoteName = '', ref = ''] = r.ok ? r.stdout.trim().split('\0') : [];
    // `.` is the repository itself; a name git would read as an option is no remote it can name
    if (!remoteName || remoteName === '.' || remoteName.startsWith('-') || !ref.startsWith('refs/heads/')) return null;
    const url = await git(dir, ['remote', 'get-url', remoteName]);
    const remote = url.ok ? publicRemote(url.stdout) : null;
    return remote ? { remote, branch: ref.slice('refs/heads/'.length) } : null;
  }

  /**
   * The patch of what changed in the folder `path`, for the Changes pane: against HEAD (`uncommitted`) or against the base branch (`branch`), inside that folder with paths relative to it, plus the untracked files as new-file patches (the first 20). Read with every filter and diff program of the repository neutralized, cut at the output bound (`truncated`, the patch ends at a whole line).
   * @param {{ path: string, scope: 'uncommitted' | 'branch' }} q
   */
  async function diff({ path: p, scope }) {
    const dir = await hostFs.requireDirectory(p);
    const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok || inside.stdout.trim() !== 'true') return { isRepo: false };
    const filters = await neutralize(dir);
    let patch = '';
    let truncated = false;
    const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (head.ok && SHA.test(head.stdout.trim())) {
      const base = scope === 'branch' ? await branchComparisonBase((args) => git(dir, args, BRANCH_COMPARISON_GIT_ENV)) : 'HEAD';
      if (!base) return { isRepo: true, patch: '', truncated: false, unreadable: true };
      const r = await git(
        dir,
        ['diff', '--no-color', '--relative', ...SAFE_DIFF, base, '--', '.'],
        scope === 'branch' ? { ...filters, ...BRANCH_COMPARISON_GIT_ENV } : filters,
      );
      if (!r.ok && !r.cut) return { isRepo: true, patch: '', truncated: false, unreadable: true };
      patch = r.stdout;
      truncated = r.cut === true;
    }
    const others = await git(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
    const names = others.ok || others.cut ? others.stdout.split('\0').filter(Boolean) : [];
    for (const name of names.slice(0, MAX_UNTRACKED_PATCHES)) {
      if (patch.length >= MAX_BYTES) break;
      // git reads a whole file before it prints: a big one is never read into memory: its row says it is too large
      const st = await fsp.lstat(path.join(dir, name)).catch(() => ({ size: 0, mode: 0 }));
      if (st.size > MAX_UNTRACKED_BYTES) {
        // still a row, as this Mac lists it: a header and the size, no lines (the pane says the file is too large to show)
        patch += largeFilePatch(name, st);
        continue;
      }
      // exit status 1 is "they differ": the patch is on stdout either way
      const r = await git(dir, ['diff', '--no-index', '--no-color', ...SAFE_DIFF, '--', '/dev/null', name], filters);
      patch += r.stdout;
      if (r.cut) truncated = true;
    }
    if (names.length > MAX_UNTRACKED_PATCHES || others.cut) truncated = true;
    if (patch.length >= MAX_BYTES) {
      patch = patch.slice(0, MAX_BYTES);
      truncated = true;
    }
    // a cut ends at a whole line, so the last file is not read as one with a broken line
    if (truncated && patch && !patch.endsWith('\n')) patch = patch.slice(0, patch.lastIndexOf('\n') + 1);
    // the files a commit would refuse on, so the pane marks them (inside this folder only; the uncommitted scope is the one that commits, this Mac's pane reads them there too)
    const unmerged = scope === 'uncommitted' ? await git(dir, [...UNMERGED_ARGS, '--', '.']) : null;
    return { isRepo: true, patch, truncated, unreadable: false, conflicted: unmerged?.ok ? unmergedPaths(unmerged.stdout) : [] };
  }

  /**
   * The branches of the repository holding the folder `path`, as the new-chat branch picker lists them on this Mac (shared/gitBranchOps.mjs): origin's default first, the checked-out one, whether a worktree can start there, the repository's top folder and the folder's own place in it (`sub`, '' at the top). `{ isRepo: false }` for a folder that is none.
   * @param {{ path: string }} q
   */
  async function branches({ path: p }) {
    const dir = await hostFs.requireDirectory(p);
    const place = await git(dir, ['rev-parse', '--show-toplevel', '--show-prefix']);
    const [top = '', prefix = ''] = place.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
    if (!place.ok || !top) return { isRepo: false };
    const list = await branchListAt((args, cwd) => git(cwd, args), top);
    return { isRepo: true, ...list, branches: list.branches.slice(0, MAX_BRANCHES), top, sub: prefix.replace(/\/$/, '') };
  }

  return { status, diff, branches };
}
