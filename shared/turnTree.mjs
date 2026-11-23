// A turn's file changes as Git trees: a snapshot of a working folder taken in a private index (the repository's own index, refs, stash and work tree are never touched; its objects are added, unreachable, to the object folder), where HEAD was, and the diff between two snapshots. This Mac (electron/session/turnChanges.cjs) and a machine's Host (host/src/hostTurnTree.mjs) both run it, each with its own git runner.
import path from 'node:path';
import { GIT_DIFF_FLAGS } from './gitDiffFlags.mjs';

/**
 * @typedef {(cwd: string, args: string[], env?: Record<string, string>) => Promise<string>} Git runs git and gives its stdout; throws when git fails
 * @typedef {{ git: Git, env: () => Record<string, string>, fs: typeof import('node:fs').promises, tmpdir: () => string, ignored?: (what: string, error: unknown) => void, skipUntracked?: { file: number, total: number, leave?: readonly string[], onSkipped?: (names: string[]) => void } }} TreeDeps
 *   `env`: the environment a snapshot's git runs in, to which the private index file is added; `ignored`: told of a failure that must not replace the result; `skipUntracked`: leave out of the snapshot the untracked files over `file` bytes, those past `total` bytes together (the smallest first, then by path, so the same files give the same choice), and those in `leave`, and tell `onSkipped` which (this Mac's snapshot has no such limit)
 * @typedef {{ id: string, log: number } | null} Head
 */

/**
 * Capture the folder's working contents as a tree, in a private index in a temporary folder that is removed after.
 * @param {TreeDeps} deps @param {string} cwd @returns {Promise<string>} the tree's id
 */
export async function snapshotTree({ git, env: baseEnv, fs, tmpdir, ignored, skipUntracked }, cwd) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'mopilot-turn-'));
  const env = { ...baseEnv(), GIT_INDEX_FILE: path.join(directory, 'index') };
  try {
    try {
      // A fresh index discards every stat cache entry and rehashes the entire repository each turn.
      // Copy the user's cache; one-tree merge restores HEAD's tracked paths while keeping matching stats.
      const source = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
      const index = await fs.open(source, 'r');
      try {
        const stats = await index.stat();
        await fs.writeFile(env.GIT_INDEX_FILE, await index.readFile());
        // A newer index timestamp would make racy same-size edits appear clean. Round down
        // conservatively: the timestamp belongs to these exact bytes, even if Git replaces the source.
        await fs.utimes(env.GIT_INDEX_FILE, stats.atime, (Math.floor(stats.mtimeMs) - 1) / 1000);
      } finally {
        await index.close();
      }
      const entries = await git(cwd, ['ls-files', '-v', '-z'], env);
      // User hints may deliberately hide working edits; they must never hide them from a turn snapshot.
      if (/(?:^|\0)[a-zS] /.test(entries)) await fs.rm(env.GIT_INDEX_FILE);
      await git(cwd, ['read-tree', '-m', 'HEAD'], env);
    } catch {
      // Missing/unreadable/split indexes and unborn repositories use the uncached private-index path.
      await fs.rm(env.GIT_INDEX_FILE, { force: true });
      await git(cwd, ['read-tree', 'HEAD'], env).catch(() => git(cwd, ['read-tree', '--empty'], env));
    }
    // Snapshots describe files actually present, including materialized paths outside a sparse cone.
    const left = skipUntracked ? await oversizeUntracked(git, fs, cwd, env, skipUntracked) : [];
    skipUntracked?.onSkipped?.(left);
    if (!left.length) await git(cwd, ['add', '--sparse', '-A', '--', '.'], env);
    else {
      // the folder, less the files left out, named in a file of the temporary folder (a long list never meets a command line's limit)
      const list = path.join(directory, 'pathspec');
      await fs.writeFile(list, ['.', ...left.map((name) => `:(exclude,literal)${name}`)].join('\0'));
      await git(cwd, ['add', '--sparse', '-A', `--pathspec-from-file=${list}`, '--pathspec-file-nul'], env);
    }
    return (await git(cwd, ['write-tree'], env)).trim();
  } finally {
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch (error) {
      // Temporary cleanup must not replace the snapshot result or original failure.
      ignored?.('remove a turn snapshot temporary index', error);
    }
  }
}

/**
 * The untracked files a snapshot leaves out: each over `limits.file` bytes, and any that would take the untracked bytes past `limits.total` (git writes every file it adds into the repository as an object that is never removed, so one huge file that changes every turn would fill the disk).
 * @param {Git} git @param {TreeDeps['fs']} fs @param {string} cwd @param {Record<string, string>} env @param {NonNullable<TreeDeps['skipUntracked']>} limits @returns {Promise<string[]>}
 */
