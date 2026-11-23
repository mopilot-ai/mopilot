// Expo config plugin: removes what Expo's default plugins and the dev client add that a store build must not carry (local-network access, dev URL schemes, unused background modes), and turns off iOS's automatic limited-photo-access alert.
const { withAndroidManifest, withInfoPlist } = require('@expo/config-plugins');

const isDevScheme = (/** @type {unknown} */ scheme) => typeof scheme === 'string' && scheme.startsWith('exp+');

/** Background modes the app never uses: it records only while open, and its pushes are alerts that need no background run. */
function dropBackgroundModes(plist) {
  const modes = (Array.isArray(plist.UIBackgroundModes) ? plist.UIBackgroundModes : []).filter((m) => m !== 'fetch' && m !== 'audio');
  if (modes.length) plist.UIBackgroundModes = modes;
  else delete plist.UIBackgroundModes;
  return plist;
}

/** The strip of recent photos has its own "Select more photos" control, so iOS does not also ask about limited access (with a "Would Like to Access Your Photos" alert) each time the strip reads the library. */
function quietLimitedPhotoAlert(plist) {
  plist.PHPhotoLibraryPreventAutomaticLimitedAccessAlert = true;
  return plist;
}

/** The dev client's Bonjour discovery, its Local Network string, the ATS exception for local networking and its `exp+<slug>` URL scheme. */
function dropDevAccess(plist) {
  delete plist.NSLocalNetworkUsageDescription;
  delete plist.NSBonjourServices;
  if (plist.NSAppTransportSecurity) {
    delete plist.NSAppTransportSecurity.NSAllowsLocalNetworking;
    delete plist.NSAppTransportSecurity.NSAllowsArbitraryLoads;
    if (!Object.keys(plist.NSAppTransportSecurity).length) delete plist.NSAppTransportSecurity;
  }
  if (Array.isArray(plist.CFBundleURLTypes)) {
    plist.CFBundleURLTypes = plist.CFBundleURLTypes.map((type) => ({
      ...type,
      CFBundleURLSchemes: (type.CFBundleURLSchemes ?? []).filter((scheme) => !isDevScheme(scheme)),
    })).filter((type) => type.CFBundleURLSchemes.length);
  }
  return plist;
}

/** Drop the dev client's `exp+<slug>` scheme from the main activity's VIEW filter. */
function dropAndroidDevScheme(manifest) {
  for (const activity of manifest.manifest.application?.[0]?.activity ?? []) {
    const filters = activity['intent-filter'] ?? [];
    for (const filter of filters) if (filter.data) filter.data = filter.data.filter((d) => !isDevScheme(d.$?.['android:scheme']));
    // a link filter whose only schemes were the dev client's is dropped whole, not left matching every link
    if (activity['intent-filter']) activity['intent-filter'] = filters.filter((f) => !f.data || f.data.length);
  }
  return manifest;
}

/** expo-media-library asks for legacy storage access, which the system pickers and the iOS-only photo strip never need. */
function dropLegacyStorage(manifest) {
  const app = manifest.manifest.application?.[0];
  if (app?.$) delete app.$['android:requestLegacyExternalStorage'];
  return manifest;
}

/**
 * @param {import('@expo/config-plugins').ExportedConfig} config
 * @param {{ development: boolean }} profile a development build keeps the dev client's access
 */
function withReleaseHardening(config, profile) {
  config = withInfoPlist(config, (c) => {
    c.modResults = quietLimitedPhotoAlert(dropBackgroundModes(c.modResults));
    if (!profile.development) c.modResults = dropDevAccess(c.modResults);
    return c;
  });
  if (profile.development) return config;
  return withAndroidManifest(config, (c) => {
    c.modResults = dropLegacyStorage(dropAndroidDevScheme(c.modResults));
    return c;
  });
}

module.exports = withReleaseHardening;
module.exports.dropBackgroundModes = dropBackgroundModes;
module.exports.quietLimitedPhotoAlert = quietLimitedPhotoAlert;
module.exports.dropDevAccess = dropDevAccess;
module.exports.dropAndroidDevScheme = dropAndroidDevScheme;
module.exports.dropLegacyStorage = dropLegacyStorage;
