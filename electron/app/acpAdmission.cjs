// Basic-harness admission in the app: its cache file, its broadcasts to windows, a check again on window focus for a
// harness that reads signed out, and the tool channel that stands in when sage-mcp is missing.
const path = require('node:path');
const { Admission } = require('../harness/admission.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { RegistryHarnesses } = require('../harness/registry/service.cjs');
const { ACP_CATALOG, ACP_PUBLIC_IDS } = require('../../shared/harnessCatalog.mjs');
const { DEFAULTS } = require('../platform/flags.cjs');

/** The tool channel a basic harness gets without sage-mcp: it refuses, so the harness is not admitted. */
const NO_SAGE_MCP = {
  prepare: () => Promise.reject(new Error("MoPilot can't connect this harness to its tools: its tool bridge (sage-mcp) is missing")),
  admission: () => Promise.resolve(false),
  end: () => {
    /* nothing to end without sage-mcp */
  },
};

/**
 * @param {object} o
 * @param o.common what Admission and AcpHost share (quirks, ids, resolveBin, env, tools, dataDir)
 * @param o.app Electron's app (userData, window focus)
 * @param o.killed (id) => why the harness is switched off, or null
 * @param o.broadcastAll (channel, payload) => void
 */
function openAdmission({ common, app, killed, broadcastAll }) {
  const { resolveBin, discoverBin } = common;
  const registry = new RegistryHarnesses({
    dir: path.join(app.getPath('userData'), 'registry-agents'),
    which: (name) => require('../platform/env.cjs').which(name),
    onInstalled: async (id) => {
      if (!common.ids.includes(id)) common.ids.push(id);
      broadcastAll(
        'flags:changed',
        Object.fromEntries(
          [...Object.keys(DEFAULTS), ...ACP_PUBLIC_IDS.map((key) => `harness.acp.${key}.enabled`)].map((key) => [
            key,
            require('../platform/flags.cjs').isEnabled(key),
          ]),
        ),
      );
      return admission.refresh({ force: true, only: id });
    },
  });
  for (const id of registry.installed.keys()) if (!common.ids.includes(id)) common.ids.push(id);
  common.resolveBin = (id) => (ACP_CATALOG[id]?.registry ? registry.resolve(id) : resolveBin(id));
  if (discoverBin) common.discoverBin = (id) => (ACP_CATALOG[id]?.registry ? undefined : discoverBin(id));
  const admission = new Admission({ ...common, file: path.join(app.getPath('userData'), 'acp-admission.json'), killed });
  admission.registry = registry;
  app.on('will-quit', () => registry.dispose());
  admission.onChange((list) => broadcastAll('acp:harnesses', list));
  // a sign-in made in the user's own terminal is seen when they come back, without pressing Re-check
  app.on('browser-window-focus', () =>
    admission.recheckSignedOut().catch((error) => noteIgnored('check the signed-out harnesses again', error)),
  );
  return admission;
}

module.exports = { openAdmission, NO_SAGE_MCP };
