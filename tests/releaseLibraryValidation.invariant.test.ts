// The release app keeps macOS library validation on: it is what keeps a changed or foreign Rust core addon (and every
// other library the app loads) from loading, since an addon outside app.asar has no other integrity check on macOS
// (docs/architecture/rust-core.md §8). Only the ad-hoc dev build may turn it off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DISABLE = 'com.apple.security.cs.disable-library-validation';

test("the release entitlements never disable library validation; the dev build's may", () => {
  assert.equal(readFileSync('build/entitlements.mac.plist', 'utf8').includes(DISABLE), false);
  // the dev build is signed ad hoc, which library validation would refuse its own Electron framework under
  assert.equal(readFileSync('build/entitlements.dev.plist', 'utf8').includes(DISABLE), true);
});
