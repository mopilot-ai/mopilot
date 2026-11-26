// What each harness family does differently in main, as data: shared session code reads a trait here (or picks the
// family's entry from its own per-family table), never a harness name, so a new family must answer every trait.
const { byFamily } = require('../session/contract/route.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { hostFamilyOfHarness } = require('../../shared/host/chatIds.mjs');

/**
 * @typedef {object} MainTraits
 * @property {boolean} steers a message can go into a running turn; otherwise it waits for the next one
 * @property {boolean} nativeGoal a goal is set through the adapter's own `startGoal`; otherwise the harness is sent its /goal command
 * @property {boolean} namesTurnLate a start can return before the harness names its turn (a Codex goal's turn is named
 *   only by turn/started), so the turn counts as started only once it is named
 * @property {boolean} holdsGoal MoPilot holds the chat's goal (pause, resume, round limit) and keeps it in the chat's file
 * @property {boolean} nativeChrome its sessions ran Claude in Chrome themselves, which Your Chrome replaces
 * @property {boolean} nativePlanApproval the adapter emits an accepted root plan permission before native continuation
 * @property {boolean} reportsFindings its code review reports findings through ReportFindings, so a fix request asks for
 *   their outcomes the same way (the renderer's HARNESS_TRAITS has the same trait)
 */

/** @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, MainTraits>} */
const MAIN_TRAITS = {
  codex: {
    steers: true,
    nativeGoal: true,
    namesTurnLate: true,
    holdsGoal: false,
    nativeChrome: false,
    nativePlanApproval: false,
    reportsFindings: false,
  },
  claude: {
    steers: true,
    nativeGoal: false,
    namesTurnLate: false,
    holdsGoal: true,
    nativeChrome: true,
    nativePlanApproval: true,
    reportsFindings: true,
  },
  // a basic harness: ACP has no way into a running prompt, and its goal is a command it lists
  acp: {
    steers: false,
    nativeGoal: false,
    namesTurnLate: false,
    holdsGoal: false,
    nativeChrome: false,
    nativePlanApproval: false,
    reportsFindings: false,
  },
};

/**
 * The traits of a segment kind's family; throws for a kind this build doesn't know.
 * @returns {MainTraits}
 */
const traitsOf = (kind) => byFamily(MAIN_TRAITS, kind);

/**
 * The traits of the agent a kind runs, or null for a kind this build doesn't know: a machine's Claude Code or Codex chat
 * is drawn here as ACP (`acp:host-claude`) and runs that agent on its Host, as the wire's kind (`claude`) names it.
 * @param {unknown} kind
 * @returns {MainTraits | null}
 */
function agentTraitsOf(kind) {
  const parsed = parseKind(kind);
  return parsed ? MAIN_TRAITS[(parsed.basic !== null && hostFamilyOfHarness(parsed.basic)) || parsed.family] : null;
}

module.exports = { MAIN_TRAITS, traitsOf, agentTraitsOf };
