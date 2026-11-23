// The computer-use helper as the capability health record reads it (capabilityHealth.cjs): where it is, whether it runs, its version, why it last failed and the macOS permissions it last reported. Never launches it.
/**
 * @param {{ appPath: string, installed: boolean, platform: string, running: boolean, info?: { version?: string } | null, lastError: string | null, permissions: Record<string, boolean> | null }} helper
 * @param {boolean} packaged
 */
const helperFactsOf = (helper, packaged) => ({
  path: helper.appPath,
  installed: helper.installed,
  packaged: !!packaged,
  platform: helper.platform,
  running: helper.running,
  version: helper.info?.version ?? null,
  error: helper.lastError,
  permissions: helper.permissions,
});

const { computerHealth } = require('./capabilityHealth.cjs');

/** The capability health record's verdict on computer use, from the helper as it is now. @param {Parameters<typeof helperFactsOf>[0]} helper @param {boolean} packaged @param {boolean} enabled */
const healthOf = (helper, packaged, enabled) => {
  const { permissions, ...facts } = helperFactsOf(helper, packaged);
  return computerHealth({ enabled, helper: facts, permissions });
};

module.exports = { helperFactsOf, healthOf };
