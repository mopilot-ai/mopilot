// Whether this build has the MoPilot service (electron/private/endpoints, omitted from the open-source export), told
// without loading it: the preload asks for the windows, and loads nothing of the service to answer.
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'private', 'endpoints', 'index.cjs');

/** @param {(file: string) => string} [resolve] */
function hasMoPilotService(resolve = require.resolve) {
  try {
    resolve(FILE);
    return true;
  } catch {
    // not in this build: the open-source edition
    return false;
  }
}

module.exports = { hasMoPilotService, FILE };
