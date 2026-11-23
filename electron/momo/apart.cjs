// What keeps a MoMo chat from starting (#2278): a workspace from which an instructions file would load, on any harness,
// and a harness that can't be confined (a basic one whose quirks have no isolation: its own tools run in its process).
const { reachableInstructions } = require('../harness/instructionFiles.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const acpQuirks = require('../harness/quirks/index.cjs');

/** An error with a code the window can tell apart (as mainChat's). */
const failure = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * Refuse a workspace from which an instructions file would load: no MoMo chat starts there.
 * @param {string} workspace
 */
function assertCleanWorkspace(workspace) {
  const found = reachableInstructions(workspace);
  if (found.length) throw failure('instructions', `MoMo's workspace would load ${found.join(', ')}: remove it to start MoMo.`);
}

/**
 * Refuse a harness that can't be confined, or can't run MoMo now (opencode with free models only, #2357).
 * @param {string} kind @param {string} label its name for the user
 * @param {Record<string, string | undefined>} [env] the login shell's environment
 */
function assertConfinable(kind, label, env = process.env) {
  const basic = parseKind(kind)?.basic;
  if (!basic) return;
  if (!acpQuirks.isolates(basic))
    throw failure('unconfined', `${label} can't be MoMo's brain: its own file and shell tools can't be turned off.`);
  const blocked = acpQuirks.momoBlocked(basic, env);
  if (blocked) throw failure('needs_provider', `${blocked}.`);
}

module.exports = { assertCleanWorkspace, assertConfinable };
