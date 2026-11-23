// Electron's main-process API for the ports (docs/architecture/modularization.md §3): looked up once, here at L1, and null in a process that is not Electron (the Host, a script), which the ports then replace with their installed implementation.
function loadElectron() {
  try {
    return require('electron');
  } catch {
    return null;
  }
}

/** @type {typeof import('electron') | null} */
const electron = loadElectron();

/**
 * Electron's API to destructure at load, or an empty object outside Electron: its members are then undefined, as when
 * such a process required 'electron' itself.
 */
const api = /** @type {typeof import('electron')} */ (electron ?? {});

module.exports = { electron, api };
