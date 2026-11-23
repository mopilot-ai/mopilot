# MoPilot for phone

MoPilot on your phone is a remote for the chats, approvals and files that run on your own computer. Nothing runs on the phone, and the relay between the two carries only encrypted messages it cannot read.

The source edition includes the mobile client and a local development host. Its MoPilot account provider is
disabled. To pair with an independently deployed relay, integrate your account service in both clients.
Use your own signing credentials and application identifiers when distributing a mobile build.

## Using the app

1. On your computer, open MoPilot › Settings › Mobile Remote and turn it on. The same MoPilot account must be signed in on both.
2. On the phone, sign in and tap **Pair a computer**. Scan the code the computer shows (or paste it).
3. Both screens now show a safety number, for example `1234 5678 9012 3456 7890` (twenty digits, the same on both). If they match, approve on the computer. If they differ, cancel on the phone and pair again: someone else may be pairing.
4. Open a chat to follow it live, send a message, press **Stop**, or answer an approval card. **New chat** starts one in any project, with the model, effort and permission pickers the computer offers. **Changes** reads the chat's diff and files; **Terminal** mirrors the computer's terminal once the computer turned mirrors on for this phone.
5. **Settings** holds the account, each paired computer (connect, **Remove computer**), notifications and About. Removing a computer deletes its keys on the phone and asks the computer to forget the phone; the computer can also remove the phone from its own Settings.

The phone cannot choose Full access (bypass permissions), change the computer's Settings or pair other devices. When the computer is asleep or offline the app says so and keeps what you typed.

This independent Expo application controls chats on a paired Mac. Agents, files, approvals and execution remain on the Mac. The desktop's `remote.enabled` feature flag and the account's local phone-access consent must both be enabled.

The initial client supports account sign-in, QR or pasted-code pairing, a safety-number check confirmed on the Mac, paired computers, recent chats, saved history with provisional live output, messages, Stop, approval choices and questions. It uses the same main-process service for Codex, Claude Code and admitted ACP chats.

## Development

Install the root dependencies and this package's locked dependencies separately:

```sh
npm ci
npm ci --prefix mobile
npm run typecheck --prefix mobile
npm run export:ios --prefix mobile
npm run export:android --prefix mobile
```

Native sodium, SQLite and SecureStore require a native development client or a native build; Expo Go does not provide this application. The preview under `mobile/preview/` injects a test runtime and is separate from the production entry. Production starts at `index.js`, registers `App.tsx`, and constructs the real runtime.

The account origin is `https://mopilot.ai`, the callback is `mopilot://auth/callback`, and the trusted relay endpoint is `wss://relay.mopilot.ai/v1/ws`. Pairing rejects a QR that names another relay. Shipping these endpoints, provisioning signing identities and configuring push services are separate operational work. The package identifiers in `app.json` must be provisioned before a signed distribution build.

## Dev host: a real phone without the Mac app

`node scripts/mobile-dev-host.mjs` stands in for the Mac without launching MoPilot. It runs the real relay, the real Mac-side remote service (sealed channel, pairing, review, terminal mirror) and a small fake app underneath: five seeded chats (two of them linked sessions one chat started), a new chat that runs a scripted turn (streamed reply, a `git status` the phone must approve, a result), and a git repository for diffs and file reads. MoMo is off. It prints a pairing QR and a pasteable code, logs every request and event on one line each, and stops cleanly on Ctrl-C. State lives in `~/.mopilot-mobile-dev-host` (`--dir` changes it), so a restart keeps the pairing; keep `--port` (default 8787) unchanged for the same reason, because the phone trusts one relay address.

Build the phone with the host's address; nothing else changes for a production build:

```sh
MOPILOT_DEV_HOST=http://192.0.2.10:8787 npx expo run:ios --device   # the host prints its own address
# a free Apple account (see the device build below): prebuild with both, then build the Debug configuration
MOPILOT_DEVICE_BUILD=1 MOPILOT_APPLE_TEAM_ID=<team> MOPILOT_DEV_HOST=http://192.0.2.10:8787 npx expo prebuild --platform ios --no-install
```

