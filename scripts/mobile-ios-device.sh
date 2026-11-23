#!/bin/bash
# Builds Mobile Remote for a plugged-in iPhone (prebuild, pod install, signed Debug build), installs it and opens it on this Mac's Metro.
# Usage: MOPILOT_APPLE_TEAM_ID=<team> scripts/mobile-ios-device.sh <device udid> [full|fallback]; "fallback" sets MOPILOT_DEVICE_BUILD=1.
set -euo pipefail
udid="${1:?usage: mobile-ios-device.sh <device udid> [full|fallback]}"
mode="${2:-full}"
team="${MOPILOT_APPLE_TEAM_ID:?set MOPILOT_APPLE_TEAM_ID to the Apple team id}"
command -v pod >/dev/null || { echo "CocoaPods (pod) is not on PATH; the system Ruby is too old for it, use a Ruby 3 install" >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
derived="${MOPILOT_DERIVED_DATA:-${TMPDIR:-/tmp}/mopilot-ios-device}"
[ "$mode" = fallback ] && export MOPILOT_DEVICE_BUILD=1
# a Debug build loads JS from Metro over http on the local network, which only a development profile allows
export MOPILOT_BUILD_PROFILE=development
cd "$root/mobile"
rm -rf ios
npx expo prebuild --platform ios --no-install
(cd ios && pod install)
# the Xcode project is named after the app (app.json "name"), so read it back instead of hard-coding it
workspace="$(ls -d ios/*.xcworkspace | head -n 1)"
app="$(basename "$workspace" .xcworkspace)"
xcodebuild -workspace "$workspace" -scheme "$app" -configuration Debug \
  -destination "id=$udid" -derivedDataPath "$derived" DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
# the build must come from this tree: a build of another checkout is never installed
node "$root/scripts/mobile-ios-commit.mjs" "$derived/Build/Products/Debug-iphoneos/$app.app" "$root"
xcrun devicectl device install app --device "$udid" "$derived/Build/Products/Debug-iphoneos/$app.app"
host="$(ipconfig getifaddr en0)"
xcrun devicectl device process launch --device "$udid" --terminate-existing \
  --payload-url "mopilot://expo-development-client/?url=http%3A%2F%2F$host%3A8081" ai.mopilot.phone
echo "Run 'npx expo start --dev-client --lan --port 8081' in mobile/ so the phone can load JS from $host:8081."
