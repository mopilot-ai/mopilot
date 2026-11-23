// Expo config plugin: adds the iOS Notification Service Extension target with App Group, shared keychain group and the Sodium pod.
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require('@expo/config-plugins');
const files = require('./nseFiles');
const { addAppExtension, findTarget } = require('./xcodeExtension');
const { extensionManifest } = require('../config/privacy');

const SWIFT = 'NotificationService.swift';
// opened sealed titles are shared with the Live Activity widget: one source file, compiled into both targets
const SHARED = 'SealedTitle.swift';
const PRIVACY = 'PrivacyInfo.xcprivacy';

/** Add the extension target to an Xcode project and give it sources, resources, frameworks and signing settings. */
function addExtensionTarget(project, ids, appVersion, buildNumber) {
  return addAppExtension(project, {
    name: ids.extensionName,
    bundleId: ids.extensionBundleId,
    sources: [SWIFT, SHARED],
    resources: [PRIVACY],
    buildSettings: files.buildSettings(ids, appVersion, buildNumber),
  });
}

/** Append the extension's pod target once. */
function patchPodfile(text, ids) {
  return text.includes(`target '${ids.extensionName}'`) ? text : `${text.trimEnd()}\n${files.podfileBlock(ids)}`;
}

/** Write the extension's files under ios/<name>/. */
function writeExtensionFiles(iosRoot, ids, plist) {
  const dir = path.join(iosRoot, ids.extensionName);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, SWIFT), path.join(dir, SWIFT));
  fs.copyFileSync(path.join(__dirname, 'Shared', SHARED), path.join(dir, SHARED));
  fs.writeFileSync(path.join(dir, `${ids.extensionName}-Info.plist`), files.infoPlist(ids));
  fs.writeFileSync(path.join(dir, `${ids.extensionName}.entitlements`), plist.build(files.entitlementsPlist(ids)));
  fs.writeFileSync(path.join(dir, PRIVACY), plist.build(extensionManifest));
}

function withNotificationServiceExtension(config, ids) {
  config = withEntitlementsPlist(config, (c) => {
    c.modResults = files.mergeAppEntitlements(c.modResults, ids);
    return c;
  });
  config = withDangerousMod(config, [
    'ios',
    (c) => {
      const iosRoot = c.modRequest.platformProjectRoot;
      writeExtensionFiles(iosRoot, ids, require('@expo/plist').default);
      const podfile = path.join(iosRoot, 'Podfile');
      fs.writeFileSync(podfile, patchPodfile(fs.readFileSync(podfile, 'utf8'), ids));
      return c;
    },
  ]);
  return withXcodeProject(config, (c) => {
    c.modResults = addExtensionTarget(c.modResults, ids, c.version ?? '1.0.0', c.ios?.buildNumber);
    return c;
  });
}

module.exports = withNotificationServiceExtension;
module.exports.addExtensionTarget = addExtensionTarget;
module.exports.findTarget = findTarget;
module.exports.patchPodfile = patchPodfile;
module.exports.writeExtensionFiles = writeExtensionFiles;
