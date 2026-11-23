// Restoring a Codex chat's files on rewind: each turn's start snapshot (turnChanges.cjs) kept under a ref of MoPilot's own, what restoring it would change, the restore itself (the files listed only, never a directory or a submodule, rolled back when it fails part way) and its undo.
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { git: runGit } = require('../platform/gitRun.cjs');
const { noteIgnored } = require('../ignored.cjs');
const shellEnv = require('../platform/env.cjs');

/** @typedef {(args: string[], cwd: string, timeout?: number, env?: NodeJS.ProcessEnv) => Promise<{ ok: boolean, stdout: string, stderr: string }>} Git */
/** @typedef {{ path: string, gone: boolean, here: boolean }} Change a path from the repository root: written back, or (`gone`) deleted; `here`: the current tree has it */

const ROOT = 'refs/mopilot/checkpoints';
const TREE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** How many turns of a chat keep a checkpoint: each holds its files' contents of then out of git's garbage collection. */
const KEPT = 50;
/** How many restores of a chat can still be undone. */
const UNDOS = 10;
/** A ref name component from any id: ids may hold characters a ref can't. */
const part = (/** @type {string} */ id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 24);
const stamp = (/** @type {number} */ at) => String(at).padStart(15, '0');
const chatRefs = (/** @type {string} */ threadId) => `${ROOT}/${part(threadId)}/`;
/** Ignore rules that changed between the two trees: which files are ignored differs, so neither tree says it all. */
const IGNORE_FILE = /(^|\/)\.gitignore$/;
const GITLINK = '160000';

/**
 * @param {{ git?: Git, capture: (scope: string) => Promise<string>, busy: (cwd: string) => boolean,
 *   shareWith?: (cwd: string) => void, now?: () => number }} deps
 *   capture: a tree of the folder as it is now (turnChanges.cjs snapshot); busy: a turn runs or finishes in a folder
 *   overlapping `cwd`; shareWith: mark such turns' diffs as no longer theirs alone
 */
