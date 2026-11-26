# Phone app permissions audit

What the store build of the phone app asks the operating system for, why, and what was removed. `tests/phoneReleaseConfig.test.ts` runs a real Expo prebuild for a store build and for a development build and asserts the iOS usage-description keys, the entitlements and the Android permissions declared by the generated project manifest below (the usage-description texts are asserted in `tests/phoneBranding.test.ts`); a new permission fails it until this page and the test agree. The merged manifest also carries normal permissions that libraries declare in their own manifests (listed below); reading them from the built bundle is a step of the release.

The sources are `mobile/app.json` (copy, module options), `mobile/app.config.js` (profile, blocked permissions), `mobile/plugins/withReleaseHardening.js` (what is removed from a store build) and `mobile/config/profile.js` (`MOPILOT_BUILD_PROFILE`).

## iOS (Info.plist and entitlements of a store build)

| Key | Text shown | Used by | Why it is there |
| --- | --- | --- | --- |
| `NSCameraUsageDescription` | Allow MoPilot to scan a pairing code and to take photos you attach to a chat. | `screens/Pairing.tsx` (QR scanner), `platform/media.ts` `camera()` | One camera string for both uses, so it names both. Asked at the first scan or the first photo. |
| `NSMicrophoneUsageDescription` | Allow MoPilot to record voice notes that your computer turns into text. | `platform/media.ts` `startRecording()` | Asked at the first dictation. The recording is sent to the paired computer sealed. |
| `NSPhotoLibraryUsageDescription` | Allow MoPilot to show your recent photos and attach the ones you choose to a chat. | `platform/media.ts` `recent()` and `photos()` (Add to session strip, `expo-media-library`) | Asked the first time the Add to session sheet opens, for read access only. The person can choose Limited access (the strip then shows the shared photos and a Select more link) or refuse (the sheet shows Camera and Photos only; the system picker behind Photos needs no permission). One string for `expo-media-library` and `expo-image-picker`, so the two plugins never disagree. `NSPhotoLibraryAddUsageDescription` is absent: the app never saves to the library. |
| notifications (runtime prompt, no plist key) | the app's own card first, then the system prompt | `push/permission.ts` | Only the card's "Turn on notifications" button asks; alert and sound, no badge. |
| `aps-environment` = `production` | | `expo-notifications` | Push for Apple's production service in preview and production builds (TestFlight and ad hoc included); `development` only in development builds. The relay's `APNS_SANDBOX` must match. |
| App Group and `keychain-access-groups` | | the notification extension | Share the push title keys between the app and `NotificationServiceExtension`; nothing else is shared. |

Absent from a store build, and checked absent: `NSLocalNetworkUsageDescription`, `NSBonjourServices`, `NSAppTransportSecurity` (so the default App Transport Security applies, no `NSAllowsLocalNetworking`, no `NSAllowsArbitraryLoads`), `NSFaceIDUsageDescription` (nothing uses biometrics: `faceIDPermission: false`), `UIBackgroundModes` (the `fetch` that `expo-task-manager` adds and the `audio` that `expo-audio` adds: the app records only while open and its alert pushes run no code), the dev client's `exp+mopilot-remote` URL scheme, location, contacts, tracking (`NSUserTrackingUsageDescription`), Bluetooth.

