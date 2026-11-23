// The phone's expo runtime core (expo, expo-modules-*, react-native) moves as one set (a mixed set dies at launch with a dyld error), and each patch-package patch is named for the version the lock resolves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

type Lock = Record<string, { version?: string }>;
type CoreSet = Record<string, string>;

/** The packages that link to each other at launch: a different version of one can reference what another does not define. */
const CORE = ['expo', 'expo-modules-core', 'expo-modules-jsi', 'expo-modules-macros', 'expo-modules-autolinking', 'react-native'];

/**
 * Sets that a Release build LAUNCHED with, keyed by where the lock resolves each package. Add one only after a Release build of the new set
 * launched on a simulator or a phone: the lock and the unit tests cannot tell a mismatch, and the iOS compile links it dynamically. The first
 * entry is the set of TestFlight builds 29 and 30.
 */
const LAUNCHED: CoreSet[] = [
  {
    expo: '58.0.21',
    'expo/node_modules/expo-modules-core': '58.0.28',
    'expo-modules-jsi': '58.0.21',
    'expo-modules-macros': '0.27.1',
    'expo-modules-autolinking': '58.0.16',
    'react-native': '0.88.0',
  },
];

/** Every place the lock resolves `name` (top level or nested), keyed by its path without the leading `node_modules/`. */
const resolved = (lock: Lock, name: string): CoreSet =>
  Object.fromEntries(
    Object.entries(lock)
      .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
      .map(([key, entry]) => [key.replace(/^node_modules\//, ''), String(entry.version)]),
  );

/** The lock path of a patch's package: `a++b` is b inside a, and a scope's slash is a `+` (`@s+p` is `@s/p`). */
const patched = (name: string): string =>
  name
    .split('++')
    .map((part) => part.replace(/^(@[^+]+)\+/, '$1/'))
    .join('/node_modules/');

/** What is wrong with a lock and the patch files beside it, as sentences for the next person who bumps a package. */
function problems(lock: Lock, patches: string[]): string[] {
  const out: string[] = [];
  const actual: CoreSet = Object.assign({}, ...CORE.map((name) => resolved(lock, name)));
  const missing = CORE.filter((name) => !Object.keys(actual).some((key) => key === name || key.endsWith(`/node_modules/${name}`)));
  const found = Object.entries(actual)
    .map(([key, version]) => `${key} ${version}`)
    .join(', ');
  if (missing.length > 0) out.push(`the lock must resolve ${missing.join(', ')}: ${found}`);
  else if (!LAUNCHED.some((set) => JSON.stringify(Object.entries(set).sort()) === JSON.stringify(Object.entries(actual).sort())))
    out.push(
      `${found} is not a set that launched. expo, expo-modules-* and react-native move together: expo-modules-core 58.1.0 on react-native 0.88.0 died at launch with "Symbol not found: _OBJC_CLASS_$_RCTStatusBarAppearance" (#5522). Change them as one set and add it to LAUNCHED only after a Release build of it launched.`,
    );
  for (const file of patches) {
    const m = /^(.+)\+(\d[^+]*)\.patch$/.exec(file);
    if (!m) {
      out.push(`${file}: a patch is named <package>+<version>.patch`);
      continue;
    }
    const target = patched(m[1]);
    const versions = Object.values(resolved(lock, target));
    if (!versions.includes(m[2]))
      out.push(
        `${file}: the lock resolves ${target} at ${versions.join(', ') || 'nothing'}, so patch-package would skip or fail this patch; rename it with the package`,
      );
  }
  return out;
}

test('I: the phone lock holds a set of the expo runtime core that launched, and its patches match the lock', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'mobile/package-lock.json'), 'utf8')).packages as Lock;
  const patches = fs.readdirSync(path.join(ROOT, 'mobile/patches')).filter((f) => f.endsWith('.patch'));
  assert.ok(patches.length >= 2, 'the patches were found');
  assert.deepEqual(problems(lock, patches), []);
});

test('I: the check names a mixed set, a sibling that moved and a patch left behind by a bump', () => {
  const [launched] = LAUNCHED;
  const lockOf = (set: CoreSet): Lock =>
    Object.fromEntries(Object.entries(set).map(([key, version]) => [`node_modules/${key}`, { version }]));
  assert.deepEqual(problems(lockOf(launched), ['expo++expo-modules-core+58.0.28.patch']), []);
  // main after 756745389: the core moved and the patch was renamed with it
  const fromMain = lockOf({ ...launched, expo: '58.0.26', 'expo/node_modules/expo-modules-core': '58.1.0' });
  const sentences = problems(fromMain, ['expo++expo-modules-core+58.0.28.patch']);
  assert.equal(sentences.length, 2);
  assert.match(sentences[0], /RCTStatusBarAppearance.*#5522/);
  assert.match(sentences[1], /resolves expo\/node_modules\/expo-modules-core at 58\.1\.0/);
  // a sibling of the core on its own is not the launched set either
  assert.match(problems(lockOf({ ...launched, 'expo-modules-jsi': '58.0.23' }), [])[0], /not a set that launched/);
  // a package the lock does not resolve, and a patch that is not named <package>+<version>
  const withoutRn = { ...launched };
  delete withoutRn['react-native'];
  assert.match(problems(lockOf(withoutRn), [])[0], /must resolve react-native/);
  assert.match(problems(lockOf(launched), ['notes.patch'])[0], /named <package>\+<version>\.patch/);
  // a scoped package is named `@scope+name` by patch-package
  const scoped: Lock = { ...lockOf(launched), 'node_modules/@scope/pkg': { version: '1.2.3' } };
  assert.deepEqual(problems(scoped, ['@scope+pkg+1.2.3.patch']), []);
  assert.match(problems(scoped, ['@scope+pkg+1.2.4.patch'])[0], /resolves @scope\/pkg at 1\.2\.3/);
});
