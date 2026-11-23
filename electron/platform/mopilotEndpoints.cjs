// Where this build reaches MoPilot's hosted service (electron/private/endpoints, omitted from the open-source export):
// without it every address is null and the build calls no MoPilot service.
const path = require('node:path');
const { optionalPrivate } = require('./optionalPrivate.cjs');
const { hasMoPilotService, FILE } = require('./mopilotPresence.cjs');

/**
 * Named as one path next to this file, so the Host's bundle (electron/host/bundle.cjs) takes it where it is there.
 * @type {null | { PRODUCTION: string, API_BASE: string, RELAY_URL: string, FLAGS_URL: string,
 *   updateFeedUrl: (platform: string, arch: string, version: string, query: URLSearchParams) => string,
 *   serviceFile: (userData: string, name: string, base?: string) => string }}
 */
const endpoints = optionalPrivate(path.join(__dirname, '../private/endpoints/index.cjs'));

/** The remote switches' endpoint; null keeps the built-in defaults (electron/platform/flags.cjs). */
const FLAGS_URL = endpoints?.FLAGS_URL ?? null;

module.exports = { endpoints, FLAGS_URL, hasMoPilotService, FILE };
