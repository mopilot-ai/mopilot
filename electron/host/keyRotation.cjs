// Rotating this app's key across its machines (#4142): a new key is made and added to every machine first (each trusts it to sign updates and to connect), the app switches to it only when all of them have it, and then each machine is told to drop the old one. A machine that cannot be reached for the first step stops the rotation before this app switches identity; one that cannot be reached for the last is remembered and told on the next run. The signed manifests are the same updates the app sends (hostUpdate.cjs), carrying the key change.
/** A refusal with a code the window can tell apart. @param {string} code @param {string} message */
const refuse = (code, message) => Object.assign(new Error(message), { code });
const { userError } = require('../../shared/userError.mjs');
const RETRY_NOTICE = 'This Mac still uses its current key. Some machines may already trust the new key; try again to finish.';

/**
 * @param {object} o
 * @param {{ list: () => { id: string, name?: string, address: string, status?: string }[] }} o.registry
 * @param {{ update: (id: string, change: { nextKey?: string, revoke?: string[] }) => Promise<unknown> }} o.updater
 * @param {() => ReturnType<typeof import('./pairingClient.cjs').loadIdentity>} o.identity
 * @param {(record: { id: string }) => boolean} o.current whether a machine's Host is not behind the build this app carries: an older one does not know key changes
 * @param {(record: { id: string }) => boolean} [o.newer] whether a machine's Host is newer than this app: the key goes to a machine in an update, and this app's older build would replace it
 */
function createKeyRotation({ registry, updater, identity, current, newer = () => false }) {
  /** The rotation under way: a second call joins it instead of starting another. @type {Promise<{ machines: number, pending: { id: string, error: string }[] }> | null} */
  let running = null;
  /** Told to a machine that must drop the retiring key; the ones that took it are forgotten by the identity. @param {ReturnType<typeof identity>} idn @param {string[]} ids */
  async function revokeOld(idn, ids) {
    const retiring = idn.retiring();
    // nothing to drop when no machine was left to tell
    if (!retiring) return [];
    const old = retiring.id;
    /** @type {{ id: string, error: string }[]} */
    const pending = [];
    for (const id of ids) {
      if (!registry.list().some((m) => m.id === id)) {
        idn.retired(id);
        continue;
      }
      try {
        await updater.update(id, { revoke: [old] });
        idn.retired(id);
      } catch (e) {
        pending.push({ id, error: userError(e) });
      }
    }
    return pending;
  }

  /** @returns {Promise<{ machines: number, pending: { id: string, error: string }[] }>} */
  async function rotateOnce() {
    const idn = identity();
    const retiring = idn.retiring();
    if (retiring) {
      const pending = await revokeOld(idn, retiring.machines);
      return { machines: retiring.machines.length - pending.length, pending };
    }
    const machines = registry.list();
    // a machine that cannot be told would lock the app out once it has switched; the key goes to a machine inside an update, which a machine added by command (no ssh, #4912) can never take from here, so it stops the rotation until it is removed (skipping it would leave the app locked out of it), and a Host newer than this app would be downgraded by it (#4923)
    const named = (/** @type {{ id: string, name?: string }[]} */ list) => list.map((m) => m.name ?? m.id).join(', ');
    const noSsh = machines.filter((m) => m.address.startsWith('relay:'));
    const ssh = machines.filter((m) => !noSsh.includes(m));
    const newerHosts = ssh.filter((m) => m.status !== 'offline' && newer(m));
    const notReady = ssh.filter((m) => m.status === 'offline' || (!newerHosts.includes(m) && !current(m)));
    const reasons = [
      notReady.length > 0 && `Every machine must be online and up to date first: ${named(notReady)}.`,
      newerHosts.length > 0 && `Update MoPilot first: ${named(newerHosts)}.`,
      noSsh.length > 0 && `No ssh to give a new key: ${named(noSsh)}. Remove it, rotate, then add it again.`,
    ].filter(Boolean);
    if (reasons.length > 0) throw refuse('rotation_blocked', reasons.join(' '));
    const next = idn.startRotation();
    for (const m of machines) {
      try {
        await updater.update(m.id, { nextKey: next.pem });
      } catch (e) {
        throw refuse('rotation_failed', `Could not confirm the new key on ${m.name ?? m.id}: ${userError(e)} ${RETRY_NOTICE}`);
      }
    }
    // a machine paired meanwhile was paired with the old key and was not given the new one: the app would lose it
    if (registry.list().some((m) => !machines.some((known) => known.id === m.id)))
      throw refuse('rotation_failed', `A machine was added during the rotation. ${RETRY_NOTICE}`);
    // every machine trusts the new key: from here the app uses it
    idn.promote(machines.map((m) => m.id));
    const pending = await revokeOld(
      idn,
      machines.map((m) => m.id),
    );
    return { machines: machines.length - pending.length, pending };
  }

  return {
    /**
     * One rotation, or the rest of one: machines still to be told to drop the old key are told first; a second call while one runs joins it. Resolves `{ machines, pending }`: how many machines now trust only the new key, and those that did not take the revocation (each with why; they are told on the next run). Throws before switching this app’s identity when a machine cannot take the new key; machines already reached may trust both keys, and retry uses the same next key.
     * @returns {Promise<{ machines: number, pending: { id: string, error: string }[] }>}
     */
    rotate() {
      running ??= rotateOnce().finally(() => (running = null));
      return running;
    },
  };
}

module.exports = { createKeyRotation };
