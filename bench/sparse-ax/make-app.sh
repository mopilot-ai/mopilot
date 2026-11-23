#!/bin/sh
# Sparse-AX fixture app bundle (CM-D23, #3571 G7): a copy of the repository's Electron.app with its own bundle id
# (ai.mopilot.bench.sparse-ax) and name, so computer use does not take it for MoPilot's own Electron
# (com.github.Electron is a development instance's bundle id, which is never granted). Signed ad hoc and registered
# with Launch Services. Usage: bench/sparse-ax/make-app.sh [destination folder, default ~/Applications]
# Then launch: "<destination>/Sparse AX Fixture.app/Contents/MacOS/Electron" bench/sparse-ax/main.cjs
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
src="$root/node_modules/electron/dist/Electron.app"
dest_dir=${1:-"$HOME/Applications"}
app="$dest_dir/Sparse AX Fixture.app"
[ -d "$src" ] || { echo "no $src: run npm ci first" >&2; exit 1; }
mkdir -p "$dest_dir"
rm -rf "$app"
cp -R "$src" "$app"
plist="$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ai.mopilot.bench.sparse-ax" "$plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Sparse AX Fixture" "$plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Sparse AX Fixture" "$plist" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Sparse AX Fixture" "$plist"
codesign --force --deep --sign - "$app" >/dev/null
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
echo "$app"
