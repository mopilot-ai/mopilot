// What the app declares to Apple about privacy: the required-reason APIs its native code links and the data the service collects (docs/mobile-remote/privacy.md has the reasoning).

/**
 * Required-reason API declarations for the app bundle. Statically linked pods' own manifests are not read for the app binary, so this is
 * the union of what the linked pods declare plus what packages without a manifest do (expo-audio reads recording attributes, expo-sqlite's
 * bundled SQLite stats files and the file system); tests/phonePrivacy.invariant.test.ts recomputes it from node_modules and fails when it falls short.
 */
const accessedApis = [
  // C617.1: files inside the app container; 0A2A.1: the file-system module reading what its own caller wrote; 3B52.1: files the person picked
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'] },
  // E174.1: check free space before writing a file; 85F4.1: show it to the person (expo-file-system declares both)
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'] },
  // CA92.1: the app's own settings (React Native, expo-constants, expo-notifications, expo-task-manager); 1C8F.1: the App Group's defaults, where the Live Activity module writes the titles switch the widget reads
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1', '1C8F.1'] },
  // 35F9.1: measure time elapsed inside the app (React Native's timing)
  { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
];

/**
 * Data the service collects through the app, all linked to the account and only for the app's own function, none used for tracking.
 * Chat text, files, photos, voice notes and push titles reach the relay only sealed with keys it never holds, so they are not collected.
 * The account's email, name and avatar address come from the Google or GitHub sign-in; the token exchange hands the phone the id, email,
 * name and image address (web/app/api/desktop/token/route.ts), and Settings shows the name (or the email without one). The avatar address is a link to
 * the provider's picture, not an upload, and the app does not show it.
 */
const collectedData = [
  'NSPrivacyCollectedDataTypeEmailAddress',
  'NSPrivacyCollectedDataTypeName',
  'NSPrivacyCollectedDataTypeUserID',
  'NSPrivacyCollectedDataTypeDeviceID',
].map(
  (type) => ({
    NSPrivacyCollectedDataType: type,
    NSPrivacyCollectedDataTypeLinked: true,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
  }),
);

/** The Notification Service Extension reads its App Group's settings, which reason 1C8F.1 covers; it links no other required-reason API. */
const extensionManifest = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyAccessedAPITypes: [
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['1C8F.1'] },
  ],
};

const privacyManifests = { NSPrivacyTracking: false, NSPrivacyAccessedAPITypes: accessedApis, NSPrivacyCollectedDataTypes: collectedData };

module.exports = { accessedApis, collectedData, extensionManifest, privacyManifests };
