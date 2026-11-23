#!/bin/sh
# Builds the 0.2.0 release (commit 7a5bf12) from git into a cache dir and prints the dir.
# Needs network for `npm ci` the first time; later runs reuse the cache.
#   usage: tests/downgrade/build-020.sh [dir]     (default: $TMPDIR/sage-0.2.0-7a5bf12)
set -e
COMMIT=7a5bf12
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=${1:-${TMPDIR:-/tmp}/sage-0.2.0-$COMMIT}
if [ -f "$DIR/dist/index.html" ] && [ -d "$DIR/node_modules/electron" ]; then
  echo "$DIR"
  exit 0
fi
rm -rf "$DIR"
mkdir -p "$DIR"
git -C "$ROOT" archive "$COMMIT" | tar -x -C "$DIR"
cd "$DIR"
npm ci --no-audit --no-fund >&2
# the electron binary is downloaded by its install script; make sure it is there
[ -f node_modules/electron/path.txt ] || node node_modules/electron/install.js >&2
npx vite build >&2
echo "$DIR"
