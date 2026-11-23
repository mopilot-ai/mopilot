// The injected ports a Host runs with in place of Electron's: secrets, paths, openExternal and an image decoder.
import { createPaths } from './paths.mjs';
import { createFileSecretStore } from './secretStore.mjs';

/** There is no desktop to open a browser on: print the URL so the person at the Mac (or the ssh session) opens it. @param {(line: string) => void} print */
export function createOpenExternal(print) {
  return async (/** @type {string} */ url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
    print(`Open this link in a browser: ${url}`);
  };
}

/** No decoder is bundled yet (sharp vs a pure-JS PNG decoder is decided with the first image-reading harness path); callers get a clear failure, never a blank image. */
export function createImageDecoder() {
  return {
    decode: async (/** @type {Uint8Array} */ _bytes) => {
      throw Object.assign(new Error('This Host has no image decoder.'), { code: 'unavailable' });
    },
  };
}

/** @param {{ dataDir?: string, env?: NodeJS.ProcessEnv, print?: (line: string) => void }} [o] */
export function createPorts({ dataDir, env = process.env, print = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const paths = createPaths({ dataDir, env });
  return {
    paths,
    secrets: createFileSecretStore(paths.configDir),
    openExternal: createOpenExternal(print),
    imageDecoder: createImageDecoder(),
  };
}
