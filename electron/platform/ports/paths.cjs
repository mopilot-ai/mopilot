// The paths port (docs/architecture/modularization.md §3): where this process keeps its files. In the app that is Electron's
// userData folder; the Host process installs its own data dir (host/src/electronPorts.mjs), so a module above L1 can name a
// file in it without requiring Electron. Each use reads what is installed; Electron comes from ./electronApi.cjs, and a
// process without it simply has none.

const { electron } = require('./electronApi.cjs');

/** @typedef {{ userData: () => string }} Paths */

/** @type {Paths} */
const electronPaths = {
  userData: () => {
    if (!electron?.app) throw new Error('This process is not Electron and no paths were installed.');
    return electron.app.getPath('userData');
  },
};

/** @type {Paths} */
let installed = electronPaths;

/**
 * Put `impl` behind the port (null puts Electron's back), and return the one it replaced.
 * @param {Paths | null} impl
 */
function installPaths(impl) {
  const previous = installed;
  installed = impl ?? electronPaths;
  return previous;
}

/** The folders through the port: `paths.userData()`. */
const paths = /** @type {Paths} */ (new Proxy({}, { get: (_target, key) => Reflect.get(installed, key) }));

module.exports = { paths, installPaths };
