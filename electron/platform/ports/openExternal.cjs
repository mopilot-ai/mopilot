// The openExternal port (docs/architecture/modularization.md §3): how this process hands a link to the person's browser. In the app
// it is Electron's shell, installed by main behind the scratch-Chrome guard (electron/main.cjs); the Host installs one that prints the
// link for the person at the Mac to open (host/src/electronPorts.mjs). Each use reads what is installed.
/** @typedef {(url: string, ...options: any[]) => Promise<void> | void} OpenExternal */

/** Nothing opens a link until a composition root says how: Electron's shell is only ever taken behind the scratch-Chrome guard (capabilities/browser/userChrome.cjs), which main installs. @type {OpenExternal} */
const noOpen = async () => {
  throw new Error('This process cannot open a link and none was installed.');
};

/** @type {OpenExternal} */
let installed = noOpen;

/**
 * Put `impl` behind the port (null puts back the one that refuses), and return the one it replaced.
 * @param {OpenExternal | null} impl
 */
function installOpenExternal(impl) {
  const previous = installed;
  installed = impl ?? noOpen;
  return previous;
}

/** Open a link through the port: `openExternal(url)`. @type {OpenExternal} */
const openExternal = (url, ...options) => installed(url, ...options);

module.exports = { openExternal, installOpenExternal };
