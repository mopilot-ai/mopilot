// The app's folder service for remote Hosts (design/host/index.html, package 2.7): browse a Host's roots, clone or make a worktree there with progress, and record a chat's folder with its hostId in the side map (ownership.cjs).
const { HostError } = require('./interface.cjs');
const { LOCAL_HOST_ID } = require('./ownership.cjs');
const { parseParams } = require('../../shared/host/schema.mjs');
const { readCommands } = require('../../shared/host/hostCommandsWire.mjs');
const { GIT_BRANCH_FEATURE } = require('../../shared/host/gitBranch.mjs');
const { isWinPath } = require('../../shared/paths.mjs');
const { macSignIn: readMacSignIn } = require('./macSignIn.cjs');
const { createFolderSearch } = require('./folderSearch.cjs');
const { legacyCheckout } = require('./legacyCheckout.cjs');
const { sayHello } = require('./helloFirst.cjs');

/** A clone may take as long as the repository needs; a listing or a worktree must answer. */
const LIST_MS = 15_000;
const WORKTREE_MS = 120_000;
/** A repository read: the Host gives up on its own git runs after 10 seconds each, and a few make one status. */
const STATUS_MS = 45_000;
/** A commit or discard: the Host stops each git run of it after two minutes, and a few make one write. */
const WRITE_MS = 6 * 60_000;

const text = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0;
const unreadable = (/** @type {string} */ what) => new HostError('invalid', `The Host sent ${what} this app cannot read.`);
const checkoutPath = (/** @type {unknown} */ p) =>
  typeof p === 'string' && p.length <= 4096 && !p.includes('\0') && (p.startsWith('/') || isWinPath(p));

/** The listing the picker draws, or null when the Host sent something else. @param {any} v */
function readListing(v) {
  if (!text(v?.path) || !Array.isArray(v.roots) || !v.roots.every(text) || !Array.isArray(v.entries)) return null;
  const entries = [];
  for (const e of v.entries) {
    if (!text(e?.name) || !text(e?.path) || typeof e.git !== 'boolean') return null;
    entries.push({ name: e.name, path: e.path, git: e.git });
  }
  return { path: v.path, roots: [...v.roots], entries };
}

/** What the Host said a repository holds, or null when it sent something else: strings and counts only, bounded, so a Host cannot make the window draw more than it asked for. @param {any} v */
function readStatus(v) {
  if (v?.isRepo === false) return { isRepo: false };
  if (v?.isRepo !== true || !Array.isArray(v.files) || v.files.length > 5000) return null;
  const files = [];
  for (const f of v.files) {
    if (
      !text(f?.path) ||
      f.path.length > 1000 ||
      !Number.isSafeInteger(f.added) ||
      !Number.isSafeInteger(f.removed) ||
      f.added < 0 ||
      f.removed < 0
    )
      return null;
    files.push({
      path: f.path,
      added: f.added,
      removed: f.removed,
      ...(f.binary === true ? { binary: true } : {}),
      ...(f.untracked === true ? { untracked: true } : {}),
      ...(f.counted === true ? { counted: true } : {}),
    });
  }
  const str = (/** @type {unknown} */ s) => (typeof s === 'string' && s && s.length <= 1000 ? s : null);
  return {
    isRepo: true,
    branch: str(v.branch),
    head: str(v.head),
    remote: str(v.remote),
    // where the branch is pushed: the PR reader looks there when origin's repository has no PR (an older Host sends none)
    upstream: str(v.upstream?.remote) && str(v.upstream?.branch) ? { remote: v.upstream.remote, branch: v.upstream.branch } : null,
    files,
    truncated: v.truncated === true,
    unreadable: v.unreadable === true,
  };
}

