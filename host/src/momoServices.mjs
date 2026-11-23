// Finds the services other lanes plug into MoMo's home, one file per service in `host/src/momoServices/` (found by folder, so no shared list is edited): a file default-exports a function of `{ home, sessions, epochs, env, paths, report }` that registers itself with `home.use(id, { start, pause, wipe })` and may offer an API to its wire methods with `home.provide(id, api)` (host/src/methods/<feature>.mjs reads it with `momo.service(id)`). A file that cannot be loaded is reported and the others still load.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeFilesIn, defaultOf } from '../../shared/host/methodFiles.mjs';

const req = createRequire(import.meta.url);
const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'momoServices');
/** The Host's own folder is loaded by a template the packager reads, so every file in it is in the Host's bundle. @param {string} name */
const own = (name) => req(`./momoServices/${name}`);

/**
 * @param {object} o
 * @param {string} [o.dir] the folder to read (the Host's own by default; tests pass another)
 * @param {Record<string, unknown>} o.deps what a service is given, `home` among it
 * @param {(message: string) => void} o.report
 * @returns {string[]} the files that loaded
 */
export function loadMomoServices({ dir = HERE, deps, report }) {
  /** @type {string[]} */
  const loaded = [];
  for (const name of codeFilesIn(dir)) {
    try {
      defaultOf(dir === HERE ? own(name) : req(path.join(dir, name)))(deps);
      loaded.push(name);
    } catch (error) {
      report(`MoMo service ${name} could not be loaded: ${/** @type {Error} */ (error).message}`);
    }
  }
  return loaded;
}