The URL schemes left are `mopilot` (the sign-in callback, used through `ASWebAuthenticationSession`, which registers the callback itself) and the bundle id (`ai.mopilot.phone` on iOS, `ai.mopilot.remote` on Android: Expo's default scheme; nothing opens it).

## Android (merged manifest sources of a store build)

| Permission | Used by | Why |
| --- | --- | --- |
| `CAMERA` | pairing scanner, photo capture | Runtime prompt at first use. |
| `RECORD_AUDIO` | voice notes | Runtime prompt at first dictation. |
| `POST_NOTIFICATIONS` | `platform/notifications.ts` | Runtime prompt on Android 13+ after the app's card. |
| `INTERNET` | relay, account | Required. |
| `VIBRATE` | Expo's base manifest | Notification channels vibrate. |
| `WRITE_EXTERNAL_STORAGE`, Android 12 and older only (`maxSdkVersion=32`) | `expo-image-picker`'s camera (`launchCameraAsync` requires it before Android 10) | Kept as the library declares it; never requested on Android 13 and newer. |

Normal permissions that libraries add in their own manifests and that only show in the merged manifest of a build: `RECEIVE_BOOT_COMPLETED` (`expo-notifications`, reschedules notifications after a reboot), `ACCESS_NETWORK_STATE`, `WAKE_LOCK` and `com.google.android.c2dm.permission.RECEIVE` (Firebase Cloud Messaging), and the `<queries>` entries for the camera and browser intents. None of them prompts.

Blocked on purpose (`android.blockedPermissions`, merged as `tools:node="remove"`, so no library can add them back): `READ_EXTERNAL_STORAGE` (the system photo picker needs none; `expo-image-picker` and `expo-file-system` declared it for Android 12 and older), `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO`, `READ_MEDIA_VISUAL_USER_SELECTED` and `ACCESS_MEDIA_LOCATION` (`expo-media-library` declares them; the recent-photos strip reads the library on iOS only, and Android keeps the permission-free system picker; its `requestLegacyExternalStorage` flag is removed too), `MODIFY_AUDIO_SETTINGS` (`expo-audio` declares it; recording does not use it), `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and `FOREGROUND_SERVICE_MICROPHONE` (no background playback or recording, so no Play foreground-service declaration), and, in a store build, `SYSTEM_ALERT_WINDOW` (the dev client's overlay).

Other manifest facts: `allowBackup` is `false` (the vault key lives in the Android keystore and does not travel with a backup, so a restored database could never be opened); cleartext traffic is off (only the debug manifest sets it); the dev client's `exp+` scheme is removed from the launch activity.

## Development builds

A development build (`MOPILOT_BUILD_PROFILE=development`, or any of `MOPILOT_DEV_HOST`, `MOPILOT_DEV_CLIENT=1`, `MOPILOT_DEVICE_BUILD=1`) keeps the dev client's discovery, `NSAllowsLocalNetworking` (not `NSAllowsArbitraryLoads`) plus a Local Network string when a dev host is set, the `exp+` scheme and `SYSTEM_ALERT_WINDOW`. A preview or production profile that is also given one of those variables fails the build instead of shipping them.

## Changes this audit made

- The Add to session sheet reads recent photos on iOS (`expo-media-library`, `NSPhotoLibraryUsageDescription` reworded); Android is unchanged and blocks the media-read permissions that library adds.
- `platform/media.ts` `library()` no longer calls `requestMediaLibraryPermissionsAsync` before the photo picker: the picker needs none on iOS 14+ or Android, and the call asked Android 12 and older for storage access and iOS for the whole library.
- The same picker now takes several photos and videos at once (`library(room)`). It still needs no permission: videos come through the system picker like photos, so `READ_MEDIA_VIDEO` stays blocked and no string is added. A video that fits 20 MB (the Mac's file limit) is read as it is; a larger one is made smaller by the app's own export (`mobile/modules/mopilot-video`, an `AVAssetExportSession` on the picked file in the app's own temporary folder, which uses no permission and sends nothing anywhere), and refused with a message when even the smallest size cannot hold it; the strip and the camera tile stay photo-only.
- `expo-audio` background playback off (removes the `audio` background mode, two foreground-service permissions and a media service), `expo-camera` no longer adds `RECORD_AUDIO` for video, `expo-secure-store` no longer adds the Face ID string.
- `UIBackgroundModes` `fetch` removed, store builds lose every dev-client leftover, `allowBackup` off.

## Not verifiable here

The prompts and the picker on a real iOS or Android device (the picker change in particular: attach a photo on Android 9, 12 and 14 and on iOS with a limited-library choice, and take a photo on Android 9, where the camera also asks for storage) and Play's pre-launch report. Both are on the release checklist.
