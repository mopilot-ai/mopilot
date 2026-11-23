// Installs this Host's implementations behind the ports the shared electron/ modules read (electron/platform/ports), so they run here without Electron.
import { createRequire } from 'node:module';
import { createFileSafeStorage } from './secretStore.mjs';

const require = createRequire(import.meta.url);
const { installPaths } = require('../../electron/platform/ports/paths.cjs');
const { installSecrets } = require('../../electron/platform/ports/secrets.cjs');
const { installOpenExternal } = require('../../electron/platform/ports/openExternal.cjs');

/**
 * @param {{ paths: { dataDir: string, configDir: string }, openExternal: (url: string) => Promise<void> }} ports what createPorts built
 * @returns {() => void} puts back what was installed before
 */
export function installElectronPorts({ paths, openExternal }) {
  const safe = createFileSafeStorage(paths.configDir);
  const previousPaths = installPaths({ userData: () => paths.dataDir });
  const previousSecrets = installSecrets(() => safe);
  const previousOpen = installOpenExternal((url) => openExternal(url));
  return () => {
    installPaths(previousPaths);
    installSecrets(previousSecrets);
    installOpenExternal(previousOpen);
  };
}
