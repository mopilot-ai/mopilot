// The Host's desktop as the process builds it (G8, #3903): the CU helper client (helperClient.mjs), started the way a lease starts it, the probe that says whether this Host can serve a desktop (capabilities.desktop), and the wire requests served from them. The helper app is provisioned on the machine, not shipped in the Host tarball: `MOPILOT_HOST_HELPER` names it, else `<data dir>/helper/MoPilot Code.app`. Without one the Host reads `desktop: false`, which is a state to report, not a failure.
import path from 'node:path';
import { MAX_FRAME } from '../../shared/host/frames.mjs';
import { createDesktopHost } from './desktopHost.mjs';
import { createHelperClient } from './helperClient.mjs';
import { createDesktopProbe } from './desktopProbe.mjs';
import { createDesktopProtocol } from './desktopProtocol.mjs';

/** The most a reply may carry: the frame limit less the envelope (as the browser's). */
const MAX_REPLY = MAX_FRAME - 4096;

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {NodeJS.ProcessEnv} o.env
 * @param {ReturnType<typeof import('./epochs.mjs').createEpochStore>} o.epochs
 * @param {NodeJS.Platform} [o.platform]
 * @param {Parameters<typeof createDesktopProtocol>[0]['intents']} [o.intents]
 * @param {(opts: { appPath: string, platform: NodeJS.Platform }) => ReturnType<typeof createHelperClient>} [o.makeHelper] builds the helper client (helperClient.mjs); a test passes a fake
 */
export function createHostDesktop({
  dataDir,
  env,
  epochs,
  platform = process.platform,
  makeHelper = (opts) => createHelperClient(opts),
  intents,
}) {
  const appPath = env.MOPILOT_HOST_HELPER || path.join(dataDir, 'helper', 'MoPilot Code.app');
  const helper = makeHelper({ appPath, platform });
  const probe = createDesktopProbe({
    installed: () => helper.installed,
    call: (method, params, opts) => helper.call(method, params, opts),
  });
  const desktop = createDesktopHost({ helper, probe, epochOf: (chatId) => epochs.current(chatId), maxReply: MAX_REPLY });
  // a chat that moved to a new owner lets go of the desktop its old owner held
  const offEpochs = epochs.onAdvance((chatId, epoch) => void desktop.epochMoved(chatId, epoch));
  return {
    protocol: createDesktopProtocol({ desktop, epochs, intents }),
    /** Whether this Host can serve a desktop now: the last reading of the helper's grants, never a start or a wait. */
    available: () => probe.ok(),
    /** Starts the readings. */
    start: () => probe.start(),
    dispose: async () => {
      offEpochs();
      probe.stop();
      await desktop.dispose();
    },
  };
}
