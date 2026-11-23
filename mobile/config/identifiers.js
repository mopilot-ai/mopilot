// Every platform identifier the push work needs, read from the environment so no real Apple or Google value lives in source.
const edition = require('./edition.json');

/**
 * The registered ids are the defaults; the Apple team stays out of source and comes from the environment.
 * Set MOPILOT_IOS_BUNDLE_ID, MOPILOT_ANDROID_PACKAGE, MOPILOT_APPLE_TEAM_ID, MOPILOT_APP_GROUP, MOPILOT_KEYCHAIN_GROUP and
 * MOPILOT_GOOGLE_SERVICES_FILE for a signed or push-capable build; MOPILOT_DEVICE_BUILD=1 drops the push entitlements and the extension for a free-account device build (mobile/README.md#push-configuration).
 * @param {Record<string, string | undefined>} env
 */
function resolveIdentifiers(env) {
  const pick = (name, fallback) => (env[name] && env[name].trim()) || fallback;
  const iosBundleId = pick('MOPILOT_IOS_BUNDLE_ID', edition.iosId);
  const appleTeamId = pick('MOPILOT_APPLE_TEAM_ID', '');
  const keychainGroup = pick('MOPILOT_KEYCHAIN_GROUP', `${iosBundleId}.shared`);
  return {
    iosBundleId,
    androidPackage: pick('MOPILOT_ANDROID_PACKAGE', edition.androidId),
    appleTeamId,
    appGroup: pick('MOPILOT_APP_GROUP', `group.${iosBundleId}`),
    keychainGroup,
    // SecureStore needs the full group, which starts with the team id; without a team the items stay app-private.
    keychainAccessGroup: appleTeamId ? `${appleTeamId}.${keychainGroup}` : undefined,
    extensionName: 'NotificationServiceExtension',
    extensionBundleId: `${iosBundleId}.notification-service`,
    widgetName: 'LiveActivityExtension',
    widgetBundleId: `${iosBundleId}.live-activity`,
    googleServicesFile: pick('MOPILOT_GOOGLE_SERVICES_FILE', undefined),
    deviceBuild: pick('MOPILOT_DEVICE_BUILD', '') === '1',
  };
}

module.exports = { resolveIdentifiers };