Where the address comes from depends on the build. A Debug build with the development client reads `extra` from the Metro server, so start `expo start` with `MOPILOT_DEV_HOST` too (the embedded config is not used). A build without Metro (Release, standalone) bakes it in: prebuild and the Xcode build both evaluate `app.config.js`, so export `MOPILOT_DEV_HOST` and `MOPILOT_DEV_CLIENT=1` in the shell that runs `xcodebuild`, and check `<App>.app/EXConstants.bundle/app.config` (`extra` must contain `devHost` and `devClient`). Either way run prebuild again when the Mac's address changes. A build that did not get the address signs in at mopilot.ai and shows that site's "Invalid sign-in link"; a dev build logs `[mobile] dev endpoints: …` (or `a dev host is configured but ignored`) at start.

`MOPILOT_DEV_HOST` must be a plain `http://` origin on a private IP, `localhost` or a `.local` name; anything else fails the build. It points the relay, the pairing check and the sign-in at the host, and only in a development build (`__DEV__`, the default for `expo run:ios`): a release configuration ignores it and keeps `wss://relay.mopilot.ai`, unless the build also sets `MOPILOT_DEV_CLIENT=1`. A QR can never switch a build to a plain relay; only the host the build was made with is trusted. The host also answers the sign-in (`/desktop/authorize`, `/api/desktop/token`) and approves every one, so run it only on a network you trust; it listens on all interfaces unless `--loopback` is given. Pairing still asks for the safety number: the host logs it, and `--ask` makes you confirm it in the terminal.

Pairing without typing: a build with a dev host also pairs from a link, `mopilot://pair?code=<the pairing code, URL-encoded>` (`mobile/src/devPairLink.ts`; the host writes the current code to `<dir>/pairing-code.txt`). On an Android emulator: `adb shell am start -a android.intent.action.VIEW -d "mopilot://pair?code=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(open(sys.argv[1]).read().strip(),safe=""))' <dir>/pairing-code.txt)" ai.mopilot.phone`; on an iOS simulator `xcrun simctl openurl booted <the same link>`. It pairs as the form does (the Mac still approves it after the safety numbers are compared; the dev host approves by itself). A link that arrives before the account is read waits for it, one pairing runs at a time, an expired code is dropped, and the link that opened the app is not replayed by a reload. A build without a dev host (every store build) never listens for such links. The command puts a short-lived pairing code in the device log; use it only with a dev host.

iOS App Transport Security: a dev build adds `NSAllowsLocalNetworking` (not `NSAllowsArbitraryLoads`) and `NSLocalNetworkUsageDescription` to its Info.plist, only when `MOPILOT_DEV_HOST` is set. Local-network and IP-address connections then work over plain `ws://`/`http://` and every other domain keeps ATS, so no local TLS certificate is needed. The first launch asks for the Local Network permission; allow it.

The current pairing code is always in `<dir>/pairing-code.txt` (`pbcopy < ~/.mopilot-mobile-dev-host/pairing-code.txt`). A code lives two minutes; `--renew` makes a fresh one every minute (a pairing being confirmed is not replaced), so a code read from the file always has at least a minute left.

Real pushes from the dev host: the host's relay reads its push settings from the environment of the shell that starts it (never from the repository): `PUSH_MODE=direct APNS_KEY_FILE=~/mopilot-secrets/AuthKey_XXXX.p8 APNS_KEY_ID=… APNS_TEAM_ID=… APNS_TOPIC=ai.mopilot.phone`, and `APNS_SANDBOX=1` for a build signed with a development profile (a Debug build on a phone), unset for TestFlight or store builds. The host prints one line saying how it will push (no key in it). Keep the `.p8` outside the repository. `run push` then sends the same request a Mac makes when a chat needs you, with the chat's sealed title when titles in push are on.

