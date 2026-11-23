// The native check must keep Xcode's simulator signing/entitlement pipeline rather than repairing signatures afterward.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulatorBuildArgs } from '../scripts/mobile-ios-build.mjs';

test('a Release simulator build keeps Xcode signing enabled and paths opaque', () => {
  const workspace = '/scratch/Phone project/App.xcworkspace';
  const derived = '/scratch/Derived data';
  const args = simulatorBuildArgs({ workspace, scheme: 'MoPilotRemote', derived });
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(value('-workspace'), workspace);
  assert.equal(value('-scheme'), 'MoPilotRemote');
  assert.equal(value('-derivedDataPath'), derived);
  assert.equal(value('-configuration'), 'Release');
  assert.equal(value('-sdk'), 'iphonesimulator');
  assert.equal(value('-destination'), 'generic/platform=iOS Simulator');
  assert.ok(args.includes('CODE_SIGNING_ALLOWED=YES'));
  assert.ok(args.includes('CODE_SIGN_IDENTITY=-'));
  assert.ok(!args.some((arg) => arg.startsWith('CODE_SIGN_ENTITLEMENTS=') || arg === 'CODE_SIGNING_ALLOWED=NO'));
  assert.equal(args.at(-1), 'build');
});
