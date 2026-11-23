// Expo config: app.json plus push identifiers, the notification extension and Live Activity widget, the privacy manifest and Android notification setup, all from the environment; MOPILOT_DEV_HOST points a development build at scripts/mobile-dev-host.mjs, and a store build (MOPILOT_BUILD_PROFILE=preview|production) carries none of the dev-only access.
const { resolveIdentifiers } = require('./config/identifiers');
const { devHostFromEnv } = require('./config/devHost');
const { resolveProfile } = require('./config/profile');
const { privacyManifests } = require('./config/privacy');
const { readVersion } = require('./config/version');
const { buildCommit } = require('./config/commit');
const edition = require('./config/edition.json');

/**
 * Permissions no module of the app may add: reading storage (the system pickers need none), audio routing and foreground services.
 * WRITE_EXTERNAL_STORAGE stays as expo-image-picker declares it (Android 12 and older): its camera needs it before Android 10.
 */
const BLOCKED_PERMISSIONS = [
  'android.permission.READ_EXTERNAL_STORAGE',
  // the Add to session strip reads the photo library on iOS only; Android keeps its permission-free system picker
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  'android.permission.ACCESS_MEDIA_LOCATION',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
];

/** @param {{ config: any }} o */
module.exports = ({ config }) => {
  const ids = resolveIdentifiers(process.env);
  const devHost = devHostFromEnv(process.env);
  const profile = resolveProfile(process.env, devHost !== null);
  const { version, buildNumber } = readVersion();
  return {
    ...config,
    name: edition.name,
    slug: edition.slug,
    scheme: edition.scheme,
    version,
    ios: {
      ...config.ios,
      bundleIdentifier: ids.iosBundleId,
      buildNumber: String(buildNumber),
      privacyManifests,
      // a "needs you" push is time-sensitive, so a Focus or a Scheduled Summary does not hold back what an agent waits on; a free Apple account cannot sign it, so a device build skips it
      entitlements: {
        ...config.ios?.entitlements,
        ...(!ids.deviceBuild && { 'com.apple.developer.usernotifications.time-sensitive': true }),
      },
      // a dev host speaks plain http/ws on the local network: allow exactly that (not arbitrary loads) and ask for the Local Network permission iOS needs
      ...(devHost && {
        infoPlist: {
          ...config.ios?.infoPlist,
          NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
          NSLocalNetworkUsageDescription: 'This development build connects to the Mobile Remote dev host on your network.',
        },
      }),
    },
    android: {
      ...config.android,
      package: ids.androidPackage,
      versionCode: buildNumber,
      permissions: ['POST_NOTIFICATIONS'],
      blockedPermissions: [...BLOCKED_PERMISSIONS, ...(profile.development ? [] : ['android.permission.SYSTEM_ALERT_WINDOW'])],
      ...(ids.googleServicesFile ? { googleServicesFile: ids.googleServicesFile } : {}),
    },
    // Without the keychain-group entitlement a device build must keep title keys app-private, or SecureStore fails with errSecMissingEntitlement.
    extra: {
      ...config.extra,
      push: { keychainAccessGroup: ids.deviceBuild ? undefined : ids.keychainAccessGroup },
      buildCommit: buildCommit(process.env, __dirname),
      // MOPILOT_HOST_CHAT=1 makes a build that reaches a machine's chat itself whatever the Mac says (the device check); otherwise the Mac's host.phoneChat flag decides
      ...((process.env.MOPILOT_HOST_CHAT ?? '').trim() === '1' && { hostChat: true }),
      // development builds only (resolveProfile refuses the dev signals in a store build): they carry the developer switches, a store build has none
      ...(profile.development && { development: true }),
      // A reply's prose is drawn as native text views iOS selects a range of in place (#4837); MOPILOT_INPLACE_SELECTION=0 turns it off for a build (the switch if a device check finds a problem)
      ...((process.env.MOPILOT_INPLACE_SELECTION ?? '').trim() !== '0' && { inPlaceSelection: true }),
      // MOPILOT_SELECTABLE_PROBE=1 makes a developer build that opens the selectable-text probe instead of the app (#4837 spike)
      ...((process.env.MOPILOT_SELECTABLE_PROBE ?? '').trim() === '1' && { selectableProbe: true }),
      ...(devHost && { devHost: devHost.origin, ...((process.env.MOPILOT_DEV_CLIENT ?? '').trim() === '1' && { devClient: true }) }),
    },
    plugins: [
      // registered first so its mod runs last, after every other plugin has added what it removes
      ['./plugins/withReleaseHardening', profile],
      ...(config.plugins ?? []),
      // A free Apple account cannot sign the push, App Group or keychain-group entitlements, so a device build skips the plugins that add them.
      ...(ids.deviceBuild
        ? []
        : [
            [
              'expo-notifications',
              // store builds are signed for Apple's production push service (TestFlight and ad hoc included); only development builds use the sandbox one
              { mode: profile.development ? 'development' : 'production', defaultChannel: 'system', icon: './assets/notification-icon.png', color: '#ef8b57' },
            ],
          ]),
      'expo-task-manager',
      // the widget shares the extension's App Group and keychain group, so a device build skips it too
      ...(ids.deviceBuild
        ? ['./plugins/withoutPushEntitlement']
        : [
            ['./plugins/withNotificationServiceExtension', ids],
            ['./plugins/withLiveActivity', ids],
          ]),
    ],
  };
};
