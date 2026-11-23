#!/bin/bash
# Builds Mobile Remote for the Android emulator on Apple silicon (user-level JDK and SDK, prebuild, debug APK), boots an AVD, installs the app and opens it on this Mac's Metro.
# Usage: scripts/mobile-android-emulator.sh setup --accept-licenses | build | emulator | install | launch | all
#   setup     downloads Temurin 17 and the pinned Android SDK packages into $MOPILOT_ANDROID_ROOT (default ~/Android) and creates the AVD; --accept-licenses accepts the Android SDK licenses on your behalf
#   build     expo prebuild --platform android (MOPILOT_DEV_HOST defaults to the emulator's alias for this Mac) and a debug APK for arm64
#   emulator  boots the AVD (4 GB, 4 cores) and waits for it; leaves it running
#   install   installs the APK and forwards Metro (8081) and the dev host (8787) with adb reverse
#   launch    opens the dev client on Metro; run `npx expo start --dev-client --port 8081` in mobile/ with MOPILOT_DEV_HOST and MOPILOT_DEV_CLIENT=1 set as for the build
#   all       build, emulator, install, launch
# Nothing here is secret: the SDK is downloaded from dl.google.com and the JDK from adoptium.net, both pinned below.
set -euo pipefail
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
android_root="${MOPILOT_ANDROID_ROOT:-$HOME/Android}"
export ANDROID_HOME="$android_root/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
jdk_version="17.0.21+9"
cmdline_tools="14742923"
avd="${MOPILOT_AVD:-mopilot-api36}"
# versions React Native 0.88 (mobile/node_modules/react-native/gradle/libs.versions.toml) and Expo SDK 58 build with
packages=("platform-tools" "emulator" "platforms;android-37.0" "build-tools;37.0.0" "ndk;27.1.12297006" "cmake;3.22.1" "system-images;android-36;google_apis;arm64-v8a")
export MOPILOT_DEV_HOST="${MOPILOT_DEV_HOST:-http://10.0.2.2:8787}"
export MOPILOT_DEV_CLIENT="${MOPILOT_DEV_CLIENT:-1}"

jdk_home() { ls -d "$android_root"/jdk/*/Contents/Home 2>/dev/null | head -n 1 || true; }
use_tools() {
  JAVA_HOME="$(jdk_home)"
  [ -n "$JAVA_HOME" ] || { echo "no JDK under $android_root/jdk: run 'setup --accept-licenses' first" >&2; exit 1; }
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
}
apk="${MOPILOT_ANDROID_APK:-$root_dir/mobile/android/app/build/outputs/apk/debug/app-debug.apk}"

setup() {
  [ "${1:-}" = --accept-licenses ] || { echo "setup downloads the Android SDK and needs --accept-licenses (you accept https://developer.android.com/studio/terms)" >&2; exit 2; }
  [ "$(uname -m)" = arm64 ] || { echo "this script pins arm64 images for Apple silicon" >&2; exit 1; }
  mkdir -p "$android_root/downloads" "$android_root/jdk" "$ANDROID_HOME/cmdline-tools"
  if [ -z "$(jdk_home)" ]; then
    curl -fsSL -o "$android_root/downloads/jdk.tar.gz" "https://api.adoptium.net/v3/binary/version/jdk-${jdk_version/+/%2B}/mac/aarch64/jdk/hotspot/normal/eclipse"
    # extract beside the target and rename, so an interrupted extraction is never taken for an installed JDK
    rm -rf "$android_root/jdk.partial" && mkdir "$android_root/jdk.partial"
    tar -xzf "$android_root/downloads/jdk.tar.gz" -C "$android_root/jdk.partial"
    mv "$android_root"/jdk.partial/* "$android_root/jdk/" && rmdir "$android_root/jdk.partial"
  fi
  if [ ! -d "$ANDROID_HOME/cmdline-tools/latest" ]; then
    curl -fsSL -o "$android_root/downloads/cmdline-tools.zip" "https://dl.google.com/android/repository/commandlinetools-mac-${cmdline_tools}_latest.zip"
    rm -rf "$android_root/cmdline-tools.partial" && mkdir "$android_root/cmdline-tools.partial"
    unzip -q -o "$android_root/downloads/cmdline-tools.zip" -d "$android_root/cmdline-tools.partial"
    mv "$android_root/cmdline-tools.partial/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" && rmdir "$android_root/cmdline-tools.partial"
  fi
  use_tools
  yes | sdkmanager --licenses >/dev/null || true
  sdkmanager "${packages[@]}"
  # the AVD lives in ~/.android/avd; an existing one (its data, or another AVD named by MOPILOT_AVD) is left as it is
  config="$HOME/.android/avd/$avd.avd/config.ini"
  if [ -f "$config" ]; then
    echo "AVD $avd exists, leaving it as it is"
    return
  fi
  echo no | avdmanager create avd -n "$avd" -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_8
  # the default 2 GB guest swaps and every app gets ANRs; 4 GB and 4 cores run the app
  sed -i '' -E 's/^hw.ramSize=.*/hw.ramSize=4096/; s/^hw.cpu.ncore=.*/hw.cpu.ncore=4/' "$config"
  grep -q '^hw.ramSize=4096$' "$config" && grep -q '^hw.cpu.ncore=4$' "$config" || { echo "could not set the AVD's memory and cores in $config" >&2; exit 1; }
}

