#!/bin/bash
# DEV ONLY: builds a pinned WebDriverAgent (Appium) test runner for a plugged-in iPhone, installs it and runs it, so UI checks of Mobile Remote can tap, type and take screenshots without a person.
# Usage: MOPILOT_APPLE_TEAM_ID=<team> scripts/mobile-ios-wda.sh <install|run|remove> <device udid>
#   install  fetch the pinned source, build the signed runner (ai.mopilot.wda.runner) and install it; the first run asks you to trust the developer on the phone
#   run      start the runner, bound to the device's tunnel address only (not the Wi-Fi or LAN), and print its URL; stays in the foreground, Ctrl-C stops it
#   remove   uninstall the runner from the phone
# Drive only ai.mopilot.phone with it; it can tap any app on the phone.
set -euo pipefail
action="${1:?usage: mobile-ios-wda.sh <install|run|remove> <device udid>}"
udid="${2:?usage: mobile-ios-wda.sh <install|run|remove> <device udid>}"
# Appium WebDriverAgent v16.15.3, pinned by commit so the source cannot change under us.
commit=02cb92f0e93c8b021443bcbb8eeb80932c113220
work="${MOPILOT_WDA_DIR:-${TMPDIR:-/tmp}/mopilot-wda}"
runner=ai.mopilot.wda.runner
case "$action" in
install)
  team="${MOPILOT_APPLE_TEAM_ID:?set MOPILOT_APPLE_TEAM_ID to the Apple team id}"
  mkdir -p "$work/src"
  if [ ! -f "$work/src/.commit-$commit" ]; then
    rm -rf "$work/src" && mkdir -p "$work/src"
    curl -fsSL "https://github.com/appium/WebDriverAgent/archive/$commit.tar.gz" | tar xz --strip-components=1 -C "$work/src"
    # our own bundle ids, so the runner is recognisable and removable and cannot collide with another WebDriverAgent
    sed -i '' -e "s/com\.facebook\.WebDriverAgentRunner;/$runner;/" -e 's/com\.facebook\.WebDriverAgentLib;/ai.mopilot.wda.lib;/' "$work/src/WebDriverAgent.xcodeproj/project.pbxproj"
    touch "$work/src/.commit-$commit"
  fi
  xcodebuild build-for-testing -project "$work/src/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner -configuration Debug \
    -destination "id=$udid" -derivedDataPath "$work/derived" DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration
  xcrun devicectl device install app --device "$udid" "$work/derived/Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app"
  ;;
run)
  # the device's CoreDevice tunnel address: reachable from this Mac only, unlike the Wi-Fi address
  ip="$(xcrun devicectl device info details --device "$udid" 2>/dev/null | sed -n 's/.*Tunnel IP Address: *//p' | head -n 1)"
  [ -n "$ip" ] || { echo "no tunnel address for $udid; is the phone connected and unlocked?" >&2; exit 1; }
  echo "WebDriverAgent will listen on http://[$ip]:8100 (tunnel only)"
  TEST_RUNNER_USE_IP="$ip" xcodebuild test-without-building -project "$work/src/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner \
    -destination "id=$udid" -derivedDataPath "$work/derived" -allowProvisioningUpdates
  ;;
remove)
  xcrun devicectl device uninstall app --device "$udid" "$runner"
  ;;
*) echo "usage: mobile-ios-wda.sh <install|run|remove> <device udid>" >&2; exit 2 ;;
esac
