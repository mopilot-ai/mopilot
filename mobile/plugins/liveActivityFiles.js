// The files and settings of the iOS Live Activity widget target, as pure functions of the resolved identifiers; it shares the extension's groups, Sodium pod and signing settings.
const nse = require('./nseFiles');

// ActivityKit content updates need 16.2
const DEPLOYMENT_TARGET = '16.2';

/** The widget target viewed as an extension target, so it reuses the notification extension's podfile block, entitlements and build settings. */
const asTarget = (ids) => ({ ...ids, extensionName: ids.widgetName, extensionBundleId: ids.widgetBundleId });

/** @param {{ widgetName: string, appGroup: string }} ids */
const infoPlist = (ids) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key><string>MoPilot</string>
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
    <key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
`;

/** Same two groups as the notification extension: the keychain group holds the title keys, the App Group the titles switch. */
const entitlementsPlist = (ids) => nse.entitlementsPlist(ids);

/** The Podfile block of the widget target: the same static Sodium as the notification extension, under the widget's name. */
const podfileBlock = (ids) => nse.podfileBlock(asTarget(ids));

/** Build settings of the widget target: the extension's, under the widget's name and with its own deployment target. */
function buildSettings(ids, appVersion, buildNumber) {
  return {
    ...nse.buildSettings(asTarget(ids), appVersion, buildNumber),
    IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
  };
}

module.exports = { DEPLOYMENT_TARGET, asTarget, infoPlist, entitlementsPlist, podfileBlock, buildSettings };
