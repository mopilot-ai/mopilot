// Expo config plugin: adds the iOS Live Activity widget target (ActivityKit) with the shared App Group and keychain group, the Sodium pod, and NSSupportsLiveActivities on the app.
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withInfoPlist, withXcodeProject } = require('@expo/config-plugins');
const files = require('./liveActivityFiles');
const { addAppExtension, findTarget } = require('./xcodeExtension');
const { extensionManifest } = require('../config/privacy');

// the widget's own sources, then the one it shares with the notification extension (plugins/Shared)
const OWN = ['LiveActivity.swift', 'TitleKeyStore.swift'];
const SHARED = 'SealedTitle.swift';
// the activity's state and attributes belong to the app's Live Activity module, which starts the activity; the widget compiles the same files so both ends agree on the type
const FROM_MODULE = ['ActivityState.swift', 'ActivityAttributes.swift'];
const SOURCES = [...OWN, ...FROM_MODULE, SHARED];
const PRIVACY = 'PrivacyInfo.xcprivacy';

/** Add the widget target to an Xcode project: embedded in the app, signed with the shared groups. */
function addWidgetTarget(project, ids, appVersion, buildNumber) {
  return addAppExtension(project, {
    name: ids.widgetName,
    bundleId: ids.widgetBundleId,
    sources: SOURCES,
    resources: [PRIVACY],
    buildSettings: files.buildSettings(ids, appVersion, buildNumber),
  });
}

/** Append the widget's pod target once. */
function patchPodfile(text, ids) {
  return text.includes(`target '${ids.widgetName}'`) ? text : `${text.trimEnd()}\n${files.podfileBlock(ids)}`;
}

/** Write the widget's files under ios/<name>/. */
function writeWidgetFiles(iosRoot, ids, plist) {
  const dir = path.join(iosRoot, ids.widgetName);
  fs.mkdirSync(dir, { recursive: true });
  for (const source of OWN) fs.copyFileSync(path.join(__dirname, 'LiveActivity', source), path.join(dir, source));
  for (const source of FROM_MODULE) fs.copyFileSync(path.join(__dirname, '..', 'modules', 'mopilot-live-activity', 'ios', source), path.join(dir, source));
  fs.copyFileSync(path.join(__dirname, 'Shared', SHARED), path.join(dir, SHARED));
  fs.writeFileSync(path.join(dir, `${ids.widgetName}-Info.plist`), files.infoPlist(ids));
  fs.writeFileSync(path.join(dir, `${ids.widgetName}.entitlements`), plist.build(files.entitlementsPlist(ids)));
  fs.writeFileSync(path.join(dir, PRIVACY), plist.build(extensionManifest));
}

/** The app declares it can start Live Activities and names its App Group; the iOS permission itself is asked only when the person turns the switch on. */
function withLiveActivity(config, ids) {
  config = withInfoPlist(config, (c) => {
    c.modResults.NSSupportsLiveActivities = true;
    // the app writes the titles switch to this App Group, where the widget reads it
    c.modResults.MPAppGroup = ids.appGroup;
    return c;
  });
  config = withDangerousMod(config, [
    'ios',
    (c) => {
      const iosRoot = c.modRequest.platformProjectRoot;
      writeWidgetFiles(iosRoot, ids, require('@expo/plist').default);
      const podfile = path.join(iosRoot, 'Podfile');
      fs.writeFileSync(podfile, patchPodfile(fs.readFileSync(podfile, 'utf8'), ids));
      return c;
    },
  ]);
  return withXcodeProject(config, (c) => {
    c.modResults = addWidgetTarget(c.modResults, ids, c.version ?? '1.0.0', c.ios?.buildNumber);
    return c;
  });
}

module.exports = withLiveActivity;
module.exports.addWidgetTarget = addWidgetTarget;
module.exports.findTarget = findTarget;
module.exports.patchPodfile = patchPodfile;
module.exports.writeWidgetFiles = writeWidgetFiles;
module.exports.SOURCES = SOURCES;
