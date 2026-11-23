// Whether a Host can take the chat's agent, asked before anything is carried to it (#4910): a refusal at prepare comes after the files reached the target's folder, and they cannot be taken back.
const { ContinueRefusal, CONTINUE_FAMILIES_FEATURE } = require('../../shared/host/continue.mjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { canonicalHarness, createAgentCheck } = require('../../shared/host/continueFamilies.mjs');
const { LOCAL_HOST_ID } = require('./ownership.cjs');

/**
 * Refuses, with the Host's own codes, a continue the target would refuse at prepare for its agent: a Host older than `continueFamilies` takes ACP agents only, and an installed agent that is missing or signed out is refused by the same rule the Host applies (host/src/continueFamilies.mjs). Whatever the status cannot show (an agent it does not list, a status that cannot be read, this Mac) is left to the Host's own prepare: this never refuses what the Host would take.
 * @param {object} o
 * @param {string} o.hostId
 * @param {string} o.harness the harness the chat runs on
 * @param {(hostId: string) => Promise<{ result: any, features: string[] }>} o.status the target's `host.status` and the features it agreed to
 */
async function assertTargetTakes({ hostId, harness, status }) {
  const kind = parseKind(canonicalHarness(harness));
  if (hostId === LOCAL_HOST_ID || !kind) return;
  /** @type {{ result: any, features: string[] }} */
  let seen;
  try {
    seen = await status(hostId);
  } catch {
    return;
  }
  if (kind.family !== 'acp' && !seen.features.includes(CONTINUE_FAMILIES_FEATURE))
    throw new ContinueRefusal('harness_not_configured', 'That host is too old to take this chat.');
  const rows = Array.isArray(seen.result?.harnesses) ? seen.result.harnesses : [];
  const id = kind.family === 'acp' ? kind.basic : kind.family;
  if (!rows.some((/** @type {{ id: string }} */ r) => r.id === id)) return;
  await createAgentCheck({ rows: async () => rows, acpIds: () => rows.map((/** @type {{ id: string }} */ r) => r.id) })(harness);
}

module.exports = { assertTargetTakes };
