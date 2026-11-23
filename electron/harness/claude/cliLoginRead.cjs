// The CLI's own Claude login is read before a turn can hit a limit (#3157): until its first status read it lists as
// signed out, so a limit then could not move the chat to it. The read is main's own (no window needed), one at a time.
const { clock } = require('../../platform/ports/clock.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** How long a turn waits for the CLI login's first read before it starts on what is known. */
const READ_WAIT_MS = 5000;
/** adapter -> the read under way (waited: a turn waited it out), so every turn meanwhile waits on the same one */
/** @type {WeakMap<object, { done: Promise<void>, waited: boolean }>} */
const reads = new WeakMap();
/** The credential generation for a CLI login whose owner explicitly renewed it. */
const renewals = new WeakMap();

/**
 * Read the CLI's own login once if nothing has read it since the app started. Its answer is taken even when a later read
 * (a window's refresh) is under way: that one still lands after it, and until one lands the login is unread.
 * @param {any} accounts ClaudeAccounts (harness/claude/accounts.cjs)
 * @param {string | null} bin the Claude binary
 * @param {boolean} [refresh] the CLI has a new login; retire reads of its previous credential before asking
 */
async function readCliLogin(accounts, bin, refresh = false) {
  if (!accounts || (!refresh && accounts.defaultChecked)) return;
  if (refresh) renewals.set(accounts, {});
  const owner = renewals.get(accounts);
  const read = await accounts.readStatus(bin, 'default');
  if (renewals.get(accounts) !== owner || ((refresh || accounts.defaultChecked) && !read.current())) return;
  accounts.takeDefault(read.status);
  accounts.changed();
}

/**
 * Before a turn starts: while the CLI's own login is unread and another login is listed (there is a login to move
 * between), it is read first, at most READ_WAIT_MS. One read at a time: turns meanwhile wait on the same one, and once
 * a turn has waited it out, later turns do not wait for it again (a CLI that hangs costs one wait, not one per turn).
 * A key runs the whole harness, so it never waits. Null when nothing needs reading.
 * @param {any} adapter ClaudeAdapter
 * @returns {Promise<void> | null}
 */
function cliLoginRead(adapter) {
  const { api } = adapter;
  if (!api.readCliLogin || api.keyMode?.()) return null;
  const { accounts } = api.accounts();
  if (accounts.length < 2 || !accounts.some((/** @type {any} */ a) => a.checked === false)) return null;
  let read = reads.get(adapter);
  if (!read) {
    const entry = {
      waited: false,
      done: Promise.resolve()
        .then(() => api.readCliLogin(adapter.prefs().claudeBin))
        .catch((/** @type {unknown} */ error) => noteIgnored("read the Claude Code CLI's own login before a turn", error))
        .finally(() => reads.delete(adapter)),
    };
    reads.set(adapter, entry);
    read = entry;
  }
  if (read.waited) return null;
  const entry = read;
  const out = new Promise((r) => clock.setTimeout(r, adapter.loginReadWaitMs ?? READ_WAIT_MS)?.unref?.()).then(() => {
    entry.waited = true;
  });
  return Promise.race([entry.done, out]);
}

module.exports = { readCliLogin, cliLoginRead, READ_WAIT_MS };
