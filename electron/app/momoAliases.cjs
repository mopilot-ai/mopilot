// MoMo's search aliases in main (#2999 P2), over the services app/momo.cjs made: the aliases' writer
// (momo/historyAliases.cjs) on saved facts and the index of past chats, within the day's background tokens
// (momo/backgroundBudget.cjs, shared with the memory pass), its batches in MoMo background chats that are data-only and
// unattended like the memory pass's, on the brain's cheap model (momo/cheapBrain.cjs), skipped while that brain is at its
// limit or the Mac is on battery.
const { budgetIn } = require('../momo/backgroundBudget.cjs');
const { createHistoryAliases } = require('../momo/historyAliases.cjs');
const { cheapBrain } = require('../momo/cheapBrain.cjs');
const { UNATTENDED, ISOLATION } = require('../momo/routines.cjs');
const { roleBrain, isMomoPaused } = require('../../shared/momoPrefs.mjs');
const { momoResetting } = require('../momo/stores.cjs');

/**
 * How often a batch may start: TICK_MS, or in a development build MoMo runs in (MOPILOT_MOMO_DEV=1, as the E2E runs)
 * MOPILOT_MOMO_ALIAS_TICK_MS, so a run need not wait minutes. Undefined: the writer's own.
 * @param {Record<string, string | undefined>} [env]
 */
function tickMsOf(env = process.env) {
  const ms = Number(env.MOPILOT_MOMO_ALIAS_TICK_MS);
  return env.MOPILOT_MOMO_DEV === '1' && ms >= 1000 ? ms : undefined;
}

/** Whether the Mac runs on its battery now (Electron's powerMonitor; false where there is none). */
function onBatteryPower(/** @type {() => any} */ load = () => require('electron')) {
  try {
    return load()?.powerMonitor?.isOnBatteryPower?.() === true;
  } catch {
    return false;
  }
}

/**
 * @param {{ core: any, live: any, allowed: () => boolean, safeStorage: any, startChat: (brain: any, tag: object) => Promise<string>,
 *   send: (chatId: string, item: object) => Promise<unknown>, authored: (chatId: string, text: string, show: object) => object,
 *   discardChat: (chatId: string) => unknown, limitOf: (brain: any) => object, momoPrefs: () => any, onBattery?: () => boolean,
 *   timers?: any, budget?: ReturnType<typeof budgetIn>, sources?: any[] }} d budget: the day's background tokens, shared with
 *   the memory pass; sources: what else gets aliases before past chats (saved facts, momo/factAliases.cjs)
 */
function openMomoAliases({
  core,
  live,
  allowed,
  safeStorage,
  startChat,
  send,
  authored,
  discardChat,
  limitOf,
  momoPrefs,
  onBattery = onBatteryPower,
  timers,
  budget = budgetIn(core.dir, safeStorage),
  sources,
}) {
  const aliases = createHistoryAliases({
    index: core.history,
    allowed: () => allowed() === true && !isMomoPaused(momoPrefs()) && !momoResetting(),
    brain: async () => cheapBrain(roleBrain(momoPrefs()), async () => live.codex?.modelList()),
    atLimit: (/** @type {any} */ brain) => 'held' in limitOf(brain),
    startChat: async (/** @type {any} */ brain, /** @type {object} */ tag) => {
      const chatId = await startChat(brain, { ...tag, isolation: ISOLATION });
      live.sessions?.patch(chatId, { scheduled: UNATTENDED });
      return chatId;
    },
    send: (/** @type {string} */ chatId, /** @type {string} */ text) =>
      send(chatId, authored(chatId, text, { by: 'momo', title: 'Search aliases' })),
    discardChat,
    budget,
    sources,
    onBattery,
    tickMs: tickMsOf(),
    timers,
  });
  return { budget, aliases };
}

module.exports = { openMomoAliases, onBatteryPower, tickMsOf };
