// What a phone may know and change about this Mac's logins: every login of each harness with its sign-in state, and whether chats may move between them on a limit. Read from the identity registry that owns them; no usage here (usage.get has it).

/** The harnesses whose logins a phone lists, in the order it shows them. */
const HARNESSES = ['claude', 'codex'];

/**
 * @param {any} live main's late-bound services: identity (the registry)
 * @returns {{ scope: 'local', harnesses: { harness: string, autoSwitch: boolean, pool: string }[], accounts: { harness: string, account: string, label: string, status: string, billing: string, active: boolean, limited: boolean }[] }}
 */
function readPhoneAccounts(live) {
  const registry = live.identity;
  if (!registry) throw new Error('Accounts are not ready. Try again.');
  const harnesses = [];
  const accounts = [];
  for (const harness of HARNESSES) {
    const instances = registry.instances(harness);
    if (!instances.length) continue;
    const { autoSwitch, pool } = registry.driver(harness).poolPolicy;
    harnesses.push({ harness, autoSwitch, pool });
    for (const i of instances)
      accounts.push({
        harness,
        account: i.account,
        label: i.label ?? i.account,
        status: i.status,
        billing: i.billing,
        active: i.active === true,
        limited: i.limited === true,
      });
  }
  return { scope: 'local', harnesses, accounts };
}

/**
 * Turns a harness's auto-switch on or off, as Settings → Accounts & billing does, and answers the new state.
 * @param {any} live
 * @param {{ accounts?: () => { setAutoSwitch: (on: boolean) => unknown } | null | undefined }} claude the Claude identity API
 * @param {{ harness: string, on: boolean }} p
 */
function setPhoneAutoSwitch(live, claude, { harness, on }) {
  const pool = harness === 'claude' ? claude.accounts?.() : harness === 'codex' ? live.accounts : null;
  if (!pool) throw new Error('Auto-switch is not available for that harness.');
  pool.setAutoSwitch(on);
  return { harness, autoSwitch: on };
}

module.exports = { readPhoneAccounts, setPhoneAutoSwitch };
