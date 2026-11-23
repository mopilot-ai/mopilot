// What paired phones' mirrors read from the app: the chat's folder, the Mac's terminal card, the local terminals, which tool is running for a chat, and the frame source for the surface it shows; plus the per-device switch that turns mirrors on.
const { browserFrame } = require('../remote/mirrorFrame.cjs');

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services (capabilities registry, controller, computerUse broker, browserTabs, pty, remote)
 * @param {(chatId: string) => Promise<string | null>} o.cwdOf the chat's folder (session/chatProject.cjs)
 */
function createMirrorWiring({ live, cwdOf }) {
  /** @type {any} */
  let frame = null;
  return {
    /** The service's ops.mirror (electron/remote/mirrorPty.cjs, mirrorFrames.cjs). */
    mirror: {
      folderOf: cwdOf,
      // the card the chat's own open_terminal_tab shows: "Allow … to open a terminal?"
      approveTerminal: async (/** @type {string} */ chatId, /** @type {{ cwd: string, signal: AbortSignal }} */ { cwd, signal }) => {
        const broker = live.computerUse?.broker;
        if (!broker) return false;
        const params = { harness: live.controller.ref(chatId).kind, cwd, tool: 'open_terminal_tab' };
        return (await broker.ask(chatId, 'terminalTab', params, { signal }))?.decision === 'allow';
      },
      // late-bound: updates.cjs sets live.pty after the panel is made
      pty: {
        spawn: (/** @type {string} */ key, /** @type {any} */ opts, /** @type {any} */ h) => live.pty.spawn(key, opts, h),
        write: (/** @type {string} */ key, /** @type {string} */ d) => live.pty.write(key, d),
        resize: (/** @type {string} */ key, /** @type {number} */ c, /** @type {number} */ r) => live.pty.resize(key, c, r),
        kill: (/** @type {string} */ key) => live.pty.kill(key),
        pause: (/** @type {string} */ key) => live.pty.pause(key),
        resume: (/** @type {string} */ key) => live.pty.resume(key),
      },
      tool: {
        running: (/** @type {string} */ chatId) => live.capabilities?.surfaceOf(chatId) ?? null,
        onChange: (/** @type {(chatId: string) => void} */ fn) => {
          if (!live.capabilities) return () => undefined;
          return live.capabilities.onCallChange(fn);
        },
      },
      frame: async (/** @type {string} */ chatId, /** @type {string} */ surface) => {
        // the granted apps' windows only, as the model's screenshots (tools/desktopCapture.cjs frame)
        if (surface === 'screen') return (await live.computerUse?.desktop?.frame(chatId)) ?? null;
        if (!live.browserTabs) return null;
        frame ??= browserFrame(live.browserTabs);
        return frame(chatId);
      },
    },
    /** The Mac's per-device switch (Settings → Mobile Remote): off until it is turned on for that phone. */
    policy: {
      mirrors: (/** @type {string} */ pairId) => live.remote?.devices?.byPair(pairId)?.mirrors === true,
    },
  };
}

module.exports = { createMirrorWiring };