build() {
  use_tools
  cd "$root_dir/mobile"
  npx expo prebuild --platform android --no-install --clean
  echo "sdk.dir=$ANDROID_HOME" >"android/local.properties"
  (cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a --console=plain)
  echo "built $apk"
}

# the emulator the next adb commands talk to (adb refuses with "more than one device" otherwise); empty when none is up
pick_emulator() {
  local devices
  devices="$(adb devices)"
  ANDROID_SERIAL="$(printf '%s\n' "$devices" | awk '/^emulator-[0-9]+[ \t]+device/ { print $1; exit }')"
  export ANDROID_SERIAL
  [ -n "$ANDROID_SERIAL" ]
}

emulator_up() {
  use_tools
  if pick_emulator; then return; fi
  # no snapshot and no animations: a snapshot of a half-booted guest is the usual cause of a blank screen
  nohup emulator -avd "$avd" -no-snapshot -no-boot-anim -gpu auto >"${TMPDIR:-/tmp}/mopilot-android-emulator.log" 2>&1 &
  local pid=$! waited=0
  echo "emulator pid $pid (log ${TMPDIR:-/tmp}/mopilot-android-emulator.log); stop it with: kill $pid"
  until pick_emulator && [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do
    kill -0 "$pid" 2>/dev/null || { echo "the emulator exited; see ${TMPDIR:-/tmp}/mopilot-android-emulator.log" >&2; exit 1; }
    [ "$waited" -lt 600 ] || { echo "the emulator did not finish booting in 10 minutes; see ${TMPDIR:-/tmp}/mopilot-android-emulator.log" >&2; exit 1; }
    sleep 5
    waited=$((waited + 5))
  done
  for scale in window_animation_scale transition_animation_scale animator_duration_scale; do adb shell settings put global "$scale" 0; done
  # the package manager can still be starting just after boot_completed
  until adb shell pm path android >/dev/null 2>&1; do sleep 2; done
}

install_app() {
  use_tools
  pick_emulator || { echo "no emulator is running: run emulator first" >&2; exit 1; }
  [ -f "$apk" ] || { echo "no APK at $apk: run build first" >&2; exit 1; }
  adb install -r "$apk"
  # a Debug build loads JS from Metro; reverse keeps localhost:8081 working when the emulator's alias for this Mac is not
  adb reverse tcp:8081 tcp:8081
  adb reverse tcp:8787 tcp:8787
}

launch() {
  use_tools
  pick_emulator || { echo "no emulator is running: run emulator first" >&2; exit 1; }
  local started
  started="$(adb shell am start -a android.intent.action.VIEW -d 'mopilot://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081' ai.mopilot.remote)"
  echo "$started"
  # am start exits 0 even when nothing handled the intent
  ! printf '%s' "$started" | grep -q '^Error'
}

case "${1:-}" in
  setup) setup "${2:-}" ;;
  build) build ;;
  emulator) emulator_up ;;
  install) install_app ;;
  launch) launch ;;
  all) build; emulator_up; install_app; launch ;;
  *) sed -n 2,10p "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
