// IPC for the coding-side MCP servers' rows in Settings › MoMo › Sources (#2999 C0, src/components/momo/McpServerCard.tsx): every server coding chats configure, allowed or not, with its tools and each one's state; Allow (starts it and records the tools it lists now), Remove, and one tool on or off. Every change goes to the windows as momoMcp:changed (no data in it). Every handler but Remove refuses while MoMo is not allowed. Registered by the sources IPC (sources/ipc.cjs).
const { messageOf } = require('../../ignored.cjs');
const { SealedUnavailableError } = require('../../gateway/sealedFile.cjs');
const { ToolError } = require('../../capabilities/contract/registry.cjs');

const CHANNELS = Object.freeze(['momoMcp:list', 'momoMcp:allow', 'momoMcp:remove', 'momoMcp:setTool']);
const NOT_ALLOWED = Object.freeze({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });

/**
 * Registers the handlers; returns a function that removes them again.
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ proxy: InstanceType<typeof import('./proxy.cjs').McpProxy>, allowed: () => boolean, broadcast?: ((channel: string) => void) | null }} o
 */
function registerMcpIpc(ipcMain, { proxy, allowed, broadcast = null }) {
  const changed = () => {
    if (allowed() === true) broadcast?.('momoMcp:changed');
  };
  proxy.on('changed', changed);
  const on = (/** @type {string} */ channel, /** @type {(...args: any[]) => any} */ fn) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      if (allowed() !== true) return NOT_ALLOWED;
      try {
        return { ok: true, ...(await fn(...args)) };
      } catch (error) {
        return { ok: false, error: messageOf(error), ...(error instanceof ToolError && { reason: error.code }) };
      }
    });
  // no OS key: nothing can be allowed, so nothing is listed and the row says why
  on('momoMcp:list', async () => {
    try {
      return { servers: await proxy.list(), available: true };
    } catch (error) {
      if (!(error instanceof SealedUnavailableError)) throw error;
      return { servers: [], available: false };
    }
  });
  on('momoMcp:allow', async (key) => (await proxy.allow(key), {}));
  // an account whose invite was revoked can still take a server back out
  on('momoMcp:remove', async (key) => (await proxy.remove(key), {}));
  on('momoMcp:setTool', async (key, tool, value) => (await proxy.setTool(key, tool, value), {}));
  return () => {
    proxy.off('changed', changed);
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerMcpIpc, CHANNELS, NOT_ALLOWED };
