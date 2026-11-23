// How a notification names the agent a chat runs on: a basic harness by its quirks' label, a first-tier one (and a Host's Claude Code or Codex, `acp:host-<family>`) by its own label, never by the wire id.
const { HARNESS_LABEL } = require('../../shared/handoff.mjs');
const { hostFamilyOfHarness } = require('../../shared/host/chatIds.mjs');
const { parseKind } = require('../../shared/harnessKind.mjs');

/**
 * @param {{ describe(basic: string): { label?: string } | null | undefined }} quirks the basic harnesses' quirks
 * @returns {(kind: string) => string}
 */
function machineAwareLabel(quirks) {
  return (kind) => {
    const parsed = parseKind(kind);
    if (!parsed) return String(kind);
    const family = parsed.basic ? hostFamilyOfHarness(parsed.basic) : parsed.family;
    const named =
      parsed.basic && !family ? quirks.describe(parsed.basic)?.label : HARNESS_LABEL[/** @type {'codex' | 'claude'} */ (family)];
    // an agent this app has no name for is shown by its own id, without the `acp:` of the wire
    return named ?? /** @type {string} */ (parsed.basic); // a first-tier kind always has its label
  };
}

module.exports = { machineAwareLabel };
