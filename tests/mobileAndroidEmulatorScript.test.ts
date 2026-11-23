// scripts/mobile-android-emulator.sh pins the SDK pieces React Native 0.88 builds with; a React Native bump that moves them must move the script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = 'scripts/mobile-android-emulator.sh';
const run = (...args: string[]) =>
  spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, MOPILOT_ANDROID_ROOT: '/nonexistent-android-root' } });

test('the script is valid bash', () => {
  assert.equal(spawnSync('bash', ['-n', script], { encoding: 'utf8' }).status, 0);
});

test('an unknown command prints the usage and fails', () => {
  const result = run('bogus');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: scripts\/mobile-android-emulator\.sh setup --accept-licenses \| build/);
  assert.doesNotMatch(result.stderr, /set -euo/);
});

test('setup does not accept the Android SDK licenses unless asked to', () => {
  const result = run('setup');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--accept-licenses/);
});

test('the build, install and launch steps say what to run first when a tool or the APK is missing', () => {
  for (const step of ['build', 'emulator', 'install', 'launch']) {
    const result = run(step);
    assert.equal(result.status, 1, step);
    assert.match(result.stderr, /no JDK under \/nonexistent-android-root\/jdk: run 'setup --accept-licenses' first/, step);
  }
});

const toml = 'mobile/node_modules/react-native/gradle/libs.versions.toml';
test('the pinned SDK platform, build tools and NDK are the ones React Native builds with', { skip: !existsSync(toml) }, () => {
  const versions = readFileSync(toml, 'utf8');
  const pin = (key: string) => versions.match(new RegExp(`^${key} = "([^"]+)"`, 'm'))?.[1];
  const source = readFileSync(script, 'utf8');
  assert.ok(source.includes(`"platforms;android-${pin('compileSdk')}.0"`), 'compileSdk');
  assert.ok(source.includes(`"build-tools;${pin('buildTools')}"`), 'buildTools');
  assert.ok(source.includes(`"ndk;${pin('ndkVersion')}"`), 'ndkVersion');
});

/** An Android root with a JDK directory and an `adb` that prints `devices` for `adb devices` and `amStart` for `adb shell am start`. */
function fakeRoot(devices: string, amStart = 'Starting: Intent') {
  const root = mkdtempSync(join(tmpdir(), 'android-script-'));
  mkdirSync(join(root, 'jdk/jdk-test/Contents/Home/bin'), { recursive: true });
  const bin = join(root, 'sdk/platform-tools');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'adb'),
    `#!/bin/bash\ncase "$1 $2 $3" in\n  "devices  ") printf 'List of devices attached\\n${devices}' ;;\n  "shell am start") echo '${amStart}' ;;\nesac\n`,
  );
  chmodSync(join(bin, 'adb'), 0o755);
  return root;
}
const runIn = (root: string, step: string) =>
  spawnSync('bash', [script, step], { encoding: 'utf8', env: { ...process.env, MOPILOT_ANDROID_ROOT: root } });

test('install and launch say to boot the emulator first when no emulator is up, and install needs the APK', () => {
  const none = fakeRoot('');
  for (const step of ['install', 'launch']) {
    const result = runIn(none, step);
    assert.equal(result.status, 1, step);
    assert.match(result.stderr, /no emulator is running: run emulator first/, step);
  }
  const missing = join(tmpdir(), 'no-such-dir', 'app-debug.apk');
  const result = spawnSync('bash', [script, 'install'], {
    encoding: 'utf8',
    env: { ...process.env, MOPILOT_ANDROID_ROOT: fakeRoot('emulator-5554\\tdevice\\n'), MOPILOT_ANDROID_APK: missing },
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`no APK at ${missing}: run build first`), result.stderr);
});

test('launch fails when nothing handled the intent, even though am start exits 0', () => {
  const failed = runIn(fakeRoot('emulator-5554\tdevice\n', 'Error: Activity not started, unable to resolve Intent'), 'launch');
  assert.equal(failed.status, 1);
  assert.equal(runIn(fakeRoot('emulator-5554\tdevice\n'), 'launch').status, 0);
});

test('the emulator step does nothing when one is already up, and ignores a physical device', () => {
  assert.equal(runIn(fakeRoot('emulator-5554\tdevice\n'), 'emulator').status, 0);
  const physical = runIn(fakeRoot('R5CT123\tdevice\n'), 'install');
  assert.match(physical.stderr, /no emulator is running/);
});
