// The app's side of getting the code to the target Host of a continue (docs: design/host/index.html, package 3.5): read the source folder's repository, check the folder picked on the target against it, and clone the same branch there when asked. Nothing leaves the source but its public repository address; no credential is read, sent or stored.
const { ContinueRefusal } = require('../../shared/host/continue.mjs');
const { CARRY_CODES } = require('../../shared/host/codeCarry.mjs');
const { CODE_CODES, classifyTarget, inspectRepo, repoFacts } = require('../../shared/host/codeTransfer.mjs');

/** A source folder read the way the Host's `git.inspect` reads one, for a chat that runs on this Mac. @param {(args: string[], cwd: string, timeout?: number) => Promise<{ ok: boolean, stdout: string, stderr: string }>} git the app's git runner */
const localInspect = (git) => (/** @type {string} */ cwd) => inspectRepo((args) => git(args, cwd, 10_000));

/**
 * @param {object} o
 * @param {(hostId: string, path: string) => Promise<unknown>} o.inspect `git.inspect` on a Host (the local one included); a failure carries the Host's `code`
 * @param {(hostId: string, req: { key: string, url: string, dest: string, branch?: string }) => Promise<{ path: string, existed: boolean }>} o.clone `git.clone` on a Host
 * @param {{ plan: (hostId: string, req: { path: string }) => Promise<{ untracked: string[], skipped: string[], files: number, unpushed: number, remote: string }>, push: (hostId: string, req: { key: string, path: string, untracked: string[], unpushed: number }) => Promise<{ branch: string, commit: string, parent: string, sourceBranch: string | null, files: number, skipped: string[] }>, apply: (hostId: string, req: { key: string, path: string, branch: string, commit: string, parent: string, sourceBranch: string | null }) => Promise<{ files: number }>, drop: (hostId: string, req: { path: string, branch: string }) => Promise<unknown> }} o.carry `git.carryPlan`, `git.carryPush`, `git.carryApply` and `git.carryDrop` on a Host; a refusal carries its `code` (shared/host/codeCarry.mjs)
 * @param {() => string} o.newKey mints an idempotency key
 * @param {(problem: string) => void} o.report where a problem that did not stop the continue is reported
 */
function createCodeTransfer({ inspect, clone, carry, newKey, report }) {
  /** The facts of `path` on `hostId`; a refusal or a failure is the caller's to show. */
  const read = async (/** @type {string} */ hostId, /** @type {string} */ path) => repoFacts(await inspect(hostId, path));

  /**
   * How the folder picked on the target compares with the source's repository. A folder that cannot be read is refused with the Host's own reason (`outside_roots`, `directory_missing`), never classified as empty.
   * @param {{ source: import('../../shared/host/codeTransfer.mjs').RepoFacts | null, targetHostId: string, targetPath: string }} req
   */
  async function check({ source, targetHostId, targetPath }) {
    const target = await read(targetHostId, targetPath);
    return { state: classifyTarget(source, target), target };
  }

  /**
   * What a carry of the source folder would send, for the dialog to show before the user confirms: `untracked` are new files (not ignored) that would be sent, `skipped` are files never sent because their names say they hold secrets. Null when there is nothing to carry.
   * @param {{ source: import('../../shared/host/codeTransfer.mjs').RepoFacts | null, sourceHostId: string, cwd: string }} req
   */
  async function carryPlan({ source, sourceHostId, cwd }) {
    if (!source?.isRepo || !source.dirty) return null;
    return carry.plan(sourceHostId, { path: cwd });
  }

  /**
   * Carries the source folder's uncommitted changes to the target folder as uncommitted changes (a temporary branch on the remote), then removes that branch. The source is not touched; a target that is not a clean checkout of the same branch, or where the changes do not apply, is refused with the carry's code and left as it was. Files that look like secrets are never sent. New files are sent only when the user confirmed the list the plan showed: `untracked` is that list and `confirmed` says the user agreed; the Host checks the list again, so a file that appeared since stops the carry. Answers how many files arrived and which were skipped.
   * @param {{ source: import('../../shared/host/codeTransfer.mjs').RepoFacts | null, sourceHostId: string, cwd: string, targetHostId: string, targetPath: string, untracked?: string[], unpushed?: number, confirmed?: boolean, key?: string }} req `unpushed` is how many unpushed commits the user agreed to publish with the changes (the plan said how many)
   */
  async function carryChanges({
    source,
    sourceHostId,
    cwd,
    targetHostId,
    targetPath,
    untracked = [],
    unpushed = 0,
    confirmed = false,
    key = newKey(),
  }) {
    if (!source?.isRepo || !source.dirty) return { carried: 0, skipped: [] };
    if (untracked.length > 0 && !confirmed)
      throw new ContinueRefusal(CARRY_CODES.unconfirmed, 'Confirm the new files to carry first, or continue without the changes.');
    let pushed;
    try {
      pushed = await carry.push(sourceHostId, { key, path: cwd, untracked, unpushed });
    } catch (e) {
      // changes that are gone by now are nothing to carry; any other refusal is the user's to see
      if (/** @type {any} */ (e)?.code === CARRY_CODES.noChanges) return { carried: 0, skipped: [] };
      throw e;
    }
    try {
      const { branch, commit, parent, sourceBranch, skipped } = pushed;
      const { files } = await carry.apply(targetHostId, { key, path: targetPath, branch, commit, parent, sourceBranch });
      return { carried: files, skipped };
    } finally {
      // the branch is temporary: remove it whether or not the target took the changes
      try {
        await carry.drop(sourceHostId, { path: cwd, branch: pushed.branch });
      } catch (e) {
        report(`The temporary branch ${pushed.branch} was not removed: ${/** @type {Error} */ (e).message}`);
      }
    }
  }

  return {
    check,
    carryPlan,
    carryChanges,
    /**
     * The source folder's repository, or null when it cannot be read (its Host is away, or the folder is outside what it shares): the continue goes on without repository lines, and the handoff says nothing it does not know.
     * @param {{ sourceHostId: string, cwd: string }} req
     */
    async readSource({ sourceHostId, cwd }) {
      try {
        return await read(sourceHostId, cwd);
      } catch (e) {
        report(`The source folder's repository could not be read: ${/** @type {Error} */ (e).message}`);
        return null;
      }
    },

    /**
     * Clones the source's repository on the target, on the source's branch, and answers how the folder compares afterwards. The Host clones beside the folder and moves it into place whole, so a failure leaves nothing to pick; repeating a call with the same key shares the first outcome.
     * @param {{ source: import('../../shared/host/codeTransfer.mjs').RepoFacts | null, targetHostId: string, dest: string, key?: string }} req
     */
    async cloneSource({ source, targetHostId, dest, key = newKey() }) {
      if (!source?.isRepo)
        throw new ContinueRefusal(
          CODE_CODES.unknownSource,
          'This chat’s folder could not be read as a repository, so there is nothing to clone.',
        );
      if (!source.remote)
        throw new ContinueRefusal(
          CODE_CODES.noRemote,
          'This chat’s folder has no remote the other host could clone from. Pick a folder there instead.',
        );
      const done = await clone(targetHostId, { key, url: source.remote, dest, ...(source.branch ? { branch: source.branch } : {}) });
      const { state, target } = await check({ source, targetHostId, targetPath: done.path });
      return { ...done, state, target };
    },
  };
}

module.exports = { createCodeTransfer, localInspect };
