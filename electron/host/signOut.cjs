// Sign out everywhere (#3361 Tier 1 and 2): every machine in the list takes back the user's model key and any organization lease (host.orgLease with none) and signs Claude Code and Codex out with their own CLIs (host.modelKey with none, host.logout); each machine's result is told as it is, and one that cannot be reached is listed as not signed out, never as done.
const { KEYED } = require('../../shared/host/credentials.mjs');
const { ORG_HARNESSES } = require('../../shared/host/orgAccess.mjs');
const { agentLabel } = require('../../shared/host/agentReadiness.mjs');
const { clock } = require('../platform/ports/clock.cjs');

/** The agents signed in on a machine with the vendor's own CLI, which a Host can sign out. */
const CLI_AGENTS = ['claude', 'codex'];
/** How long a machine may take to answer before it counts as not reached. */
const REACH_MS = 15_000;

/** @typedef {{ id: string, label: string, signedOut: boolean, error: string | null }} AgentResult */
/** @typedef {{ id: string, name: string, state: 'done' | 'partial' | 'offline' | 'failed', agents: AgentResult[], error: string | null }} MachineResult */

const messageOf = (/** @type {any} */ e) => String(e?.message ?? e);

/**
 * @param {object} o
 * @param {{ id: string, name: string, status: string, harnesses: { id: string, detected: boolean }[] }[]} o.machines the registry's rows
 * @param {(id: string) => any} o.hostFor a machine's remote Host (machines.cjs), connected here; null when it cannot be had
 * @param {number} [o.reachMs]
 * @param {string | null} [o.orgIdentity] the org identity signed in here: its leases go; another person's on a shared machine stay
 * @returns {Promise<MachineResult[]>}
 */
async function signOutEverywhere({ machines, hostFor, reachMs = REACH_MS, orgIdentity = null }) {
  return Promise.all(
    machines.map(async (m) => {
      /** @type {MachineResult} */
      const out = { id: m.id, name: m.name, state: 'done', agents: [], error: null };
      if (m.status === 'offline') return { ...out, state: 'offline', error: `Couldn't reach ${m.name}. Sign out there when it's back.` };
      const host = hostFor(m.id);
      /** @type {any} */
      let timer;
      try {
        if (!host) throw new Error('Host is not available for this account.');
        await Promise.race([
          host.connect(),
          new Promise((_, reject) => {
            timer = clock.setTimeout(() => reject(new Error(`Couldn't reach ${m.name}.`)), reachMs);
          }),
        ]);
      } catch (e) {
        return { ...out, state: 'offline', error: messageOf(e) };
      } finally {
        clock.clearTimeout(timer);
      }
      // the key first: a Host that keeps it would run the next turn with it; an older Host never held one (feature_missing), or none for that agent (invalid: it takes no key for it yet)
      for (const harness of Object.keys(KEYED)) {
        try {
          await host.modelKey({ harness, key: null });
        } catch (e) {
          const code = /** @type {any} */ (e)?.code;
          if (code !== 'feature_missing' && code !== 'invalid') out.error = messageOf(e);
        }
      }
      // and any organization lease: a machine this app never reached since its last start may still hold one; an older Host never held one
      for (const harness of orgIdentity ? Object.keys(ORG_HARNESSES) : []) {
        try {
          await host.orgLease({ harness, identity: orgIdentity, token: null });
        } catch (e) {
          if (/** @type {any} */ (e)?.code !== 'feature_missing') out.error = messageOf(e);
        }
      }
      for (const id of CLI_AGENTS) {
        if (!m.harnesses.some((h) => h.id === id && h.detected)) continue;
        try {
          const r = await host.logout({ harness: id });
          out.agents.push({
            id,
            label: agentLabel(id),
            signedOut: r?.signedOut === true,
            error: r?.signedOut === true ? null : String(r?.error ?? 'Still signed in.'),
          });
        } catch (e) {
          const old = /** @type {any} */ (e)?.code === 'feature_missing';
          out.agents.push({
            id,
            label: agentLabel(id),
            signedOut: false,
            error: old ? 'Update this machine to sign out from here.' : messageOf(e),
          });
        }
      }
      const ok = out.agents.filter((a) => a.signedOut).length;
      const failed = out.agents.length - ok + (out.error ? 1 : 0);
      return { ...out, state: failed === 0 ? 'done' : ok === 0 ? 'failed' : 'partial' };
    }),
  );
}

module.exports = { signOutEverywhere, CLI_AGENTS };
