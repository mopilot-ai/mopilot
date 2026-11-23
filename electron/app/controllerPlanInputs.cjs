// Bind live per-segment tool inventories and native controllers to the shared controller-plan snapshot.
const { planInputs } = require('../session/controllerPlan.cjs');

function controllerPlanInputs({ live, isFlagEnabled, claude, claudeTurns }) {
  return planInputs({
    tools: () => live.capabilities.list().map((t) => t.name),
    yourChrome: () => !!live.browserControl?.drivesUserChrome(),
    claude: {
      channel: () => isFlagEnabled('channel.claude.sdkMcp'),
      toolsOf: (key, names) => claude.toolsOf(key, names),
      nativeChromeOf: (key) => claude.nativeChromeOf(key),
      nativeChromeFor: (chatId) => claude.nativeChromeFor(claudeTurns.accountOf(chatId)),
    },
    codex: {
      channel: () => !!live.codexTools?.hasTools(),
      toolsOf: (id) => live.codexTools?.toolsOf(id) ?? null,
      loadedPath: (threadId) => live.codexTools?.loadedPath(threadId) ?? null,
      nativeSurfaces: () => /** @type {NonNullable<typeof live.codexTools>} */ (live.codexTools).routedSurfaces().surfaces,
      iabAvailable: () => live.codexTools?.iabAvailable() === true,
      chromeBackend: () => live.codexChromeBackends,
    },
    acp: {
      channel: () => !!live.acpTools && isFlagEnabled('channel.acp.sessionMcp'),
      toolsOf: (key, names) => live.acpTools?.toolsOf(key, names) ?? null,
    },
  });
}

module.exports = { controllerPlanInputs };
