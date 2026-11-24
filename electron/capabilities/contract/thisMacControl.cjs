// Carries a Host chat's approved local control target through the registry and its executors.
const { AsyncLocalStorage } = require('node:async_hooks');

/** @type {AsyncLocalStorage<{ chatId: string, tool: string }>} */
const target = new AsyncLocalStorage();

/**
 * @param {string} chatId
 * @param {string} tool
 * @template T
 * @param {() => T} run
 */
const onThisMac = (chatId, tool, run) => target.run({ chatId, tool }, run);

/** @param {string} chatId @param {string} [tool] */
function thisMacControl(chatId, tool) {
  const call = target.getStore();
  return call?.chatId === chatId && (tool === undefined || tool === call.tool);
}

module.exports = { onThisMac, thisMacControl };
