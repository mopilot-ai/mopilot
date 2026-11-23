// Keeps phone-input folder checks scoped to the current machine, ownership epoch and cwd, and recreates them after restart or retry.
/** @param {{ ownerOf: (chatId: string) => { hostId: string, epoch: number, folder?: string | null }, checkFolder?: (hostId: string, folder: string) => Promise<unknown> }} o */
function createSendChecks({ ownerOf, checkFolder }) {
  /** @type {Map<string, { owner: string, verdict: Promise<{ error: unknown } | null> }>} */
  const checks = new Map();
  const identity = (/** @type {ReturnType<typeof ownerOf>} */ owner) => JSON.stringify([owner.hostId, owner.epoch, owner.folder]);
  /** @param {Promise<unknown>} gate */
  const observe = (gate) =>
    gate.then(
      () => null,
      (error) => ({ error }),
    );
  /** @param {string} chatId @param {string} key @param {ReturnType<typeof observe>} verdict */
  function set(chatId, key, verdict) {
    checks.set(key, {
      owner: identity(ownerOf(chatId)),
      verdict,
    });
  }
  return {
    set,
    observe,
    /** @param {string} key */
    clear: (key) => checks.delete(key),
    /** Every drain waits for the same check, re-reading ownership after each await. @param {any} entry */
    async validate(entry) {
      if (!entry.options.requiresFolderCheck) return;
      while (true) {
        const owner = ownerOf(entry.chatId);
        let check = checks.get(entry.key);
        if (!check || check.owner !== identity(owner)) {
          const folder = owner.folder;
          const gate =
            checkFolder && typeof folder === 'string'
              ? Promise.resolve().then(() => checkFolder(owner.hostId, folder))
              : Promise.reject(new Error('The folder must be checked before this message can be sent.'));
          set(entry.chatId, entry.key, observe(gate));
          check = /** @type {NonNullable<typeof check>} */ (checks.get(entry.key));
        }
        const verdict = await check.verdict;
        if (identity(ownerOf(entry.chatId)) !== check.owner) continue;
        if (verdict) {
          const why = verdict.error;
          throw Object.assign(why instanceof Error ? why : new Error('The host refused it.'), { code: 'directory_missing' });
        }
        return;
      }
    },
  };
}
module.exports = { createSendChecks };