/** The branches the new-chat picker draws, or null when the Host sent something else: names and flags only, bounded, so a Host cannot make the window draw more than it asked for. @param {any} v */
function readBranches(v) {
  if (v?.isRepo === false) return { isRepo: false };
  const name = (/** @type {unknown} */ n) => typeof n === 'string' && n.length > 0 && n.length <= 255;
  const place = (/** @type {unknown} */ n) => typeof n === 'string' && n.length <= 4096;
  if (
    v?.isRepo !== true ||
    !Array.isArray(v.branches) ||
    v.branches.length > 5000 ||
    !v.branches.every(name) ||
    !text(v.top) ||
    !place(v.sub) ||
    typeof v.commits !== 'boolean' ||
    (v.current !== null && !name(v.current)) ||
    (v.default !== null && !name(v.default))
  )
    return null;
  return { isRepo: true, current: v.current, default: v.default, branches: [...v.branches], commits: v.commits, top: v.top, sub: v.sub };
}

/** A repository's patch as the Changes pane draws it, or null when the Host sent something else: text within the bound the Host keeps to, and the files in conflict (paths relative to the folder; absent from an older Host, which marks none). @param {any} v */
function readDiff(v) {
  if (v?.isRepo === false) return { isRepo: false };
  if (v?.isRepo !== true || typeof v.patch !== 'string' || v.patch.length > 4_100_000) return null;
  const conflicted = Array.isArray(v.conflicted)
    ? v.conflicted.filter((/** @type {unknown} */ p) => text(p) && /** @type {string} */ (p).length <= 4096).slice(0, 5000)
    : undefined;
  return {
    isRepo: true,
    patch: v.patch,
    truncated: v.truncated === true,
    unreadable: v.unreadable === true,
    ...(conflicted ? { conflicted } : {}),
  };
}

/** What one turn changed, as the Changes pane's Last Turn draws it, or null when the Host sent something else: no repository, no usable start of that turn, or its patch within the bound. @param {any} v */
function readTurnDiff(v) {
  if (v?.isRepo === false) return { isRepo: false };
  if (v?.isRepo !== true) return null;
  if (v.baseline === false) return { isRepo: true, baseline: false };
  if (v.baseline !== true || typeof v.patch !== 'string' || v.patch.length > 4_100_000) return null;
  // the untracked files the Host left out of its snapshots (too big): how many, and the first few
  const s = v.skipped;
  const skipped =
    Number.isInteger(s?.count) &&
    s.count > 0 &&
    s.count <= 1_000_000 &&
    Array.isArray(s.paths) &&
    s.paths.length <= 10 &&
    s.paths.every((p) => text(p))
      ? { count: s.count, paths: [...s.paths] }
      : undefined;
  return { isRepo: true, baseline: true, patch: v.patch, truncated: v.truncated === true, ...(skipped && { skipped }) };
}

/** How a commit or discard on a machine ended, or null when the Host sent something else: the words are bounded. @param {any} v */
function readWrite(v) {
  if (typeof v?.ok !== 'boolean' || typeof v.stderr !== 'string' || v.stderr.length > 4000) return null;
  return {
    ok: v.ok,
    stderr: v.stderr,
    ...(v.refused === true ? { refused: true } : {}),
    ...(typeof v.warning === 'string' && v.warning.length <= 1000 ? { warning: v.warning } : {}),
  };
}

/** A folder's entries as the Files tree draws them, or null when the Host sent something else. @param {any} v */
function readTree(v) {
  if (!text(v?.path) || !Array.isArray(v.entries) || v.entries.length > 2500) return null;
  const entries = [];
  for (const e of v.entries) {
    if (!text(e?.name) || e.name.length > 1000 || e.name.includes('/') || e.name.includes('\0') || typeof e.isDirectory !== 'boolean')
      return null;
    entries.push({ name: e.name, isDirectory: e.isDirectory });
  }
  return { path: v.path, entries, truncated: v.truncated === true };
}

/** A file's start as the preview draws it, or null when the Host sent something else: text within the largest bound, or a binary file's size. @param {any} v */
function readFileView(v) {
  if (!Number.isSafeInteger(v?.size) || v.size < 0) return null;
  if (v.kind === 'binary') return { kind: 'binary', size: v.size };
  if (v.kind !== 'text' || typeof v.text !== 'string' || v.text.length > 4_000_000) return null;
  return { kind: 'text', text: v.text, size: v.size, truncated: v.truncated === true };
}

