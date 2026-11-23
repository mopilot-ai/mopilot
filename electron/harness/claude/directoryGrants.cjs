// Live directory grants modify only the raw flag permission layer, leaving native-owned policy, file and session grants at their original sources.
const { mutateNativeSettings } = require('./nativeSettings.cjs');

const SOURCES = new Set(['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings']);
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** get_settings reports effective settings separately from raw sources; applied contains runtime model metadata, never permissions. */
function flagPermissions(settings) {
  const sources = settings?.sources;
  if (
    !Array.isArray(sources) ||
    !sources.every((entry) => record(entry) && SOURCES.has(entry.source) && record(entry.settings)) ||
    sources.filter((entry) => entry.source === 'flagSettings').length > 1
  )
    throw new Error('Claude did not report its permission settings sources; existing rules were left unchanged');
  const permissions = sources.find((entry) => entry.source === 'flagSettings')?.settings.permissions;
  if (permissions === undefined) return {};
  if (
    !record(permissions) ||
    !['allow', 'deny', 'ask'].every(
      (key) =>
        permissions[key] === undefined || (Array.isArray(permissions[key]) && permissions[key].every((rule) => typeof rule === 'string')),
    )
  )
    throw new Error('Claude did not report valid flag permission settings; existing rules were left unchanged');
  return permissions;
}

function addDirectories(session, directories, current) {
  return mutateNativeSettings(session, current, async () => {
    const settings = await session.q.getSettings();
    current();
    const permissions = flagPermissions(settings);
    const saved = permissions.additionalDirectories === undefined ? [] : permissions.additionalDirectories;
    if (!Array.isArray(saved) || !saved.every((directory) => typeof directory === 'string'))
      throw new Error('Claude did not report its directory scope; existing grants were left unchanged');
    await session.q.applyFlagSettings({
      permissions: { ...permissions, additionalDirectories: [...new Set([...saved, ...directories])] },
    });
    return true;
  });
}

module.exports = { addDirectories, flagPermissions };
