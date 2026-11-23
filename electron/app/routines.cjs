// Action memory in main (#3571, G4): the routine store under the app's data folder, the recorder the browser tools
// register through (app/browserTools.cjs), the routine_* tools on every harness's tool channel, each chat's turn end
// on any harness (ChatController onFinished), and the routines kept in step as skills of the bundled "routines" plugin.
const path = require('node:path');
const { RoutineStore } = require('../capabilities/routines/routineStore.cjs');
const { RoutineRecorder } = require('../capabilities/routines/routineRecorder.cjs');
const { registerRoutineTools } = require('../capabilities/routines/routineTools.cjs');
const { syncRoutineSkills, PLUGIN } = require('../capabilities/routines/routineSkills.cjs');
const { routineTurnStarting } = require('../capabilities/routines/routineMatch.cjs');
const { addHook, addGuard } = require('../session/hookChain.cjs');
const { ownerOf } = require('../platform/segmentOwner.cjs');
const { pluginService } = require('../plugins/service.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { CONTROLLER_LABEL, SURFACES } = require('../../shared/controllerPlan.mjs');

/** Controllers whose calls never reach the Registry, so a routine can't record them (G4's degraded cases). */
const UNRECORDED = new Set(['codex-browser-plugin', 'claude-in-chrome', 'codex-computer-use', 'your-chrome']);

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services (capabilities, controller, chats)
 * @param {string} o.userData the app's data folder
 * @param {any} o.safeStorage
 * @param {(folder: string) => Promise<unknown>} [o.seed] puts the plugin folder in the plugin store (tests replace it)
 * @param {number} [o.startDelayMs] how long after start the routines are first listed as skills
 * @param {((channel: string) => void) | null} [o.broadcast] tells every window the routines changed (routines:changed)
 */
function openRoutines({ live, userData, safeStorage, seed, startDelayMs = 5000, broadcast = null }) {
  const dir = path.join(userData, 'routines');
  const store = new RoutineStore({ file: path.join(dir, 'routines.sealed'), keyFile: path.join(dir, 'routines.key'), safeStorage });
  const recorder = new RoutineRecorder({ store });
  /** The controller outside MoPilot's tools that drives one of the chat's surfaces now (its controller plan), by name. */
  const unrecorded = (/** @type {string} */ chatId) => {
    const plan = live.sessions?.get(chatId)?.controllerPlan;
    const c = SURFACES.map((s) => plan?.[s]).find((x) => UNRECORDED.has(x));
    return c ? /** @type {Record<string, string>} */ (CONTROLLER_LABEL)[c] : null;
  };
  store.onChange(() => broadcast?.('routines:changed'));
  registerRoutineTools(live.capabilities, {
    store,
    recorder,
    adapters: (prefix) => recorder.adapter(prefix),
    unrecorded,
    // skills is made below, before any call can reach this
    skillsProblem: () => skills.problem(),
    invoke: (chatId, segmentId, tool, args, o) => live.capabilities.invoke(chatId, segmentId, tool, args, o),
    // a harness switch makes another segment the chat's current one: a replay started on the old one stops
    current: (ctx) => ownerOf(live.chats?.records, ctx, { current: true }) === ctx.chatId,
    tainted: (chatId) => live.capabilities.taint.taintedBy(chatId).length > 0,
  });
  if (live.controller)
    addGuard(live.controller, 'beforeDispatch', (/** @type {{ chatId: string, kind?: string, item?: any }} */ e) => {
      try {
        routineTurnStarting({ recorder, store, apart: (chatId) => live.capabilities.isApart(chatId) }, e);
      } catch (error) {
        // a routine that can't be read never costs the user their message
        noteIgnored('look for a saved routine for a message', error);
      }
    });
  if (live.controller)
    addHook(live.controller, 'onFinished', (/** @type {{ chatId: string, completed?: boolean, turnId?: string | null }} */ e) => {
      if (!e?.chatId) return;
      const { offer } = recorder.turnFinished(e.chatId, e.completed === true);
      // the one line after the turn offering to keep its steps; any other end takes an earlier offer back
      // an offer means the turn's steps are the chat's last turn now
      const steps = offer ? /** @type {{ steps: any[] }} */ (recorder.lastTurn(e.chatId)).steps.length : 0;
      live.sessions?.patch(e.chatId, { routineOffer: steps ? { turnId: e.turnId ?? null, steps } : null });
    });
  if (live.chatDeletion) addHook(live.chatDeletion, 'onDeleted', (/** @type {{ chatId: string }} */ r) => recorder.forget(r.chatId));
  const skills = syncRoutineSkills({
    dir,
    store,
    seed: seed ?? ((folder) => pluginService().store.seedBundled(folder, { name: PLUGIN, marketplace: 'mopilot' })),
    onProblem: () => broadcast?.('routines:changed'),
  });
  // off the startup path: reading the sealed store asks the keychain
  const first = setTimeout(() => skills.sync().catch((error) => noteIgnored('list routines as skills at startup', error)), startDelayMs);
  first.unref?.();
  return {
    store,
    recorder,
    unrecorded,
    skillsProblem: () => skills.problem(),
    /** The registry the browser tools register on, recording their calls on `tabs`. */
    recording: (/** @type {any} */ registry, /** @type {any} */ tabs) => recorder.recording(registry, tabs),
    stop: () => {
      clearTimeout(first);
      skills.stop();
    },
  };
}

module.exports = { openRoutines };
