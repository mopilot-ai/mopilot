// MoPilot's own plugin, mopilot@mopilot (electron/plugins/builtin/mopilot): skills written for MoPilot's tools
// (browser, computer, Chrome) and the ones Claude Desktop ships that no public source provides (PDF reading,
// frontend design, memory cleanup, usage). It is seeded into the plugin store as an ordinary plugin
// (PluginStore.seedBundled), so every harness gets it through the same delivery as a user's plugins and the Plugins
// page can turn it off. A user who uninstalls it keeps it uninstalled.
const path = require('node:path');

const MARKETPLACE = 'mopilot';
const NAME = 'mopilot';
const BUILTIN_ID = `${NAME}@${MARKETPLACE}`;
/** Where the plugin folder ships. */
const BUILTIN_SOURCE = path.join(__dirname, 'builtin', NAME);

/**
 * Put the built-in plugin in the store, or bring it up to date.
 * @param {InstanceType<typeof import('./store.cjs').PluginStore>} store
 * @param {{ source?: string }} [o]
 */
const seedBuiltin = (store, { source = BUILTIN_SOURCE } = {}) => store.seedBundled(source, { name: NAME, marketplace: MARKETPLACE });

module.exports = { seedBuiltin, BUILTIN_ID, BUILTIN_SOURCE };
