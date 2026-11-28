// Installs Auto model routing on main's ChatController: the local router loads on the first Auto turn, Global Auto scores
// the harnesses the orchestrator says can take a chat now, and no failure here ever stops a turn from starting.
const { createAutoRoute } = require('../autoRoute/service.cjs');
const { createHarnessScorer } = require('../autoRoute/harnessScore.cjs');
const { createSessionSettings } = require('./sessionSettings.cjs');
const { addGuard, addHook } = require('../session/hookChain.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * The router, loaded once on first use; null when it can't run here (its assets or runtime are missing).
 * @param {{ userData?: string }} [options] where else its weights may be (the packaged resources and the checkout are its defaults)
 * @param {() => { createSquillaRouter: (o: object) => any }} [load]
 * @returns {() => Promise<any>}
 */
function routerLoader(options = {}, load = () => require('../autoRoute/squilla/router.cjs')) {
  /** @type {Promise<any> | null} */
  let loading = null;
  return () =>
    (loading ??= (async () => {
      try {
        const router = load().createSquillaRouter(options);
        return (await router.available()) ? router : null;
      } catch (error) {
        noteIgnored('load the Auto router', error);
        return null;
      }
    })());
}

/**
 * @param {any} live main's late-bound services: controller, chats, codex, claudeTurns, acpHost
 * @param {{ orchestrator: any, prefs: () => any, changed: (chatId: string) => void, userData?: string, router?: () => Promise<any>, table?: any }} o
 */
function installAutoRoute(
  live,
  { orchestrator, prefs, changed, userData, router = routerLoader({ userData }), table = require('../autoRoute/hmTable.json') },
) {
  const settings = createSessionSettings({ live, prefs, usable: (kind) => orchestrator.o.usable(kind) });
  const service = createAutoRoute({
    controller: live.controller,
    chats: live.chats,
    settings,
    router,
    scorer: createHarnessScorer(table),
    harnesses: {
      kinds: () => orchestrator.o.kinds?.() ?? [],
      fit: async (kind) => (await orchestrator.o.usable(kind)) && orchestrator.o.quota?.(kind)?.limited !== true,
    },
    prefs,
    changed,
  });
  const quietly =
    (/** @type {string} */ what, /** @type {(...a: any[]) => unknown} */ fn) =>
    async (/** @type {any[]} */ ...args) => {
      try {
        await fn(...args);
      } catch (error) {
        noteIgnored(what, error);
      }
    };
  addGuard(live.controller, 'beforeDispatch', quietly('route an Auto turn', service.beforeDispatch));
  addHook(live.controller, 'onFinished', quietly('note how an Auto turn went', service.finished));
  const previous = live.controller.beforeStart;
  const globalStep = quietly('choose the harness for a Global Auto turn', service.beforeStart);
  live.controller.beforeStart = previous
    ? async (/** @type {any} */ start) => {
        await previous(start);
        await globalStep(start);
      }
    : globalStep;
  return service;
}

module.exports = { installAutoRoute, routerLoader };