Bench scenarios: type `scenarios` in the host console (or write it to the host's stdin, e.g. through a FIFO) to list them, and `run <name> [args]` to start one. Each makes a chat of its own titled "[bench] …" (the MoMo and connection ones change the host instead) and prints what to look at on the phone; the log explains every request and event in a `↳` line.

| Command | What it does |
| --- | --- |
| `run fail-mid-stream` | streams half an answer, then the turn fails with a reason |
| `run slow-stream [seconds=30]` | a long slow answer; press Stop on the phone in the middle |
| `run huge-output [kb=600]` | a command output over one frame, then a normal reply |
| `run overflow [models=30]` | the model menu has that many more models (0 puts it back), so its sheet scrolls |
| `run long-history [rows=500] [rich]` | a chat with a very long saved history; `rich` makes the replies code blocks, tables and lists in turn |
| `run answered-elsewhere [seconds=20]` | an approval card the Mac answers while the phone is looking at it |
| `run plan [long]` | a Claude Code plan card with the plan text (`long`: clipped) |
| `run site-approval [label=shop.example]` | a browser approval that says "To: <label>" (`none`: without that line) |
| `run momo on\|off` | MoMo allowed or not for the account (off at start; the phone sees it at its next hello: reconnect or reopen the MoMo tab). MoMo has memory facts, documents, routines with a proposal waiting, a brain and a main chat that streams and asks |
| `run direct on\|off` | the Mac's switch "Use without your Mac" for every paired phone (needs `--real-host`) |
| `run host-card [text]` | the real Host raises an approval card with no app attached, so an enrolled phone is pushed (needs `--real-host`; the text must contain PERMIT) |
| `run host-chat fake\|claude\|codex [text]` | the real Host starts a chat on one of its agents (cheapest model, low effort) with no app attached; the phone follows it (needs `--real-host`) |
| `run host-answer allow\|deny` | the app answers the real Host's waiting cards, as another client would: the phone's card shows it was answered elsewhere |
| `run s3 allow\|deny\|elsewhere` | an assisted run for the person holding the phone: raises one Host card, prints what to ask them to do (lock the phone first, then act on the notification), then reports how long the Host took to see the card answered; `elsewhere` answers on this side after 20 s so the notification should clear. Needs `--real-host` |
| `run brain-switch on\|off` | the Mac's "let my phone change the brain" setting (needs MoMo on) |
| `run sleep [seconds=20]` | the Mac sleeps (presence "sleeping"), then wakes |
| `run unplug [seconds=20]` | the Mac drops off the network (presence "gone") and reconnects by itself |
| `run restart-relay [seconds=3]` | the relay restarts on the same address, keeping its mailbox; both sides reconnect |
| `run revoke [n=1]` | the Mac removes the nth paired phone (it must pair again) |
| `run gap [n=5000] [pairId]` | the Mac's send counter runs n frames ahead of what the phone has seen, for every paired phone or the one named: past 4096 the phone catches up, past 131072 it shows "Can't read this computer's messages. Pair it again." The phone may be connected (it shows this on the next frame: send a message from the Mac chat or `run work`) or killed (it shows this when opened) |
| `run push [kind=needsYou] [chat=dev-seed-waiting]` | the Mac asks the relay to push to every paired phone (a real notification when the host has push keys, below; otherwise the relay answers `disabled` or `no_token`) |
| `run chats [n=200]` | adds bulk chats to test the list (idempotent) |

**Build flags reach a dev client through Metro, not through the installed binary.** A dev client takes `Constants.expoConfig` (so `extra.hostChat`, which `MOPILOT_HOST_CHAT=1` sets in `app.config.js`) from the Metro that serves it. For a device check of machine chats start Metro with the same variable as the build (`MOPILOT_HOST_CHAT=1 MOPILOT_DEV_HOST=http://<this Mac>:8787 npx expo start --dev-client --lan`); a Metro without it leaves `host.phoneChat` off on the phone (the dev host's stand-in Mac does not tell the flag), and a Host chat then opens as "Waiting for your computer…" with nothing in it. The same holds for any other `extra` value (`phoneUi` and the like).

`--real-host <vm>` joins a real Host to the made-up machines (`scripts/mobile-dev-host/realHost.mjs`): it installs the Host in a Tart VM with the acceptance run's own steps (`scripts/host-accept`; hold the VM's lock), gives it the repo's fake ACP agent and lets a phone enroll with it through the Mac's own courier (`electron/host/phoneEnroll.cjs`: `machines.enroll` registers the phone's key and hands the Host the relay link). Only the Mac around the courier is this dev host. The courier refuses a plain `ws://` relay address that is not loopback, so the Host reaches the relay as `ws://127.0.0.1:<port>` through a forwarder started in the VM, and the dev host swaps that address into the enrollment (`hostSeesRelay`); the phone keeps using the LAN address for itself. `--vm-gateway` names this Mac as the VM sees it (default 192.168.64.1) and `--keep-host` leaves the Host installed when the dev host stops.

A hard restart of the whole host (state kept: pairing, sign-ins, chats' repository) is `kill -9` on its process and starting it again.

Terminal and screen mirrors are on for the phone (`--no-mirrors` turns them off). The terminal is a real shell in the host's repository via node-pty; if the log says node-pty could not start one, the shell runs on plain pipes, and `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` restores a real terminal.

## Icons

Every image in `assets/` is generated from the desktop icon (`build/icon.png`). After changing it, run `npm run icons --prefix mobile` and commit the result; `tests/phoneBranding.test.ts` fails while they differ.

## State and recovery

SQLite serializes encrypted vault mutations. The vault key uses device-only SecureStore access and is read inside the database write transaction. An existing encrypted row without its key fails closed. The vault holds account refresh ownership, device keys, pairs, pending pairing and ratchet checkpoints; public UI snapshots expose neither tokens nor keys.

Interrupted pairing requires explicit cleanup before another pairing. Cleanup retires the original owner and pair, retains a durable tombstone, and uses bounded relay acknowledgements. When the relay cannot establish whether the Mac still shows an unfinished pairing, the client asks the user to dismiss it there. A lost refresh response requires sign-in again rather than reuse of a potentially rotated refresh token.

History and live output use the phone snapshot contract (desktop PR #2689, merged): a snapshot at a revision plus patches, so the client can deduplicate exactly. Provisional live output is labelled separately; older saved messages remain visible.

Foreground resume reconnects to the selected computer. iOS suspension does not keep a socket alive. This client does not yet transfer an offline Mac session to a cloud agent or expose phone data as a MoMo source. Push is described under [Push notifications](#push-notifications).

## Isolated native check

The maintainers run the native vault check on an isolated GitHub macOS runner; the source edition does not include that runner script.

## Push notifications

`mobile/src/push/` owns the phone side. A signed-in phone shows an explanation card first; only its "Turn on notifications" button asks the OS, and "Not now" is not repeated for seven days. Once permitted, the APNs (iOS) or FCM (Android) token is registered with the relay (`push.register`), replaced when the OS rotates it, retried on the next relay connection or foreground when a call failed, and removed (`push.unregister`) at sign-out, bounded to four seconds so a slow relay cannot block sign-out. The relay keeps one token per device, so a replacement is an overwrite.

Every push and every foreground drains the mailbox: an online phone already receives live, an offline one reconnects its last (or only) computer; overlapping wakes collapse into one drain plus at most one more. A tapped notification carries only `kind` and the opaque `ref`. For `machineOffline` the ref is the pair id; otherwise the phone recomputes `chatRef(pair, chat)` (the same SHA-256 handle as `shared/remote/ref.mjs`) over each paired computer's recent chats until one matches, then opens that chat. A computer that is offline is skipped; no match opens the home screen.

### Payload the phone expects

A push (APNs custom keys, or an FCM data message), as built by `relay/src/pushPayload.mjs`, carries `kind`, `ref` and optionally `st`, the sealed title. The sealed title is `base64url(nonce24 || XChaCha20-Poly1305(titleKey, nonce, utf8 title, aad))` (padded or not) with `aad = "mopilot-push-title-v1|" + ref`. The key is a per-pair 32-byte title key that the Mac generates and the phone stores in the keychain (`createTitleKeys`); it is stateless, so neither the iOS extension nor the Android task ever reads or advances the session ratchet. The relay does not say which pair a push belongs to, so each stored key is tried and the AEAD tag decides. The relay omits `st` on a merged "(n)" push; any failure keeps the fixed title. The Mac delivers the key as a sealed `push.titleKey` event (`patch.key`, 64 lowercase hex characters) on the pair's channel, which the controller stores with `createTitleKeys.save` (idempotent; resent by the Mac). It only arrives while that computer is the selected, connected one, and a pair's key is removed when the pair is. A sealed Android push is data-only (`kind`, `ref`, `st`, fixed `title`), so the data-message task runs in the background; a push without a sealed title keeps a notification block and shows the fixed title itself.

### iOS actions

The app registers `mopilot.needsYou`, `mopilot.momoNeedsYou` and `mopilot.done` categories (`machineOffline` has none) with a Review/Open button and a typed Reply. Every action opens the app and a reply needs the device unlocked. A reply is never sent from the notification: it becomes a draft (two replies for the same chat join in order; one for a chat that cannot be found shows a notice instead of being lost) in the chat the notification names (after any draft already there) for the user to review and send, so no chat text travels through a push. The relay names the category in `aps.category` (`mopilot.<kind>`, none for `machineOffline`).

### The computer's notification settings

While a computer is connected the app shows its notification settings (`push.settings.get` / `.set`, names in `shared/remote/pushSettings.mjs`): when it notifies, which kinds, chat titles in push (sealed on the computer) and MoMo's quiet hours. The Mac decides when to push and is the only copy; the phone changes one setting at a time and shows what the Mac returns. A Mac that does not advertise `capabilities.pushSettings` gets an update message, and the Mac's own refusals (such as MoMo quiet hours on an account without MoMo) are shown as they are.

### Stale push state

Title keys follow the pairs: the first signed-in snapshot drops keys of pairs removed while the app was closed, a removed pair drops its key and any pending tap for it, and an account change or sign-out drops them all (the Mac resends the new account's).

### Lock screen (Android)

Settings offers Show, Hide details or Hide for notifications the app shows itself (a data message, which is what a sealed title uses). Android fixes a channel's lock-screen behaviour when it is created, so each choice has its own four channels (`needs-you`, `needs-you-silent`, `done`, `done-silent`, suffixed `-private` or `-hide`); changing the choice creates that set and deletes the others. Channel changes run one after another and always end on the saved choice (the headless task and the app share the queue when the process is alive); an unreadable store changes nothing, and the headless task then uses the `private` set without removing others. Deleting a channel dismisses its shown notifications. The relay now sends every Android push as a high-priority data message, so the app shows all of them and the choice applies to all; the manifest's `system` channel is only a fallback for a message with a notification block, and vendor battery optimization can still delay or drop data messages for a sleeping app. Push content is fixed titles only; the lock-screen choice decides whether even that is visible.

### Background drain

A push while the app is on screen drains at once. On Android a data message handled in a backgrounded (not killed) app process also wakes the running controller, which reconnects the last computer; a killed app has no runtime, and the headless task never builds a second one (one socket and one ratchet writer per device), so the mailbox drains at the next launch or foreground. A drain reconnects only an idle offline (or failed) phone, never over a pairing, a cleanup or the user's own connect, and a failed drain backs off for 30 s so a burst of pushes does not reconnect each time; no push is shown, and so no drain starts, while notifications are off. iOS delivers alerting pushes without running the app, so there is no background drain there either.

### iOS Notification Service Extension

`plugins/withNotificationServiceExtension.js` adds the `NotificationServiceExtension` target at prebuild: App Group and `keychain-access-groups` entitlements on the app and the extension, the Swift source (`plugins/NotificationService.swift`), an embed phase and target dependency, and a `Sodium` pod target (libsodium) for the extension only. The extension reads the title keys by keychain service (`mopilot-push`) and delivers the relay's fixed title unchanged on any failure or at the system's ~30 s expiry; it counts fallbacks in the App Group.

### iOS Live Activity widget

`plugins/withLiveActivity.js` adds the `LiveActivityExtension` target (an ActivityKit widget, iPhone only, iOS 16.2) next to the Notification Service Extension at prebuild, and sets `NSSupportsLiveActivities` on the app. It shares the extension's App Group and keychain group entitlements, its Sodium pod target and its privacy manifest; `plugins/xcodeExtension.js` is the Xcode edit both plugins use. A push-to-update reaches the widget process directly (there is no service extension for ActivityKit), so the widget itself must read the per-pair title keys (`plugins/LiveActivity/TitleKeyStore.swift`, same keychain service as the extension) and the titles switch in the App Group. `expo-widgets` was not used: it draws widgets from JS layouts and cannot link libsodium or read the shared keychain. A device build (`MOPILOT_DEVICE_BUILD=1`) skips the widget like the extension, since a free Apple account cannot sign the groups. The target builds in the simulator build that runs before a release (`mobile-release-checks.yml`).

### Android

`expo-notifications` and `expo-task-manager` register a background task for FCM data messages (`src/push/dataMessage.ts` chooses the title and channel, `src/platform/notifications.ts` shows it). Channels: `needs-you` (high importance) and `done` (default). A data message that starts the process finds its task defined at module load in `index.js`.

### Push configuration

Nothing real is checked in. `app.config.js` reads these from the environment (defaults in `config/identifiers.js`):

| Variable | Meaning | Placeholder default |
| --- | --- | --- |
| `MOPILOT_IOS_BUNDLE_ID` | iOS bundle id | The iOS identifier in `mobile/config/edition.json` |
| `MOPILOT_ANDROID_PACKAGE` | Android application id | The Android identifier in `mobile/config/edition.json` |
| `MOPILOT_APPLE_TEAM_ID` | Apple team id (signing, keychain group prefix) | empty: extension unsigned, title keys app-private |
| `MOPILOT_APP_GROUP` | App Group shared with the extension | `group.<bundle id>` |
| `MOPILOT_KEYCHAIN_GROUP` | keychain group shared with the extension | `<bundle id>.shared` |
| `MOPILOT_GOOGLE_SERVICES_FILE` | path to the Firebase `google-services.json` | unset: FCM tokens unavailable |

`npx expo prebuild --no-install` with a team id and a `google-services.json` generates both projects; the unit tests run the plugin against a template project. Provisioning the Apple key, the APNs/FCM sender and the Firebase project is operational work not done here.

### Build profiles

`MOPILOT_BUILD_PROFILE` is `development`, `preview` or `production`. A development build keeps what the dev client needs: Bonjour discovery, the Local Network string, `NSAllowsLocalNetworking` and the `exp+` URL scheme. A preview or production build removes all of it (`plugins/withReleaseHardening.js`), signs push for Apple's production service, and refuses `MOPILOT_DEV_HOST`, `MOPILOT_DEV_CLIENT=1` and `MOPILOT_DEVICE_BUILD=1`. With the variable unset, a dev host, a device build or the dev-client flag mean development and anything else is a store build, so a forgotten variable can only remove access: a plain Debug build that loads JS from Metro (`npx expo run:android`, or `expo run:ios` without a dev host) sets `MOPILOT_BUILD_PROFILE=development` in the shell that runs it, as the device script does, or it loses the dev client's deep link and plain-http Metro access. What each store build asks the OS for, and why, is in `docs/mobile-remote/permissions-audit.md`; `tests/phoneReleaseConfig.test.ts` runs a real prebuild and asserts it.

### Device build

The default build is the full one: `MOPILOT_APPLE_TEAM_ID=<team>` with `xcodebuild -allowProvisioningUpdates -allowProvisioningDeviceRegistration` signs the push, App Group and keychain-group entitlements and the notification extension, and needs the team's Program License Agreement accepted so Xcode can create the App IDs and profiles. When the profiles cannot carry those capabilities (a free account, or an agreement still pending), `MOPILOT_DEVICE_BUILD=1` is the fallback: `app.config.js` skips `expo-notifications` and the extension plugin and drops `aps-environment`, so a Debug build signs with a development identity alone:

```sh
MOPILOT_APPLE_TEAM_ID=<team> scripts/mobile-ios-device.sh <device udid> [full|fallback]
```

The script runs the prebuild, `pod install` (CocoaPods needs a Ruby 3 install; the macOS system Ruby is too old), the signed Debug `xcodebuild` (`-allowProvisioningUpdates -allowProvisioningDeviceRegistration`), `devicectl install` and the launch with the dev-client link. `fallback` sets `MOPILOT_DEVICE_BUILD=1`. Then run `npx expo start --dev-client --lan --port 8081` here.

The app targets Expo SDK 58 because the iOS 27 SDK refuses to launch an app without the UIScene life cycle, which `ExpoAppSceneDelegate` provides. `patches/react-native-libsodium+1.7.0.patch` (applied by `postinstall`; after an `npm ci --ignore-scripts` run `npx patch-package`) reads the JSI runtime from the bridgeless `RCTBridgeProxy`, because React Native 0.88 no longer exposes `RCTCxxBridge`; without it `sodium` has no native functions and sign-in fails with `undefined is not a function`. `react-native-libsodium` 1.7.0 is the latest release, so the patch stays until upstream reads the runtime without `RCTCxxBridge`.

### Driving the app on a real phone

`MOPILOT_DEV_HOST` must be set for `npx expo start` too, not only for the prebuild: a development client takes `extra` from the Metro server's config, so a Metro started without it keeps the production sign-in address (the system prompt then names `mopilot.ai` instead of the host's address; cancel it).

`scripts/mobile-ios-wda.sh` builds Appium's WebDriverAgent (pinned to v16.15.3 by commit) as a signed test runner (`ai.mopilot.wda.runner`) for a plugged-in phone: `install <udid>` (needs `MOPILOT_APPLE_TEAM_ID`), then `run <udid>` in the foreground. The runner binds only to the phone's CoreDevice tunnel address (`USE_IP`), so only this Mac reaches it (the tunnel address changes whenever the phone reconnects: read it again with `xcrun devicectl device info details` and restart `run` if the runner stopped, which it does when the address changes); `curl http://[<tunnel address>]:8100/status` answers there and not on the phone's Wi-Fi address. Open a session with `{"capabilities":{"alwaysMatch":{"bundleId":"ai.mopilot.phone"}}}` and drive only this app: the runner can tap anything on the phone. `remove <udid>` uninstalls it (or delete the "WebDriverAgentRunner-Runner" app on the phone). The runner needs a trusted developer profile: the first run may ask for Settings > General > VPN & Device Management > Trust.

### Android emulator

`scripts/mobile-android-emulator.sh` runs the debug build on an arm64 Android emulator (Apple silicon), with the JDK and SDK in `~/Android` (`MOPILOT_ANDROID_ROOT`), nothing system-wide:

```sh
scripts/mobile-android-emulator.sh setup --accept-licenses   # once: Temurin 17, cmdline-tools, SDK 37, build-tools 37, NDK 27.1, API 36 arm64 image, AVD mopilot-api36 (4 GB, 4 cores)
node scripts/mobile-dev-host.mjs --host 10.0.2.2 --renew --dir ~/.mopilot-mobile-dev-host-android   # the emulator's alias for this Mac; the QR must carry it, a build trusts only its own host
(cd mobile && MOPILOT_DEV_HOST=http://10.0.2.2:8787 MOPILOT_DEV_CLIENT=1 npx expo start --dev-client --port 8081)   # Metro with the same override
scripts/mobile-android-emulator.sh all                        # prebuild --clean, debug APK, boot the AVD, install, adb reverse 8081 and 8787, open the dev client
```

`setup` pins the SDK pieces React Native 0.88 builds with (`tests/mobileAndroidEmulatorScript.test.ts` fails when a React Native bump moves them) and needs `--accept-licenses`, because it accepts the Android SDK licenses for you. `build` sets `MOPILOT_DEV_HOST` and `MOPILOT_DEV_CLIENT=1` like the iOS recipe above; the same rules apply (Metro needs it too, a Release build bakes it in).

What the first runs showed, so the next one does not rediscover it:

- The default 2 GB AVD swaps and every app, including System UI, gets ANRs; the script's 4 GB / 4 cores run the app. The emulator is slow while the Mac is under load (a load average above ~30 makes input events take seconds and drops `adb shell input text` characters), so wait for the machine rather than retrying.
- `adb root` restarts adbd and drops `adb reverse`: run `install` (or the two `adb reverse` lines) again, or the dev client says "Failed to connect to localhost:8081".
- A fresh AVD opens Chrome's first-run page on the first sign-in: choose "Use without an account" once.
- The dev client's own menu and floating Tools button appear in screenshots; they are not part of the app.
- Typing a pairing code with `adb shell input text` drops characters under load, and the field then holds a mangled code; check the field before Continue.

### Verified and not verified

Unit tests cover the registration state machine, permission flow, drain coalescing, tap routing, sealed-title opening against the Mac's real libsodium primitives, the Android data-message path, config resolution and the Xcode project edit. A prebuild of both platforms and `expo export` for iOS and Android succeed. Not covered: any real APNs/FCM delivery, a physical device, the Swift extension compiling or running (it needs Xcode and the `Sodium` pod; run it in a VM or on a CI runner), the Expo SecureStore keychain item layout the extension queries on a device, the exact shape of the Android background-task data on a device. The Android emulator runs only on a developer's Mac through the script above (macOS runners cannot run the emulator with acceleration, and the repo has no Android runner).
