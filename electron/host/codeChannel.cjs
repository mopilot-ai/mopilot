// The channel the code transfer (codeTransfer.cjs) reads and writes repositories through: this Mac's own git for a folder on this Mac, an authenticated session for a folder on a machine (docs: design/host/index.html, package 3.5).
const { LOCAL_HOST_ID } = require('./ownership.cjs');
const schema = require('../../shared/host/schema.mjs');

/** How long a clone or a carry may take on a machine. */
const CLONE_MS = 600_000;
const CARRY_MS = 120_000;

/** What this Mac cannot do as the target of a continue yet: clone a repository for the chat (the folder must already be here). */
const cannotClone = () => {
  throw Object.assign(new Error('This Mac cannot clone the repository for this chat yet. Pick a folder that is already here.'), {
    code: 'unsupported',
  });
};

/**
 * @param {object} o
 * @param {(hostId: string) => Promise<{ call: (method: string, params?: object, opts?: { timeoutMs?: number }) => Promise<any>, close: () => void }>} o.session an authenticated session to a machine
 * @param {{ inspect: (q: any) => Promise<any>, carryPlan: (q: any) => Promise<any>, carryPush: (q: any) => Promise<any>, carryApply: (q: any) => Promise<any>, carryDrop: (q: any) => Promise<any> }} o.localGit this Mac's folders, read the way a Host reads its own (host/src/hostGit.mjs, passed in)
 */
function createCodeChannel({ session, localGit }) {
  /** One request to a machine on its own session. @param {string} hostId @param {string} method @param {object} params @param {number} [timeoutMs] */
  async function remote(hostId, method, params, timeoutMs) {
    const s = await session(hostId);
    try {
      return await s.call(method, params, timeoutMs ? { timeoutMs } : undefined);
    } finally {
      s.close();
    }
  }
  const isLocal = (/** @type {string} */ hostId) => hostId === LOCAL_HOST_ID;
  return {
    inspect: (/** @type {string} */ hostId, /** @type {string} */ path) =>
      isLocal(hostId) ? localGit.inspect({ path }) : remote(hostId, 'git.inspect', { path }),
    clone: (/** @type {string} */ hostId, /** @type {any} */ q) =>
      isLocal(hostId) ? cannotClone() : remote(hostId, 'git.clone', q, CLONE_MS),
    carry: {
      plan: (/** @type {string} */ hostId, /** @type {any} */ q) =>
        isLocal(hostId) ? localGit.carryPlan(schema.parseParams('git.carryPlan', q)) : remote(hostId, 'git.carryPlan', q),
      push: (/** @type {string} */ hostId, /** @type {any} */ q) =>
        isLocal(hostId) ? localGit.carryPush(schema.parseParams('git.carryPush', q)) : remote(hostId, 'git.carryPush', q, CARRY_MS),
      apply: (/** @type {string} */ hostId, /** @type {any} */ q) =>
        isLocal(hostId) ? localGit.carryApply(schema.parseParams('git.carryApply', q)) : remote(hostId, 'git.carryApply', q, CARRY_MS),
      drop: (/** @type {string} */ hostId, /** @type {any} */ q) =>
        isLocal(hostId) ? localGit.carryDrop(schema.parseParams('git.carryDrop', q)) : remote(hostId, 'git.carryDrop', q),
    },
  };
}

module.exports = { createCodeChannel };
