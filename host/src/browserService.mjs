// The Host's browser as the process builds it (package 2.6): the service on a Chromium found and started when a chat first opens a tab (never at startup), its profile and downloads under the data dir, and the wire requests served from it.
//
// Which browser: MOPILOT_HOST_CHROME, else a Chrome or Chromium on the machine, else the pinned chrome-headless-shell kept under the data
// dir. When none is there the first open starts that download in the background and answers `downloading` (a tab call must not wait
// minutes); the open after it finishes launches the browser. MOPILOT_HOST_BROWSER_DOWNLOAD=0 turns the download off.
import path from 'node:path';
import { createBrowserHost } from './browserHost.mjs';
import { createBrowserProtocol } from './browserProtocol.mjs';
import { ChromiumError, findChromium, launchChromium } from './chromium.mjs';
import { installHeadlessShell, installedShell, platformKey } from './headlessShell.mjs';

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {NodeJS.ProcessEnv} o.env
 * @param {ReturnType<typeof import('./epochs.mjs').createEpochStore>} o.epochs
 * @param {typeof findChromium} [o.find] @param {typeof launchChromium} [o.launch]
 * @param {typeof installedShell} [o.installed] @param {typeof installHeadlessShell} [o.install]
 * @param {NodeJS.Platform} [o.platform] @param {string} [o.arch]
 * @param {Parameters<typeof createBrowserProtocol>[0]['intents']} [o.intents]
 */
export function createHostBrowser({
  dataDir,
  env,
  epochs,
  find = findChromium,
  launch = launchChromium,
  installed = installedShell,
  install = installHeadlessShell,
  platform = process.platform,
  arch = process.arch,
  intents,
}) {
  const shellDir = path.join(dataDir, 'browser-bin');
  const canDownload = env.MOPILOT_HOST_BROWSER_DOWNLOAD !== '0' && platformKey(platform, arch) !== null;
  const locate = () => find({ env, platform }) ?? installed({ dir: shellDir, platform, arch });
  /** @type {Promise<void> | null} the download in flight */
  let installing = null;
  /** @type {Error | null} why the last download failed, told once to the next open */
  let failure = null;
  const startInstall = () => {
    installing = install({ dir: shellDir, platform, arch })
      .then(
        () => undefined,
        (e) => void (failure = e),
      )
      .finally(() => void (installing = null));
  };
  const service = createBrowserHost({
    downloadsDir: path.join(dataDir, 'downloads'),
    launch: async () => {
      const executable = locate();
      if (executable) return launch({ executable, userDataDir: path.join(dataDir, 'browser') });
      if (!canDownload)
        throw new ChromiumError(
          'no_chromium',
          'This host has no Chrome or Chromium to run a browser in. Install one, or set MOPILOT_HOST_CHROME to its path.',
        );
      if (failure) {
        const e = failure;
        failure = null;
        throw new ChromiumError('download_failed', `${e.message} Install Chrome or Chromium on this host, or try again.`);
      }
      if (!installing) startInstall();
      throw new ChromiumError('downloading', 'This host is downloading a headless browser (about 100 MB). Try again in a minute.');
    },
  });
  return {
    protocol: createBrowserProtocol({ browser: service, epochs, intents }),
    /** Whether this Host can run a browser for a chat: one is there, or it can be downloaded. */
    available: () => locate() !== null || canDownload,
    dispose: () => service.dispose(),
  };
}