function createTurnCheckpoints({ git = runGit, capture, busy, shareWith = () => undefined, now = Date.now }) {
  /** The refs under `prefix` (`t-` turns or `u-` undos) of the chat in `cwd`'s repository, oldest first. */
  const refsOf = async (/** @type {string} */ cwd, /** @type {string} */ threadId, /** @type {'t' | 'u'} */ kind) =>
    (await git(['for-each-ref', '--format=%(refname)', '--sort=refname', chatRefs(threadId)], cwd)).stdout
      .split('\n')
      .filter((r) => new RegExp(`/${kind}-\\d{15}-[0-9a-f]{24}$`).test(r));
  const prune = async (/** @type {string} */ cwd, /** @type {string[]} */ refs, /** @type {number} */ keep) => {
    for (const ref of refs.slice(0, Math.max(0, refs.length - keep))) await git(['update-ref', '-d', ref], cwd);
  };
  const treeOf = async (/** @type {string} */ cwd, /** @type {string | null | undefined} */ ref) => {
    if (!ref) return null;
    const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], cwd);
    return r.ok ? r.stdout.trim() : null;
  };
  const turnTree = async (/** @type {string} */ cwd, /** @type {string} */ threadId, /** @type {string} */ turnId) =>
    treeOf(
      cwd,
      (await refsOf(cwd, threadId, 't')).find((r) => r.endsWith(`-${part(turnId)}`)),
    );

  /** Restores and undos run one at a time per repository: two at once would each keep the other's half-done files. */
  const queues = new Map();
  const serial = async (/** @type {string} */ cwd, /** @type {() => Promise<any>} */ work) => {
    // one queue per repository, however its folders are named
    const top = (await git(['rev-parse', '--show-toplevel'], cwd)).stdout.replace(/\n$/, '');
    let key = top || cwd;
    try {
      key = fs.realpathSync(key);
    } catch (error) {
      noteIgnored('resolve a repository before a restore', error, ['ENOENT']);
    }
    const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
    // the next one waits for this one, whatever its outcome; the caller gets that outcome from `run`
    queues.set(
      key,
      run.then(
        () => undefined,
        (error) => noteIgnored('wait for an earlier restore before this one', error),
      ),
    );
    return run;
  };

  /**
   * What making `cwd` (inside the repository) match tree `target` would change there, with the tree `cwd` is at now:
   * submodules (their own repositories) are left out; `ignores` when a .gitignore differs.
   */
  async function changes(/** @type {string} */ cwd, /** @type {string} */ target) {
    const root = (await git(['rev-parse', '--show-toplevel'], cwd)).stdout.replace(/\n$/, '');
    if (!root) return null;
    const at = await capture(cwd);
    const diff = await git(['diff-tree', '-r', '-z', '--no-renames', '--raw', target, at, '--', '.'], cwd);
    if (!diff.ok) return null;
    // `:<old mode> <new mode> <old> <new> <status>` then the path, each NUL-ended
    const items = diff.stdout.split('\0');
    /** @type {Change[]} */
    const files = [];
    let ignores = false;
    for (let i = 0; i + 1 < items.length; i += 2) {
      const [from, to, , , status] = items[i].replace(/^:/, '').split(' ');
      const file = items[i + 1];
      if (!status || !file) continue;
      if (IGNORE_FILE.test(file)) ignores = true;
      if (from === GITLINK || to === GITLINK) continue;
      files.push({ path: file, gone: status === 'A', here: status !== 'D' });
    }
    return { root, now: at, files, ignores };
  }

  /**
   * Write `files` back from `target` in `root`'s working folder, deleting those `target` doesn't have (a file or a link,
   * never a directory); the index stays. Paths go to git in a file, so any number of them fits.
   */
  async function apply(/** @type {string} */ root, /** @type {string} */ target, /** @type {Change[]} */ files) {
    try {
      for (const f of files.filter((f) => f.gone)) {
        const at = path.join(root, f.path);
        /** @type {import('node:fs').Stats | null} */
        let st = null;
        try {
          st = await fs.promises.lstat(at);
        } catch (error) {
          // gone already: nothing to delete
          noteIgnored('read a file a rewind deletes', error, ['ENOENT', 'ENOTDIR']);
        }
        if (st && !st.isDirectory()) await fs.promises.rm(at, { force: true });
      }
      const back = files.filter((f) => !f.gone).map((f) => f.path);
      if (!back.length) return true;
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mopilot-restore-'));
      try {
        const list = path.join(dir, 'paths');
        await fs.promises.writeFile(list, `${back.join('\0')}\0`, { mode: 0o600 });
        const r = await git(['restore', `--source=${target}`, '--worktree', `--pathspec-from-file=${list}`, '--pathspec-file-nul'], root);
        return r.ok;
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    } catch {
      // a file that couldn't be deleted or written: the caller puts what it can back
      return false;
    }
  }

  /**
   * Files on disk the current tree doesn't have, among those a restore would write: ignored now (by any rule: a
   * .gitignore anywhere, info/exclude, a global one), so no undo could bring them back.
   */
  async function unsaved(/** @type {string} */ root, /** @type {Change[]} */ files) {
    const out = [];
    for (const f of files.filter((f) => !f.here)) {
      try {
        await fs.promises.lstat(path.join(root, f.path));
        out.push(f.path);
      } catch (error) {
        // not on disk either: nothing there to lose
        noteIgnored('check a file a rewind would write', error, ['ENOENT', 'ENOTDIR']);
      }
    }
    return out;
  }

  /**
   * An undo record: one tree holding `record` (the ids of the folder's tree before a restore and of what it wrote),
   * those trees under `before/` and `target/` (so git keeps them) and `paths` (the paths written, NUL-ended), built in
   * an index of its own so nothing goes through the command line.
   */
  async function record(
    /** @type {string} */ cwd,
    /** @type {string} */ before,
    /** @type {string} */ target,
    /** @type {string[]} */ paths,
  ) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mopilot-undo-'));
    const env = { ...shellEnv.gitEnv(), GIT_INDEX_FILE: path.join(dir, 'index') };
    try {
      const list = path.join(dir, 'paths');
      await fs.promises.writeFile(list, paths.map((p) => `${p}\0`).join(''), { mode: 0o600 });
      // the trees by id too: an empty one adds no entry under its prefix. Neither file is a repository file, so no
      // clean filter (an LFS or encryption one for every path) may rewrite it
      const ids = path.join(dir, 'record');
      await fs.promises.writeFile(ids, `before ${before}\ntarget ${target}\n`, { mode: 0o600 });
      const blob = await git(['hash-object', '-w', '--no-filters', '--', list], cwd);
      const meta = await git(['hash-object', '-w', '--no-filters', '--', ids], cwd);
      if (!blob.ok || !meta.ok) return null;
      for (const args of [
        ['read-tree', '--empty'],
        ['read-tree', '--prefix=before/', before],
        ['read-tree', '--prefix=target/', target],
        ['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},paths`],
        ['update-index', '--add', '--cacheinfo', `100644,${meta.stdout.trim()},record`],
      ])
        if (!(await git(args, cwd, 0, env)).ok) return null;
      const tree = await git(['write-tree'], cwd, 0, env);
      return tree.ok && TREE.test(tree.stdout.trim()) ? tree.stdout.trim() : null;
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }
  /** What an undo record holds, or null. */
  async function readRecord(/** @type {string} */ cwd, /** @type {string} */ ref) {
    const ids = await git(['cat-file', 'blob', `${ref}:record`], cwd);
    const id = (/** @type {string} */ name) => new RegExp(`^${name} ([0-9a-f]{40}(?:[0-9a-f]{24})?)$`, 'm').exec(ids.stdout)?.[1] ?? null;
    const before = ids.ok ? id('before') : null;
    const target = ids.ok ? id('target') : null;
    const list = await git(['cat-file', 'blob', `${ref}:paths`], cwd);
    if (!before || !target || !list.ok) return null;
    return { before, target, paths: list.stdout.split('\0').filter(Boolean) };
  }

  /** `changes` for the listed paths only (what the user was shown): anything else that changed since stays. */
  const only = (/** @type {Change[]} */ files, /** @type {string[] | null} */ listed) =>
    listed ? files.filter((f) => listed.includes(f.path)) : files;

  return {
    /** Keep the tree a Codex turn started from, so a rewind to before it can bring its files back; the oldest go. */
    async keep(/** @type {string} */ scope, /** @type {string} */ threadId, /** @type {string} */ turnId, /** @type {string} */ tree) {
      if (!TREE.test(tree)) return false;
      if (!(await git(['update-ref', `${chatRefs(threadId)}t-${stamp(now())}-${part(turnId)}`, tree], scope)).ok) return false;
      await prune(scope, await refsOf(scope, threadId, 't'), KEPT);
      return true;
    },
    /**
     * What rewinding thread `threadId` to before turn `turnId` would do to its files in `cwd`: `{ ok, files }` (paths
     * from the repository root), `{ ok: true, none }` when it can't (`none` says why: no checkpoint, or ignore rules
     * changed), else `{ ok: false, error }`.
     */
    async plan(/** @type {string} */ threadId, /** @type {string} */ turnId, /** @type {string} */ cwd) {
      if (busy(cwd)) return { ok: false, error: 'Stop the turn running in this folder first.' };
      const target = await turnTree(cwd, threadId, turnId);
      if (!target) return { ok: true, none: 'checkpoint' };
      const c = await changes(cwd, target);
      if (!c) return { ok: false, error: 'This folder’s files couldn’t be read.' };
      if (c.ignores || (await unsaved(c.root, c.files)).length) return { ok: true, none: 'ignores' };
      return { ok: true, files: c.files.map((f) => f.path) };
    },
    /**
     * Make the `files` listed (all that changed, when null) what they were when turn `turnId` started, keeping what
     * they are now for undo (`undo`, its id). The index, HEAD, ignored files and submodules are left as they are.
     * A restore that fails part way puts the files back.
     */
    restore(
      /** @type {string} */ threadId,
      /** @type {string} */ turnId,
      /** @type {string} */ cwd,
      /** @type {string[] | null} */ files = null,
    ) {
      return serial(cwd, async () => {
        if (busy(cwd)) return { ok: false, error: 'Stop the turn running in this folder first.' };
        const target = await turnTree(cwd, threadId, turnId);
        if (!target) return { ok: false, error: 'This message has no file checkpoint.' };
        const c = await changes(cwd, target);
        if (!c) return { ok: false, error: 'This folder’s files couldn’t be read.' };
        if (c.ignores) return { ok: false, error: 'This turn changed which files are ignored, so its files can’t be restored safely.' };
        const picked = only(c.files, files);
        if ((await unsaved(c.root, picked)).length)
          return {
            ok: false,
            error:
              'Some of these files are on disk but not kept by git now (ignored, or renamed only in case), so they couldn’t be kept for undo. Nothing was restored.',
          };
        const undo = `u-${stamp(now())}-${part(turnId)}`;
        // what the files are now comes back with undo, which touches only the paths written here, and only while they
        // are not as this restore left them nor as they were: a tree of the tree now, the tree written and their names
        const kept = await record(
          cwd,
          c.now,
          target,
          picked.map((f) => f.path),
        );
        if (!kept || !(await git(['update-ref', `${chatRefs(threadId)}${undo}`, kept], cwd)).ok)
          return { ok: false, error: 'The files couldn’t be kept for undo.' };
        await prune(cwd, await refsOf(cwd, threadId, 'u'), UNDOS);
        // a turn in another chat over this folder would count these writes as its own
        shareWith(cwd);
        if (await apply(c.root, target, picked)) return { ok: true, restored: picked.length, undo };
        const back = await changes(cwd, c.now);
        // only what this restore wrote: anything else changed meanwhile stays
        const rolled =
          back &&
          (await apply(
            back.root,
            c.now,
            only(
              back.files,
              picked.map((f) => f.path),
            ),
          ));
        return {
          ok: false,
          error: rolled ? 'Some files couldn’t be restored, so all of them were put back.' : 'Some files couldn’t be restored.',
          ...(rolled ? {} : { undo }),
        };
      });
    },
    /**
     * Put back what the files were before restore `undo` of thread `threadId`: only the paths it wrote, and only while
     * each is still as it left them (anything edited since would be lost, so it is refused and named).
     */
    undo(/** @type {string} */ threadId, /** @type {string} */ cwd, /** @type {string} */ undo) {
      return serial(cwd, async () => {
        if (busy(cwd)) return { ok: false, error: 'Stop the turn running in this folder first.' };
        const ref = /^u-\d{15}-[0-9a-f]{24}$/.test(String(undo)) ? `${chatRefs(threadId)}${undo}` : null;
        const kept = ref ? await readRecord(cwd, ref) : null;
        if (!ref || !kept) return { ok: false, error: 'There is nothing to undo.' };
        const { before, target, paths: listed } = kept;
        // edited since the restore: differs from what it wrote and from what was there before (a path still as it was
        // before, by a part-way restore or by hand, is undone already)
        const since = await changes(cwd, target);
        const c = await changes(cwd, before);
        if (!since || !c) return { ok: false, error: 'This folder’s files couldn’t be read.' };
        const stillBefore = new Set(only(c.files, listed).map((f) => f.path));
        const edited = only(since.files, listed)
          .map((f) => f.path)
          .filter((p) => stillBefore.has(p));
        if (edited.length)
          return {
            ok: false,
            error: `Changed since the restore, so not undone: ${edited.slice(0, 5).join(', ')}${edited.length > 5 ? '…' : ''}.`,
          };
        const back = only(c.files, listed);
        shareWith(cwd);
        if (!(await apply(c.root, before, back))) return { ok: false, error: 'Some files couldn’t be put back.' };
        await git(['update-ref', '-d', ref], cwd);
        return { ok: true, restored: back.length };
      });
    },
    /** Remove every checkpoint and undo of thread `threadId` in `cwd`'s repository (the chat was deleted). */
    async forget(/** @type {string} */ threadId, /** @type {string} */ cwd) {
      const refs = await git(['for-each-ref', '--format=%(refname)', chatRefs(threadId)], cwd);
      for (const ref of refs.stdout.split('\n').filter(Boolean)) await git(['update-ref', '-d', ref], cwd);
    },
  };
}

module.exports = { createTurnCheckpoints, KEPT, UNDOS };
