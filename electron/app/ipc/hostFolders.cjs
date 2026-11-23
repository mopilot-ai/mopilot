// IPC for a machine's folders (package 2.7, #4103, #5050), registered by ipc/host.cjs (`registeredBy`): browse, search, read the repository and the files of a chat's folder on a machine, commit, discard and switch branch there, read its branches, clone and make worktrees; each is the folders service's method of the same purpose (electron/host/folders.cjs), the machine's id first.

const { sidebarRepositories } = require('../../platform/sidebarRepositories.cjs');
const { sidebarRepository } = require('../../../shared/sidebarRepository.mjs');

/**
 * @param {object} o
 * @param {(channel: string, fn: (...args: any[]) => unknown) => void} o.handle the Host IPC's own handler (gate, error shape)
 * @param {{getPath: (name: string) => string}} [o.app]
 * @param {(id: string) => {hostKey: string, status: string} | undefined} o.machine
 * @param {() => Record<string, (hostId: string, q: any) => unknown>} o.folders the folders service, made on first use
 */
function registerHostFolders({ handle, folders, app, machine }) {
  const ask = (/** @type {string} */ method) => (/** @type {unknown} */ id, /** @type {any} */ q) => {
    const hostId = String(id ?? '');
    if (q?.expectedHostKey !== undefined && q.expectedHostKey !== machine(hostId)?.hostKey)
      throw Object.assign(new Error('This machine changed. Choose where to run the chat again.'), { code: 'machine_changed' });
    return folders()[method](hostId, q ?? {});
  };
  handle('host:fsList', ask('list'));
  handle('host:fsSearch', ask('search'));
  handle('host:commands', ask('commands'));
  handle('host:sidebarRepository', (id, q) => {
    const owner = machine(id);
    if (!app || !owner || typeof q?.path !== 'string' || !q.path) return null;
    const key = JSON.stringify([id, owner.hostKey, q.path]);
    const probe = async () => {
      if (owner.status === 'offline') return undefined;
      const origin = await folders().repository(id, { path: q.path });
      if (origin === undefined || machine(id)?.hostKey !== owner.hostKey) return undefined;
      return sidebarRepository(origin);
    };
    if (q.fresh === true) return (q.expectedHostKey ?? '') === owner.hostKey ? probe().then((value) => value ?? null) : null;
    return sidebarRepositories(app.getPath('userData'))(key, probe);
  });
  handle('host:gitStatus', ask('status'));
  handle('host:gitDiff', ask('diff'));
  handle('host:gitTurnDiff', ask('turnDiff'));
  handle('host:gitBranches', ask('branches'));
  handle('host:gitSwitch', ask('switchBranch'));
  handle('host:gitCommit', ask('commit'));
  handle('host:gitDiscard', ask('discard'));
  handle('host:fsTree', ask('tree'));
  handle('host:fsRead', ask('read'));
  handle('host:clone', ask('clone'));
  handle('host:worktree', ask('worktree'));
}

module.exports = { registerHostFolders, registeredBy: 'host' };
