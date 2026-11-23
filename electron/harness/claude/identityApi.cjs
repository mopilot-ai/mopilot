// The pieces of the Claude harness the identity layer reads (electron/identity/drivers/claude.cjs): the logins, the key,
// the gateway and a login's /usage text.

/**
 * @param {{ state: any, auth: any, cli: any, usageSchedule: any }} o the harness's state, auth, CLI and usage schedule
 */
function createIdentityApi({ state, auth, cli, usageSchedule }) {
  /** A surface read retains the schedule's measurement time, account and live windows. */
  const readUsageResult = async (account, reason = 'surface') => {
    if (auth.configIdOf(account) !== account) return { state: 'error', error: 'Account usage is unavailable while a key is selected.' };
    const bin = await cli.findBinary();
    if (auth.configIdOf(account) !== account) return { state: 'retired' };
    if (!bin) return { state: 'error', error: 'Claude Code is not installed.' };
    const result = await usageSchedule.usage(bin, account, reason);
    if (auth.configIdOf(account) !== account) return { state: 'retired' };
    return result;
  };
  return {
    readUsageResult,
    accounts: () => state.accts,
    keyInfo: () => auth.apiKeyInfo(),
    gatewaySet: () => !!state.gatewayKey(),
    /** @param {string} account */
    readUsage: async (account) => {
      const bin = await cli.findBinary();
      if (!bin) return '';
      const r = await usageSchedule.usage(bin, account, 'surface');
      if (r.state === 'error') throw new Error(r.error);
      if (r.state === 'retired') throw new Error('The login changed during its usage read.');
      return r.text;
    },
  };
}

module.exports = { createIdentityApi };