/** The folder a clone or worktree made, or null when the Host sent something else. @param {any} v */
const readPlace = (v) => (text(v?.path) && typeof v.existed === 'boolean' ? { path: v.path, existed: v.existed } : null);

/**
 * @param {object} o
 * @param {(hostId: string, onEvent?: (event: Record<string, any>) => void) => Promise<{ call: (method: string, params?: object, opts?: { timeoutMs?: number }) => Promise<any>, close: () => void }>} o.open an authenticated connection to the machine (electron/host/machines.cjs)
 * @param {InstanceType<typeof import('./ownership.cjs').OwnershipStore>} o.store the side map
 * @param {(progress: { hostId: string, key: string, phase: string, percent: number }) => void} [o.onProgress]
 * @param {() => boolean} [o.allowed] Host's closed-alpha gate
 * @param {(cb: (ok: boolean) => void) => unknown} [o.watch] follows the gate
 * @param {typeof readMacSignIn} [o.macSignIn] this Mac's sign-in for an address's host
 */
function createHostFolders({
  open,
  store,
  onProgress = () => undefined,
  allowed = () => true,
  watch = () => undefined,
  macSignIn = readMacSignIn,
}) {
  /** @type {Set<{ close: () => void }>} */
  const sessions = new Set();
  let disposed = false;
  /** Every connection ends when Host access is lost: a clone keeps running on the Host, but nothing more reaches this app. */
  const closeAll = () => {
    for (const s of [...sessions]) s.close();
    sessions.clear();
  };
  watch((/** @type {boolean} */ ok) => ok || closeAll());
  const search = createFolderSearch({ withSession }); // withSession is hoisted below

  /** Runs `work` on one connection to a remote machine, closed afterwards however it ends. @template T @param {string} hostId @param {(s: Awaited<ReturnType<typeof open>>) => Promise<T>} work @param {(e: Record<string, any>) => void} [onEvent] */
  async function withSession(hostId, work, onEvent) {
    if (disposed) throw new HostError('disposed', 'The folder service was disposed.');
    if (!text(hostId) || hostId === LOCAL_HOST_ID) throw new HostError('invalid', 'Pick a remote machine.');
    const s = await open(hostId, onEvent);
    // access was lost while the connection was being made: nothing runs on it
    if (disposed || !allowed()) {
      s.close();
      throw new HostError('disposed', 'Host is not available.');
    }
    sessions.add(s);
    try {
      return await work(s);
    } finally {
      sessions.delete(s);
      s.close();
    }
  }

  /** A Host without the method (or without the feature the app checks before it sends) is told to update, in words of what the person was doing: `Unknown method`, `Unknown request` or `feature_missing` become `host_outdated`. @param {unknown} e @param {string} what @returns {never} */
  function outdated(e, what) {
    const err = /** @type {any} */ (e);
    if (/^Unknown (method|request)/.test(String(err?.message)) || err?.code === 'feature_missing')
      throw new HostError('host_outdated', `Update the Host on that machine to ${what}.`);
    throw e;
  }

  /** One request on an open connection, a `host.` method after the hello. @param {{ call: (m: string, p?: object, o?: { timeoutMs?: number }) => Promise<any> }} s @param {string} method @param {object} params @param {number} timeoutMs @param {string} what */
  async function ask(s, method, params, timeoutMs, what) {
    try {
      if (method.startsWith('host.')) await sayHello(s, method);
      return await s.call(method, params, { timeoutMs });
    } catch (e) {
      return outdated(e, what);
    }
  }

  /** One read request on an open connection: an older Host has no such method, and the app says to update it instead of a bare refusal. @param {{ call: (m: string, p?: object, o?: { timeoutMs?: number }) => Promise<any> }} s @param {string} method @param {object} params @param {string} [what] what the person could not do, for the update notice */
  const callRead = (s, method, params, what = 'see its files and changes') => ask(s, method, params, STATUS_MS, what);

  /** One write request on an open connection: a Host from before the git writes is told to update. @param {{ call: (m: string, p?: object, o?: { timeoutMs?: number }) => Promise<any> }} s @param {string} method @param {object} params @param {string} [what] what the person could not do, for the update notice */
  const callWrite = (s, method, params, what = 'commit or discard its changes') => ask(s, method, params, WRITE_MS, what);

  return {
    /** The folders in `path` on the machine, inside what it shares (no path: its first root). @param {string} hostId @param {{ path?: string, hidden?: boolean }} q */
    async list(hostId, q) {
      const params = parseParams('fs.list', q);
      return withSession(hostId, async (s) => {
        const listing = readListing(await s.call('fs.list', params, { timeoutMs: LIST_MS }));
        if (!listing) throw unreadable('a folder list');
        return listing;
      });
    },

    /** @param {string} hostId @param {{path: string}} q */
    async repository(hostId, q) {
      const params = parseParams('git.inspect', { ...q, sidebar: true });
      return withSession(hostId, async (s) => {
        const out = await callRead(s, 'git.inspect', params, 'identify its repository');
        // An older Host can attest to an origin, but its negative answers also represent failed Git commands.
        if (out?.sidebar === true) {
          if (out.origin === null || out.origin === undefined || typeof out.origin === 'string') return out.origin;
        } else {
          if (out?.isRepo === false || (out?.isRepo === true && out.remote === null)) return undefined;
          if (out?.isRepo === true && typeof out.remote === 'string') return out.remote;
        }
        throw unreadable('a repository identity');
      });
    },

    /** @param {string} hostId @param {{path: string}} q */
    async checkout(hostId, q) {
      const params = parseParams('git.inspect', { ...q, sidebar: true, checkout: true });
      return withSession(hostId, async (s) => {
        const out = await callRead(s, 'git.inspect', params, 'identify its checkout');
        if (out?.sidebarCheckout === true) {
          if (out.path === null || out.path === undefined || checkoutPath(out.path)) return out.path;
          throw unreadable('a checkout path');
        }
        // Older Hosts know this checkout's root through the branch picker.
        if (out?.sidebar === true || out?.isRepo === true) {
          const branches = readBranches(await callRead(s, 'host.gitBranches', { path: params.path }, 'identify its checkout'));
          if (branches?.isRepo && checkoutPath(branches.top)) {
            return legacyCheckout(
              params.path,
              branches.top,
              async (path) => {
                const file = readFileView(await callRead(s, 'fs.read', { path, limit: 8192 }));
                return file?.kind === 'text' && !file.truncated ? file.text : undefined;
              },
              async (path) => {
                const root = readListing(await s.call('fs.list', { path }, { timeoutMs: LIST_MS }))?.path;
                return checkoutPath(root) ? root : undefined;
              },
            );
          }
          if (branches?.isRepo === false) return undefined; // Older Hosts also report this when Git fails.
        }
        if (out?.isRepo === false) return undefined;
        throw unreadable('a checkout path');
      });
    },

    /**
     * The branch and changes of the repository in `path` on the machine, read-only (the Host's `git.status`). A Host from before this method answers `host_outdated`; refusals carry the Host's `code` (`outside_roots`, `directory_missing`, `read_timed_out`, …).
     * @param {string} hostId @param {{ path: string }} q
     */
    async status(hostId, q) {
      const params = parseParams('git.status', q);
      return withSession(hostId, async (s) => {
        const out = readStatus(await callRead(s, 'git.status', params));
        if (!out) throw unreadable('a repository status');
        return out;
      });
    },

    /**
     * Commit the changes in a folder on the machine (`files` null: every change in it; else those files, paths relative to the folder), as this Mac's Changes pane does (the Host's `host.gitCommit`). Git's refusal is an answer (`ok: false`); a Host that cannot answers `host_outdated`.
     * @param {string} hostId @param {{ path: string, message: string, files: { path: string, oldPath?: string, isCopy?: boolean, isDeleted?: boolean }[] | null }} q
     */
    async commit(hostId, q) {
      const params = parseParams('host.gitCommit', q);
      return withSession(hostId, async (s) => {
        const out = readWrite(await callWrite(s, 'host.gitCommit', params));
        if (!out) throw unreadable('a commit result');
        return out;
      });
    },

    /**
     * Discard the changes of one file in a folder on the machine, or of everything in it (`file` null), as this Mac's Changes pane does (the Host's `host.gitDiscard`).
     * @param {string} hostId @param {{ path: string, file: string | null }} q
     */
    async discard(hostId, q) {
      const params = parseParams('host.gitDiscard', q);
      return withSession(hostId, async (s) => {
        const out = readWrite(await callWrite(s, 'host.gitDiscard', params));
        if (!out) throw unreadable('a discard result');
        return out;
      });
    },

    /**
     * What one turn of a chat changed in its folder on the machine, for Last Turn (the Host's `host.gitTurnDiff`, which takes its snapshots around each turn). A Host from before it answers `host_outdated`.
     * @param {string} hostId @param {{ path: string, turnId: string }} q
     */
    async turnDiff(hostId, q) {
      const params = parseParams('host.gitTurnDiff', q);
      return withSession(hostId, async (s) => {
        const out = readTurnDiff(await callRead(s, 'host.gitTurnDiff', params, "see a turn's changes"));
        if (!out) throw unreadable("a turn's changes");
        return out;
      });
    },

    /**
     * The branches of the repository holding a folder on the machine, for the new-chat branch picker (the Host's `host.gitBranches`), read-only; an older Host answers `host_outdated`.
     * @param {string} hostId @param {{ path: string }} q
     */
    async branches(hostId, q) {
      const params = parseParams('host.gitBranches', q);
      return withSession(hostId, async (s) => {
        const out = readBranches(await callRead(s, 'host.gitBranches', params, 'choose a branch or start in a worktree'));
        if (!out) throw unreadable('a branch list');
        return out;
      });
    },

    /**
     * Check out `branch` in a folder on the machine where a new chat runs without a worktree, as this Mac does (the Host's `host.gitSwitch`). Git's refusal is an answer (`ok: false`, `refused`); a Host that cannot answers `host_outdated`.
     * @param {string} hostId @param {{ path: string, branch: string }} q
     */
    async switchBranch(hostId, q) {
      const params = parseParams('host.gitSwitch', q);
      return withSession(hostId, async (s) => {
        const out = readWrite(await callWrite(s, 'host.gitSwitch', params, 'start a chat on a branch'));
        if (!out) throw unreadable('a branch switch result');
        return out;
      });
    },

    /** The files in a folder on the machine whose names match a query, for the @ popup (folderSearch.cjs). */
    search,

    /**
     * The patch of what changed in a folder on the machine (`uncommitted`: against HEAD; `branch`: against the base branch), read-only (the Host's `git.diff`).
     * @param {string} hostId @param {{ path: string, scope: 'uncommitted' | 'branch' }} q
     */
    async diff(hostId, q) {
      const params = parseParams('git.diff', q);
      return withSession(hostId, async (s) => {
        const out = readDiff(await callRead(s, 'git.diff', params));
        if (!out) throw unreadable('a patch');
        return out;
      });
    },

    /**
     * The entries of a folder on the machine, read-only (the Host's `fs.tree`); refusals carry the Host's `code`, an older Host answers `host_outdated`.
     * @param {string} hostId @param {{ path: string }} q
     */
    async tree(hostId, q) {
      const params = parseParams('fs.tree', q);
      return withSession(hostId, async (s) => {
        const out = readTree(await callRead(s, 'fs.tree', params));
        if (!out) throw unreadable('a folder list');
        return out;
      });
    },

    /**
     * The slash commands and skills an agent on the machine offers for a folder (the Host's `host.commands`), shaped and bounded; `listed: false` when the agent has none to give yet. A Host from before this method, or one with no source for it, answers `outdated`, so the menu says to update it instead of a bare error.
     * @param {string} hostId @param {{ harness: string, cwd?: string }} q
     */
    async commands(hostId, q) {
      const params = parseParams('host.commands', q);
      return withSession(hostId, async (s) => {
        try {
          const out = readCommands(await callRead(s, 'host.commands', params));
          if (!out) throw unreadable('a command list');
          return out;
        } catch (e) {
          if (['host_outdated', 'feature_missing'].includes(/** @type {any} */ (e)?.code))
            return { listed: false, commands: [], outdated: true };
          throw e;
        }
      });
    },

    /**
     * The start of a file on the machine, read-only (the Host's `fs.read`); `limit` bounds the bytes.
     * @param {string} hostId @param {{ path: string, limit?: number }} q
     */
    async read(hostId, q) {
      const params = parseParams('fs.read', q);
      return withSession(hostId, async (s) => {
        const out = readFileView(await callRead(s, 'fs.read', params));
        if (!out) throw unreadable('a file');
        return out;
      });
    },

    /**
     * Clone `url` into `dest` on the machine, telling `onProgress` as git reports. `key` names this attempt: the Host runs it once, so the same key again returns its outcome; a new attempt needs a new key.
     * `useMacSignIn` lends this Mac's sign-in for the address's host to this one clone: it is read here, goes to the Host in the request and is never returned to the window; none on this Mac refuses with `no_mac_signin` before anything is sent.
     * @param {string} hostId @param {{ key: string, url: string, dest: string, useMacSignIn?: boolean }} q
     */
    async clone(hostId, { useMacSignIn, ...q }) {
      // the address is validated first, so this Mac is asked about an address the Host would accept
      const checked = parseParams('git.clone', q);
      let credential;
      if (useMacSignIn === true) {
        credential = await macSignIn(checked.url);
        if (!credential) throw new HostError('no_mac_signin', 'This Mac has no sign-in for that address.');
      }
      const params = parseParams('git.clone', { ...q, ...(credential ? { credential } : {}) });
      return withSession(
        hostId,
        async (s) => {
          const place = readPlace(await s.call('git.clone', params, { timeoutMs: 0 }));
          if (!place) throw unreadable('a clone result');
          return place;
        },
        (e) => {
          // only this attempt's own progress, and none once Host access is gone
          if (e.event !== 'progress' || e.key !== params.key || !allowed() || !text(e.phase) || !Number.isFinite(e.percent)) return;
          onProgress({ hostId, key: params.key, phase: e.phase, percent: e.percent });
        },
      );
    },

    /** A worktree of the repository `repo` on `branch`, beside it on the machine; `from`: the branch a new `branch` starts from (a Host without the feature is refused with `host_outdated` before the request is sent). @param {string} hostId @param {{ key: string, repo: string, branch: string, from?: string }} q */
    async worktree(hostId, q) {
      const params = parseParams('git.worktree', q);
      return withSession(hostId, async (s) => {
        // a start branch a Host without the feature would drop is a worktree from the wrong commit: such a Host is refused before it is sent
        if (params.from !== undefined) {
          const { features } = await sayHello(s).catch((e) => outdated(e, 'start a chat in a worktree'));
          if (!features.includes(GIT_BRANCH_FEATURE))
            throw new HostError('host_outdated', 'Update the Host on that machine to start a chat in a worktree.');
        }
        const place = readPlace(await s.call('git.worktree', params, { timeoutMs: WORKTREE_MS }));
        if (!place) throw unreadable('a worktree result');
        return place;
      });
    },

    /**
     * Record that the chat runs in `folder` on `hostId`. A chat nobody claimed is owned by that Host; one already handed over keeps its owner and epoch. A side map that cannot be read refuses (the caller says so) rather than starting over.
     * @param {string} chatId @param {{ hostId: string, folder: string }} q
     */
    bind(chatId, { hostId, folder }) {
      if (!text(folder)) throw new HostError('invalid', 'A folder is required.');
      // the local Host is the default for a chat with no record
      if (hostId === LOCAL_HOST_ID) return;
      const prior = store.get(chatId);
      const fresh = prior.ownerHostId === LOCAL_HOST_ID;
      store.set(chatId, { hostId, ownerHostId: fresh ? hostId : prior.ownerHostId, epoch: prior.epoch, folder });
    },

    dispose() {
      disposed = true;
      closeAll();
    },
  };
}

module.exports = { createHostFolders };
