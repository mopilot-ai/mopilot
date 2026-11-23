// The native runner must not build Swift6.2 packages using its default Swift6.1 toolchain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneSendToolchain } from './e2e/fixtures/phone-send-toolchain.mjs';

test('a runner with Swift6.1 selected uses an installed compatible Xcode in every returned child environment', () => {
  const env = { PATH: '/runner/bin', DEVELOPER_DIR: '/old' };
  const seen: string[] = [];
  const selected = phoneSendToolchain({
    applications: ['Notes.app', 'Xcode_26.app', 'Xcode_16.app'],
    active: '/old',
    env,
    probe: (candidate) => {
      seen.push(candidate.DEVELOPER_DIR);
      return candidate.DEVELOPER_DIR.includes('26') ? 'Apple Swift version 6.2.1 (swiftlang)' : 'Apple Swift version 6.1.0 (swiftlang)';
    },
  });
  assert.equal(selected.DEVELOPER_DIR, '/Applications/Xcode_26.app/Contents/Developer');
  assert.equal(selected.PATH, env.PATH);
  assert.equal(env.DEVELOPER_DIR, '/old', 'selection does not mutate process or global Xcode state');
  assert.deepEqual(seen, ['/old', '/Applications/Xcode_16.app/Contents/Developer', '/Applications/Xcode_26.app/Contents/Developer']);
});

test('a compatible active developer directory wins without probing another installation', () => {
  let calls = 0;
  const selected = phoneSendToolchain({
    applications: ['Xcode_26.app'],
    active: '/active',
    env: {},
    probe: () => {
      calls++;
      return 'Apple Swift version 6.2.0';
    },
  });
  assert.equal(selected.DEVELOPER_DIR, '/active');
  assert.equal(calls, 1);
});

test('failed and malformed probes cannot select a toolchain, while newer major Swift is admitted', () => {
  const selected = phoneSendToolchain({
    applications: ['Xcode_27.app', 'Xcode_28.app'],
    active: '/broken',
    env: {},
    probe: (env) => {
      if (env.DEVELOPER_DIR === '/broken') throw new Error('missing installation');
      return env.DEVELOPER_DIR.includes('27') ? 'not a Swift version' : 'Apple Swift version 7.0.0';
    },
  });
  assert.equal(selected.DEVELOPER_DIR, '/Applications/Xcode_28.app/Contents/Developer');
});

test('absence of compatible Swift fails explicitly with version evidence instead of starting an incompatible native build', () => {
  assert.throws(
    () => phoneSendToolchain({ applications: ['Notes.app'], active: '/old', env: {}, probe: () => 'Apple Swift version 6.1.0' }),
    /requires an installed Swift 6\.2\+ toolchain.*\/old: 6\.1/,
  );
  assert.throws(
    () =>
      phoneSendToolchain({
        applications: [],
        active: undefined,
        env: {},
        probe: () => {
          throw new Error('must not probe');
        },
      }),
    /requires an installed Swift 6\.2\+ toolchain/,
  );
});
