// One queued Codex account selection: validate identity, apply it, and roll back only its unchanged selection.
/** @typedef {InstanceType<typeof import('../codexAccounts.cjs').Accounts>} Accounts */

/** Run inside Accounts.apply's queue, so a later switch captures the settled selection, never an in-flight one. */
async function switchSelection(/** @type {Accounts} */ accounts, id, target) {
  if (!target || accounts.get(id) !== target || accounts.removing.has(id)) throw new Error('Unknown account');
  if (target.status === 'expired') throw new Error('Sign in to this account again first');
  const previousId = accounts.state.active;
  const previous = accounts.get(previousId);
  accounts.state.active = id;
  try {
    await accounts.applyNow();
  } catch (error) {
    // Another writer may have selected or replaced an account while application was pending.
    if (accounts.state.active === id && accounts.get(id) === target) {
      const restore = previous && accounts.get(previousId) === previous && !accounts.removing.has(previousId);
      accounts.state.active = previousId === null ? null : restore ? previousId : (accounts.fallbackFor(target)?.id ?? null);
    }
    accounts.changed();
    throw error;
  }
  accounts.changed();
  return accounts.view();
}

module.exports = { switchSelection };