async function oversizeUntracked(git, fs, cwd, env, limits) {
  const names = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], env)).split('\0').filter(Boolean);
  const leave = new Set(limits.leave ?? []);
  /** @type {string[]} */
  const left = names.filter((name) => leave.has(name));
  const sized = await Promise.all(
    names
      .filter((name) => !leave.has(name))
      .map(async (name) => ({
        name,
        size: await fs.lstat(path.join(cwd, name)).then(
          (st) => st.size,
          () => 0,
        ),
      })),
  );
  // the smallest first, then by path: the same files make the same choice whatever order git lists them in
  sized.sort((a, b) => a.size - b.size || Number(a.name > b.name) - Number(a.name < b.name));
  let total = 0;
  for (const { name, size } of sized) {
    if (size > limits.file || total + size > limits.total) left.push(name);
    else total += size;
  }
  const listed = new Set(names);
  return [...left, ...[...leave].filter((name) => !listed.has(name))];
}

/**
 * Where the folder's HEAD is: its commit and how many entries its reflog holds, or null (an unborn branch, not a
 * repository). The entry count marks where a turn began, so the moves made since are the entries after it.
 * @param {Git} git @param {string} cwd @returns {Promise<Head>}
 */
export async function headOf(git, cwd) {
  try {
    const id = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).trim();
    const log = (await git(cwd, ['reflog', 'show', '--format=%H', 'HEAD'])).split('\n').filter(Boolean).length;
    return { id, log };
  } catch {
    return null;
  }
}

/** Paths per git command: a checkout can leave more changed files than one command line holds. */
const PATHS_PER_DIFF = 200;

/** A reflog subject of work the folder's user made: a commit, or a cherry-pick or revert they ran. */
const OWN_COMMIT = /^(?:commit(?: \((?:amend|initial|merge)\))?|cherry-pick|revert):/;

/**
 * How HEAD got to its present commit, oldest move first: the reflog entries made since the turn began (`before.log`
 * entries then). Null when it cannot be told (the reflog shrank, or its entry there is not the commit HEAD was at).
 * @param {Git} git @param {string} cwd @param {{ id: string, log: number }} before
 * @returns {Promise<{ from: string, to: string, own: boolean }[] | null>}
 */
async function headMoves(git, cwd, before) {
  let log;
  try {
    log = await git(cwd, ['reflog', 'show', '--format=%H%x00%gs', 'HEAD']);
  } catch {
    return null;
  }
  const entries = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, subject = ''] = line.split('\0');
      return { hash, own: OWN_COMMIT.test(subject) };
    });
  const made = entries.length - before.log;
  if (made <= 0 || entries[made]?.hash !== before.id) return null;
  const moves = entries.slice(0, made).reverse();
  return moves.map((move, i) => ({ from: i ? moves[i - 1].hash : before.id, to: move.hash, own: move.own }));
}

/**
 * The diff between two snapshots. When HEAD moved between them by anything but the folder's own commits (a checkout,
 * switch, pull, merge or reset), the files that move brought in are not the turn's edit: one it changed, that was clean
 * against HEAD in both snapshots and that no commit of the turn's own touched, is left out. A file edited on either side,
 * or written by the turn, stays; so does one the turn wrote to exactly what the move brought (#2482).
 * @param {Git} git @param {string} cwd @param {string} before @param {string} after
 * @param {{ before: Head, after: { id: string } | null } | undefined} heads
 * @param {number} [maxBytes] stop reading further batches of files once the diff is past this many characters (the Host's bound; none for this Mac)
 * @param {readonly string[]} [leave] files left out of the diff whatever they say (the Host's: files a snapshot left out on either side)
 */
export async function compareTrees(git, cwd, before, after, heads, maxBytes, leave = []) {
  // relative to the folder, and only inside it, as the diff itself is (`-- .`)
  const names = async (/** @type {string[]} */ args) =>
    (await git(cwd, ['diff', '--name-only', '--relative', '--no-renames', '-z', ...args])).split('\0').filter(Boolean);
  const skip = new Set(leave);
  const apart = leave.map((file) => `:(exclude,literal)${file}`);
  const diff = (/** @type {string[]} */ ...paths) => git(cwd, ['diff', ...GIT_DIFF_FLAGS, '--binary', before, after, '--', ...paths]);
  const whole = () => diff('.', ...apart);
  if (!heads?.before || !heads.after || heads.before.id === heads.after.id) return whole();
  const moves = await headMoves(git, cwd, heads.before);
  if (!moves?.some((move) => !move.own)) return whole();
  const changedBy = async (/** @type {typeof moves} */ list) =>
    new Set((await Promise.all(list.map((move) => names([move.from, move.to])))).flat());
  const [foreign, own, editedBefore, editedAfter] = await Promise.all([
    changedBy(moves.filter((move) => !move.own)),
    changedBy(moves.filter((move) => move.own)),
    names([heads.before.id, before]),
    names([heads.after.id, after]),
  ]);
  const edited = new Set([...editedBefore, ...editedAfter, ...own]);
  const brought = new Set([...foreign].filter((file) => !edited.has(file)));
  if (!brought.size) return whole();
  const kept = (await names([before, after])).filter((file) => !brought.has(file) && !skip.has(file));
  let text = '';
  // the changed files are listed in git's order, so the batches read as one diff in that order
  for (let i = 0; i < kept.length; i += PATHS_PER_DIFF) {
    text += await diff(...kept.slice(i, i + PATHS_PER_DIFF).map((file) => `:(literal)${file}`));
    if (maxBytes !== undefined && text.length > maxBytes) break;
  }
  return text;
}
