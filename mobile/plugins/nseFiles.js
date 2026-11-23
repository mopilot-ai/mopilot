// The files and settings of the iOS Notification Service Extension target, as pure functions of the resolved identifiers.
const DEPLOYMENT_TARGET = '15.1';

/** @param {{ extensionName: string }} ids */
const infoPlist = (ids) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key><string>${ids.extensionName}</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key><string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
  <key>MPKeychainService</key><string>mopilot-push</string>
  <key>MPAppGroup</key><string>${ids.appGroup}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
</dict>
</plist>
`;

/** Both groups are entitlements the extension and the app must share; the keychain group carries the team prefix at build time. */
const entitlementsPlist = (ids) => ({
  'com.apple.security.application-groups': [ids.appGroup],
  'keychain-access-groups': [`$(AppIdentifierPrefix)${ids.keychainGroup}`],
});

/** Merge the same two entitlements into the app's own, keeping what is there. */
function mergeAppEntitlements(existing, ids) {
  const add = (key, value) => {
    const old = Array.isArray(existing[key]) ? existing[key] : [];
    return old.includes(value) ? old : [...old, value];
  };
  const own = entitlementsPlist(ids);
  return {
    ...existing,
    'com.apple.security.application-groups': add('com.apple.security.application-groups', own['com.apple.security.application-groups'][0]),
    'keychain-access-groups': add('keychain-access-groups', own['keychain-access-groups'][0]),
  };
}

/**
 * Libsodium for the extension through the Sodium pod, a separate pod target: React Native itself is not linked into the extension.
 * CocoaPods refuses to embed an extension whose use_frameworks! differs from the host app's, so the block never sets a linkage
 * of its own: the app links pods as static libraries, and Swift pods then build as static libraries through use_modular_headers!.
 * The extension's link flags (buildSettings) name those static archives, so an app that switches to frameworks fails here with
 * a message instead of at the linker.
 */
const podfileBlock = (ids) => `
target '${ids.extensionName}' do
  if podfile_properties['ios.useFrameworks'] || ENV['USE_FRAMEWORKS']
    raise '${ids.extensionName} links Sodium as a static library and does not support use_frameworks!'
  end
  use_modular_headers!
  pod 'Sodium', '~> 0.9.1'
end
`;

/** Build settings that make the target an extension that embeds in the app and signs with the shared groups. */
function buildSettings(ids, appVersion, buildNumber = '1') {
  return {
    CODE_SIGN_ENTITLEMENTS: `"${ids.extensionName}/${ids.extensionName}.entitlements"`,
    CODE_SIGN_STYLE: 'Automatic',
    // App Store validation requires the extension's version and build to equal the app's
    CURRENT_PROJECT_VERSION: `"${buildNumber}"`,
    MARKETING_VERSION: `"${appVersion}"`,
    SWIFT_VERSION: '5.0',
    IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
    // iPhone only, like the app (ios.supportsTablet is false)
    TARGETED_DEVICE_FAMILY: '"1"',
    CLANG_ENABLE_MODULES: 'YES',
    // Both archives by path, not the pod's -l"Sodium" -l"sodium": on a case-insensitive volume both flags resolve to the Swift
    // wrapper libSodium.a, so its symbols are defined twice and the C library libsodium.a never links.
    OTHER_LDFLAGS: [
      '"-ObjC"',
      '"\\"${PODS_CONFIGURATION_BUILD_DIR}/Sodium/libSodium.a\\""',
      '"\\"${PODS_XCFRAMEWORKS_BUILD_DIR}/Sodium/libsodium.a\\""',
    ],
    ...(ids.appleTeamId ? { DEVELOPMENT_TEAM: ids.appleTeamId } : {}),
  };
}

module.exports = { DEPLOYMENT_TARGET, infoPlist, entitlementsPlist, mergeAppEntitlements, podfileBlock, buildSettings };
